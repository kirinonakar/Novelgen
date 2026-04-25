use super::memory::{
    apply_chapter_memory_update, build_expression_cooldown_from_chapters, close_due_planned_arcs,
    ensure_current_arc_has_signal, format_expression_cooldown, latest_closed_arc_before_current,
    reconstruction_summary_pause, sanitize_closed_arc_memory, save_generation_state_to_disk,
    select_relevant_closed_arc, should_reconstruct_context, summarize_chapter_with_templates,
    CONTINUITY_FALLBACK_WARNING_THRESHOLD,
};
use super::text::{
    clean_thought_tags, split_full_text_into_chapters, split_plot_into_chapters,
    tail_with_paragraph_boundary,
};
use super::types::{NovelGenerationParams, NovelMetadata, StreamEvent};
use crate::continuity_json::sanitize_keywords;
use crate::paths::get_base_dir;
use crate::plot_structure::{extract_novel_title, split_plot_into_arc_boundaries};
use crate::prompt_templates::{render_template, PromptTemplates};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::{sleep, timeout};

const DIRECT_PRECEDING_TAIL_CHARS: usize = 1200;

pub async fn generate_novel_stream(
    params: NovelGenerationParams,
    on_event: tauri::ipc::Channel<StreamEvent>,
    stop_flag: Arc<AtomicBool>,
) -> Result<String, String> {
    let prompt_templates = PromptTemplates::load(params.prompt_templates.as_ref());
    let client = Client::builder().build().unwrap();
    let url = format!("{}/chat/completions", params.api_base.trim_end_matches('/'));

    let mut full_text = if params.start_chapter == 1 {
        String::new()
    } else {
        params.initial_text.clone()
    };
    let chapter_plots = split_plot_into_chapters(&params.plot_outline);
    let plot_arc_boundaries = split_plot_into_arc_boundaries(&params.plot_outline);

    // Ensure we have a filename
    let novel_filename = params
        .novel_filename
        .unwrap_or_else(get_next_novel_filename);

    // 1. Initial State / Reconstruction
    let mut meta = NovelMetadata::new(&params.language, params.total_chapters, &params.plot_seed);
    meta.target_tokens = params.target_tokens;
    if let Some(title) = extract_novel_title(&params.plot_outline) {
        meta.title = title;
    }
    meta.plot_outline = params.plot_outline.clone();

    // Only use provided memory if we are resuming (start_chapter > 1)
    if params.start_chapter > 1 {
        if let Some(recent) = params.recent_chapters {
            meta.recent_chapters = recent;
        }
        if let Some(state) = params.story_state {
            meta.story_state = state;
        }
        if let Some(characters) = params.character_state {
            meta.character_state = characters;
        }
        if let Some(arc) = params.current_arc {
            meta.current_arc = arc;
        }
        if let Some(keywords) = params.current_arc_keywords {
            meta.current_arc_keywords = sanitize_keywords(&keywords);
        }
        if let Some(start) = params.current_arc_start_chapter {
            meta.current_arc_start_chapter = start.max(1);
        }
        if let Some(arcs) = params.closed_arcs {
            meta.closed_arcs = arcs.into_iter().map(sanitize_closed_arc_memory).collect();
        }
        if let Some(cooldown) = params.expression_cooldown {
            meta.expression_cooldown = cooldown;
        }
        if let Some(needs_rebuild) = params.needs_memory_rebuild {
            meta.needs_memory_rebuild = needs_rebuild;
        }
        if let Some(fallback_count) = params.continuity_fallback_count {
            meta.continuity_fallback_count = fallback_count;
            if fallback_count >= CONTINUITY_FALLBACK_WARNING_THRESHOLD {
                meta.needs_memory_rebuild = true;
            }
        }
    }

    let needs_reconstruction = should_reconstruct_context(&meta, params.start_chapter);

    if needs_reconstruction {
        let _ = on_event.send(StreamEvent::full(
            full_text.clone(),
            false,
            None,
            Some("🔄 Reconstructing context...".to_string()),
        ));

        let chapters_map = split_full_text_into_chapters(&full_text, &params.language);
        let rebuild_target = params.start_chapter.saturating_sub(1);
        let rebuild_pause = reconstruction_summary_pause(&params.api_base);
        let mut reconstruction_used_continuity_fallback = false;
        for ch in 1..params.start_chapter {
            let _ = on_event.send(StreamEvent::full(
                full_text.clone(),
                false,
                None,
                Some(format!(
                    "🔄 Reconstructing context... ({}/{})",
                    ch, rebuild_target
                )),
            ));

            let content = chapters_map.get(&ch).cloned().unwrap_or_default();
            if content.trim().is_empty() {
                stop_flag.store(true, Ordering::Relaxed);
                let _ = on_event.send(StreamEvent::full(
                    full_text.clone(),
                    true,
                    Some(format!(
                        "Context reconstruction failed: Chapter {} content is missing. Manual intervention is required before resuming.",
                        ch
                    )),
                    None,
                ));
                return Ok(full_text);
            }

            let summary = match summarize_chapter_with_templates(
                &params.api_base,
                &params.model_name,
                &params.api_key,
                &content,
                &params.language,
                params.target_tokens,
                &prompt_templates,
            )
            .await
            {
                Ok(summary) => summary,
                Err(err) => {
                    meta.needs_memory_rebuild = true;
                    let save_error =
                        save_generation_state_to_disk(&meta, &novel_filename, &full_text).err();
                    if let Some(save_err) = &save_error {
                        eprintln!(
                            "[Backend] Failed to save reconstruction state: {}",
                            save_err
                        );
                    }
                    stop_flag.store(true, Ordering::Relaxed);
                    let _ = on_event.send(StreamEvent::full(
                        full_text.clone(),
                        true,
                        Some(format!(
                            "Context reconstruction failed while summarizing Chapter {}: {} Manual intervention is required before resuming.{}",
                            ch,
                            err,
                            save_error
                                .as_ref()
                                .map(|msg| format!(" Also failed to save recovery state: {}", msg))
                                .unwrap_or_default()
                        )),
                        None,
                    ));
                    return Ok(full_text);
                }
            };

            let continuity_fallback_used = apply_chapter_memory_update(
                &mut meta,
                ch,
                summary,
                params.total_chapters,
                &plot_arc_boundaries,
                &params.api_base,
                &params.model_name,
                &params.api_key,
                &params.language,
                &prompt_templates,
            )
            .await;
            reconstruction_used_continuity_fallback |= continuity_fallback_used;
            if continuity_fallback_used {
                let warning = if meta.continuity_fallback_count
                    >= CONTINUITY_FALLBACK_WARNING_THRESHOLD
                {
                    format!(
                        "⚠️ Continuity JSON fallback used while reconstructing Chapter {} ({} consecutive fallbacks). Metadata is marked for rebuild on next resume.",
                        ch,
                        meta.continuity_fallback_count
                    )
                } else {
                    format!(
                        "⚠️ Continuity JSON fallback used while reconstructing Chapter {} ({}/{} consecutive). Continuing with saved memory.",
                        ch,
                        meta.continuity_fallback_count,
                        CONTINUITY_FALLBACK_WARNING_THRESHOLD
                    )
                };
                let _ = on_event.send(StreamEvent::full(
                    full_text.clone(),
                    false,
                    None,
                    Some(warning),
                ));
            }
            meta.current_chapter = ch;

            if ch < params.start_chapter - 1 {
                sleep(rebuild_pause).await;
            }
        }
        if reconstruction_used_continuity_fallback {
            meta.needs_memory_rebuild =
                meta.continuity_fallback_count >= CONTINUITY_FALLBACK_WARNING_THRESHOLD;
        } else {
            meta.needs_memory_rebuild = false;
            meta.continuity_fallback_count = 0;
        }
    }

    if params.start_chapter > 1 {
        meta.current_chapter = params.start_chapter - 1;
        close_due_planned_arcs(
            &mut meta,
            &plot_arc_boundaries,
            params.start_chapter - 1,
            params.total_chapters,
            "",
            &[],
            None,
            false,
        );
    }

    ensure_current_arc_has_signal(
        &mut meta,
        &plot_arc_boundaries,
        params.start_chapter,
        params.total_chapters,
        chapter_plots
            .get(&params.start_chapter)
            .map(|plot| plot.as_str()),
        &[],
    );

    let mut current_chapters = if params.start_chapter > 1 {
        split_full_text_into_chapters(&full_text, &params.language)
    } else {
        HashMap::new()
    };

    // 2. Generation Loop
    for ch in params.start_chapter..=params.total_chapters {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        ensure_current_arc_has_signal(
            &mut meta,
            &plot_arc_boundaries,
            ch,
            params.total_chapters,
            chapter_plots.get(&ch).map(|plot| plot.as_str()),
            &[],
        );

        // Save state at the start of chapter to handle rollback on stop
        let chapter_start_backup = full_text.clone();

        let _ = on_event.send(StreamEvent::full(
            full_text.clone(),
            false,
            None,
            Some(format!("Writing...({}/{})", ch, params.total_chapters)),
        ));

        meta.expression_cooldown = build_expression_cooldown_from_chapters(
            &full_text,
            &current_chapters,
            &params.language,
            &prompt_templates,
        );

        let active_arc_start = meta.current_arc_start_chapter.max(1);
        let current_chapter_plot_section = chapter_plots
            .get(&ch)
            .map(|plot| format!("- Current Chapter Plot: {}\n", plot))
            .unwrap_or_default();

        let expression_cooldown = format_expression_cooldown(&meta.expression_cooldown);
        let expression_cooldown_section = if expression_cooldown.trim().is_empty() {
            String::new()
        } else {
            render_template(
                &prompt_templates.expression_cooldown,
                &[("expression_cooldown", expression_cooldown)],
            )
        };

        let previous_closed_arc =
            latest_closed_arc_before_current(&meta.closed_arcs, active_arc_start);
        let relevant_closed_arc = select_relevant_closed_arc(
            &meta.closed_arcs,
            chapter_plots.get(&ch),
            &meta.current_arc,
            &meta.current_arc_keywords,
            active_arc_start,
        );

        let previous_closed_arc_section = if let Some(previous_arc) = &previous_closed_arc {
            format!(
                "[Previous Closed Arc (Chapters {} to {}): Immediate transition bridge]\n{}\n\n",
                previous_arc.start_chapter,
                previous_arc.end_chapter,
                previous_arc.summary.trim()
            )
        } else {
            String::new()
        };

        let relevant_closed_arc_section = if let Some(relevant_arc) =
            relevant_closed_arc.filter(|arc| {
                previous_closed_arc.as_ref().map_or(true, |previous_arc| {
                    previous_arc.start_chapter != arc.start_chapter
                        || previous_arc.end_chapter != arc.end_chapter
                })
            }) {
            format!(
                "[Relevant Closed Arc (Chapters {} to {}): Past background reference only]\n{}\n\n",
                relevant_arc.start_chapter,
                relevant_arc.end_chapter,
                relevant_arc.summary.trim()
            )
        } else {
            String::new()
        };

        let mut recent_chapter_summaries_section = String::new();
        if !meta.recent_chapters.is_empty() {
            recent_chapter_summaries_section
                .push_str("[Recent Chapter Summaries: Immediate continuity bridge]\n");
            for entry in &meta.recent_chapters {
                if !entry.summary.trim().is_empty() {
                    recent_chapter_summaries_section.push_str(&format!(
                        "Chapter {}:\n{}\n\n",
                        entry.chapter,
                        entry.summary.trim()
                    ));
                }
            }
        }

        let directly_preceding_content_section = if ch > 1 {
            let last_ch = ch - 1;
            if let Some(prev_text) = current_chapters.get(&last_ch) {
                let tail = tail_with_paragraph_boundary(prev_text, DIRECT_PRECEDING_TAIL_CHARS);
                format!(
                    "[Directly Preceding Content (End of Chapter {})]\n\"{}\"\n",
                    last_ch, tail
                )
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        let prompt = render_template(
            &prompt_templates.novel_chapter,
            &[
                ("language", params.language.clone()),
                ("total_chapters", params.total_chapters.to_string()),
                ("plot_outline", params.plot_outline.clone()),
                ("chapter", ch.to_string()),
                ("target_tokens", params.target_tokens.to_string()),
                ("current_chapter_plot_section", current_chapter_plot_section),
                ("expression_cooldown_section", expression_cooldown_section),
                (
                    "story_state",
                    if meta.story_state.trim().is_empty() {
                        "None yet.".to_string()
                    } else {
                        meta.story_state.trim().to_string()
                    },
                ),
                (
                    "character_state",
                    if meta.character_state.trim().is_empty() {
                        "None yet.".to_string()
                    } else {
                        meta.character_state.trim().to_string()
                    },
                ),
                ("current_arc_start_chapter", active_arc_start.to_string()),
                (
                    "current_arc",
                    if meta.current_arc.trim().is_empty() {
                        "None yet. Establish the new arc from the chapter plot, recent chapters, and story state.".to_string()
                    } else {
                        meta.current_arc.trim().to_string()
                    },
                ),
                ("previous_closed_arc_section", previous_closed_arc_section),
                ("relevant_closed_arc_section", relevant_closed_arc_section),
                (
                    "recent_chapter_summaries_section",
                    recent_chapter_summaries_section,
                ),
                (
                    "directly_preceding_content_section",
                    directly_preceding_content_section,
                ),
            ],
        );

        // Title Header
        let ch_title = match params.language.as_str() {
            "Korean" => format!("\n\n# 제 {}장\n\n", ch),
            "Japanese" => format!("\n\n# 第 {} 章\n\n", ch),
            _ => format!("\n\n# Chapter {}\n\n", ch),
        };

        full_text.push_str(&ch_title);

        // Check stop flag before starting the API request
        if stop_flag.load(Ordering::Relaxed) {
            full_text = chapter_start_backup;
            break;
        }

        let _ = on_event.send(StreamEvent::full(
            full_text.clone(),
            false,
            None,
            Some(format!("Writing...({}/{})", ch, params.total_chapters)),
        ));

        // STREAM CHAPTER
        let mut body_map = serde_json::Map::new();
        body_map.insert("model".to_string(), json!(params.model_name));
        body_map.insert(
            "messages".to_string(),
            json!([
                {"role": "system", "content": params.system_prompt},
                {"role": "user", "content": prompt}
            ]),
        );
        body_map.insert("temperature".to_string(), json!(params.temperature));
        body_map.insert("top_p".to_string(), json!(params.top_p));
        body_map.insert("max_tokens".to_string(), json!(params.target_tokens + 1000));
        body_map.insert("stream".to_string(), json!(true));

        if !params.api_base.contains("googleapis.com") {
            body_map.insert(
                "repetition_penalty".to_string(),
                json!(params.repetition_penalty),
            );
        }

        let request_body = Value::Object(body_map);

        let res = client
            .post(&url)
            .bearer_auth(&params.api_key)
            .json(&request_body)
            .send()
            .await;

        match res {
            Ok(response) => {
                let status = response.status();
                if !status.is_success() {
                    let err_json: Value = response.json().await.unwrap_or(json!({}));
                    let err_msg = err_json["error"]["message"]
                        .as_str()
                        .or(err_json["message"].as_str())
                        .unwrap_or_else(|| "Unknown API error (Check API key or parameters)");

                    // Rollback on error
                    full_text = chapter_start_backup;

                    let _ = on_event.send(StreamEvent::full(
                        full_text.clone(),
                        true,
                        Some(format!(
                            "API Error in Chapter {} ({}): {}",
                            ch, status, err_msg
                        )),
                        None,
                    ));
                    return Ok(full_text);
                }

                let mut stream = response.bytes_stream().eventsource();
                let mut chapter_text = String::new();
                let mut count = 0;
                let read_timeout_duration = Duration::from_secs(180);

                loop {
                    if stop_flag.load(Ordering::Relaxed) {
                        break;
                    }
                    match timeout(read_timeout_duration, stream.next()).await {
                        Ok(Some(Ok(evt))) => {
                            let data = evt.data;
                            if data == "[DONE]" {
                                break;
                            }
                            if let Ok(json) = serde_json::from_str::<Value>(&data) {
                                if let Some(content) =
                                    json["choices"][0]["delta"]["content"].as_str()
                                {
                                    chapter_text.push_str(content);
                                    count += 1;
                                    if count % 5 == 0 {
                                        let _ = on_event.send(StreamEvent::chapter_preview(
                                            clean_thought_tags(&chapter_text),
                                            format!("Writing...({}/{})", ch, params.total_chapters),
                                        ));
                                    }
                                }
                            }
                        }
                        Ok(None) => break,
                        Ok(Some(Err(e))) => {
                            // Rollback on stream error
                            full_text = chapter_start_backup;
                            let _ = on_event.send(StreamEvent::full(
                                full_text.clone(),
                                true,
                                Some(format!("Stream error in Chapter {}: {}", ch, e)),
                                None,
                            ));
                            return Ok(full_text);
                        }
                        Err(_) => {
                            // Read Timeout
                            full_text = chapter_start_backup;
                            let _ = on_event.send(StreamEvent::full(
                                full_text.clone(),
                                true,
                                Some(format!("Read Timeout: Server did not respond for 3 minutes during Chapter {}.", ch)),
                                None,
                            ));
                            return Ok(full_text);
                        }
                    }
                }

                // If stopped during stream, rollback full_text
                if stop_flag.load(Ordering::Relaxed) {
                    full_text = chapter_start_backup;
                    break;
                }

                let cleaned_chapter = clean_thought_tags(&chapter_text);

                // Detect empty response (often happens with Google/Gemini due to safety blocks)
                if cleaned_chapter.trim().is_empty() && !stop_flag.load(Ordering::Relaxed) {
                    full_text = chapter_start_backup; // Rollback
                    let _ = on_event.send(StreamEvent::full(
                        full_text.clone(),
                        true,
                        Some(format!("Empty response in Chapter {}. The model may have blocked the content due to safety filters or a connection issue.", ch)),
                        None,
                    ));
                    return Ok(full_text);
                }

                full_text.push_str(&cleaned_chapter);
                full_text.push('\n');
                current_chapters.insert(ch, cleaned_chapter.clone());

                // 3. Post-Chapter Processing
                if ch < params.total_chapters && !stop_flag.load(Ordering::Relaxed) {
                    // 🌟 요약 시작 전 UI 업데이트 이벤트 발송
                    let _ = on_event.send(StreamEvent::full(
                        full_text.clone(),
                        false,
                        None,
                        Some(format!("Summarizing Chapter {}...", ch)),
                    ));

                    let summary = match summarize_chapter_with_templates(
                        &params.api_base,
                        &params.model_name,
                        &params.api_key,
                        &cleaned_chapter,
                        &params.language,
                        params.target_tokens,
                        &prompt_templates,
                    )
                    .await
                    {
                        Ok(summary) => summary,
                        Err(err) => {
                            meta.current_chapter = ch;
                            meta.needs_memory_rebuild = true;
                            let save_error =
                                save_generation_state_to_disk(&meta, &novel_filename, &full_text)
                                    .err();
                            if let Some(save_err) = &save_error {
                                eprintln!(
                                    "[Backend] Failed to save paused generation state: {}",
                                    save_err
                                );
                            }
                            stop_flag.store(true, Ordering::Relaxed);
                            let _ = on_event.send(StreamEvent::full(
                                full_text.clone(),
                                true,
                                Some(format!(
                                    "Chapter {} was written, but its summary generation failed: {} Generation is paused to prevent continuity corruption. Resume after manual review; continuity will be rebuilt from the written text.{}",
                                    ch,
                                    err,
                                    save_error
                                        .as_ref()
                                        .map(|msg| format!(" Also failed to save recovery state: {}", msg))
                                        .unwrap_or_default()
                                )),
                                None,
                            ));
                            return Ok(full_text);
                        }
                    };

                    let continuity_fallback_used = apply_chapter_memory_update(
                        &mut meta,
                        ch,
                        summary,
                        params.total_chapters,
                        &plot_arc_boundaries,
                        &params.api_base,
                        &params.model_name,
                        &params.api_key,
                        &params.language,
                        &prompt_templates,
                    )
                    .await;
                    if continuity_fallback_used {
                        let warning = if meta.continuity_fallback_count
                            >= CONTINUITY_FALLBACK_WARNING_THRESHOLD
                        {
                            format!(
                                "⚠️ Continuity JSON fallback has been used {} consecutive times. Metadata is marked for rebuild; consider resuming after this run pauses or finishes.",
                                meta.continuity_fallback_count
                            )
                        } else {
                            format!(
                                "⚠️ Continuity JSON fallback used for Chapter {} ({}/{} consecutive). Continuing with saved recent summary.",
                                ch,
                                meta.continuity_fallback_count,
                                CONTINUITY_FALLBACK_WARNING_THRESHOLD
                            )
                        };
                        let _ = on_event.send(StreamEvent::full(
                            full_text.clone(),
                            false,
                            None,
                            Some(warning),
                        ));
                    }
                }
                meta.current_chapter = ch;
                meta.expression_cooldown = build_expression_cooldown_from_chapters(
                    &full_text,
                    &current_chapters,
                    &params.language,
                    &prompt_templates,
                );

                // Final chapter state to frontend
                let _ = on_event.send(StreamEvent::full(
                    full_text.clone(),
                    false,
                    None,
                    Some(format!("Writing...({}/{})", ch, params.total_chapters)),
                ));

                // 4. Save State to Disk
                if let Err(save_err) =
                    save_generation_state_to_disk(&meta, &novel_filename, &full_text)
                {
                    eprintln!("[Backend] Failed to save generation state: {}", save_err);
                    let _ = on_event.send(StreamEvent::full(
                        full_text.clone(),
                        false,
                        None,
                        Some(format!(
                            "⚠️ Warning: Failed to save progress to disk. {}",
                            save_err
                        )),
                    ));
                }
            }
            Err(e) => {
                let mut error_msg = e.to_string();
                if error_msg.contains("Failed to parse input at pos 0") {
                    error_msg.push_str("\n\n💡 [Hint] Model mismatch detected. Ensure LM Studio chat template is correctly set for models like Gemma 4.");
                }

                // Rollback on connection error
                full_text = chapter_start_backup;

                let _ = on_event.send(StreamEvent::full(
                    full_text.clone(),
                    true,
                    Some(format!("API error in Chapter {}: {}", ch, error_msg)),
                    None,
                ));
                return Ok(full_text);
            }
        }
    }

    let _ = on_event.send(StreamEvent::full(
        full_text.clone(),
        true,
        None,
        Some("✅ Done".to_string()),
    ));

    Ok(full_text)
}

pub async fn generate_plot_stream(
    api_base: &str,
    model_name: &str,
    api_key: &str,
    system_prompt: &str,
    prompt: &str,
    temperature: f32,
    top_p: f32,
    repetition_penalty: f32,
    max_tokens: u32,
    on_event: tauri::ipc::Channel<StreamEvent>,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let client = Client::builder().build().unwrap();
    let url = format!("{}/chat/completions", api_base.trim_end_matches('/'));

    let mut body_map = serde_json::Map::new();
    body_map.insert("model".to_string(), json!(model_name));
    body_map.insert(
        "messages".to_string(),
        json!([
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ]),
    );
    body_map.insert("temperature".to_string(), json!(temperature));
    body_map.insert("top_p".to_string(), json!(top_p));
    body_map.insert("max_tokens".to_string(), json!(max_tokens));
    body_map.insert("stream".to_string(), json!(true));

    if !api_base.contains("googleapis.com") {
        body_map.insert("repetition_penalty".to_string(), json!(repetition_penalty));
    }

    let request_body = Value::Object(body_map);

    let res = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    if !status.is_success() {
        let err_json: Value = res.json().await.unwrap_or(json!({}));
        let err_msg = err_json["error"]["message"]
            .as_str()
            .or(err_json["message"].as_str())
            .unwrap_or("Unknown API error");
        return Err(format!("API Error ({}): {}", status, err_msg));
    }

    let mut stream = res.bytes_stream().eventsource();
    let mut full_text = String::new();
    let mut count = 0;
    let read_timeout_duration = Duration::from_secs(180);

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        match timeout(read_timeout_duration, stream.next()).await {
            Ok(Some(Ok(evt))) => {
                let data = evt.data;
                if data == "[DONE]" {
                    break;
                }

                if let Ok(json) = serde_json::from_str::<Value>(&data) {
                    if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                        full_text.push_str(content);
                        count += 1;
                        if count % 5 == 0 {
                            let _ = on_event.send(StreamEvent::full(
                                clean_thought_tags(&full_text),
                                false,
                                None,
                                None,
                            ));
                        }
                    }
                }
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => {
                let mut error_msg = e.to_string();
                if error_msg.contains("Failed to parse input at pos 0") {
                    error_msg.push_str("\n\n💡 [Hint] Model mismatch detected. Ensure LM Studio chat template is correctly set for models like Gemma 4.");
                }

                let _ = on_event.send(StreamEvent::full(
                    clean_thought_tags(&full_text),
                    true,
                    Some(error_msg),
                    None,
                ));
                return Ok(());
            }
            Err(_) => {
                let _ = on_event.send(StreamEvent::full(
                    clean_thought_tags(&full_text),
                    true,
                    Some("Read Timeout: Server did not respond for 3 minutes during plot generation.".to_string()),
                    None,
                ));
                return Ok(());
            }
        }
    }

    let _ = on_event.send(StreamEvent::full(
        clean_thought_tags(&full_text),
        true,
        None,
        None,
    ));

    Ok(())
}

pub fn suggest_next_chapter(text: &str, lang: &str, last_completed_ch: Option<u32>) -> u32 {
    if let Some(ch) = last_completed_ch {
        return ch + 1;
    }

    // Fallback: Detect highest chapter from text content
    let chapters = split_full_text_into_chapters(text, lang);
    let max_ch = chapters.keys().max().cloned().unwrap_or(0);
    max_ch + 1
}

pub fn get_next_novel_filename() -> String {
    let base = get_base_dir();
    let mut dir = base.clone();
    dir.push("output");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }

    let now = chrono::Local::now();
    let date_str = now.format("%Y%m%d").to_string();
    let prefix = format!("novel_{}_", date_str);

    let mut max_num = 0;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with(&prefix) && name.ends_with(".txt") {
                    let seq_part = &name[prefix.len()..name.len() - 4];
                    if let Ok(num) = seq_part.parse::<u32>() {
                        if num > max_num {
                            max_num = num;
                        }
                    }
                }
            }
        }
    }
    format!("{}{:04}.txt", prefix, max_num + 1)
}
