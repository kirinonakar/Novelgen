use super::memory::{
    apply_chapter_memory_update, build_expression_cooldown_from_chapters, close_due_planned_arcs,
    ensure_current_arc_has_signal, format_expression_cooldown, format_recent_beat_cooldown,
    format_scene_pattern_cooldown, latest_closed_arc_before_current, reconstruction_summary_pause,
    sanitize_closed_arc_memory, save_generation_state_to_disk, select_relevant_closed_arc,
    should_reconstruct_context, summarize_chapter_with_templates,
    CONTINUITY_FALLBACK_WARNING_THRESHOLD,
};
use super::text::{
    clean_thought_tags, split_full_text_into_chapters, split_plot_into_chapters,
    tail_with_paragraph_boundary,
};
use super::types::{NovelGenerationParams, NovelGenerationResult, NovelMetadata, StreamEvent};
use crate::continuity_json::sanitize_keywords;
use crate::paths::{get_base_dir, validate_novel_filename};
use crate::plot_structure::{
    extract_novel_title, format_part_heading_label, split_plot_into_arc_boundaries, PlotArcBoundary,
};
use crate::prompt_templates::{render_template, PromptTemplates};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use regex::Regex;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::time::{sleep, timeout};

const DIRECT_PRECEDING_TAIL_CHARS: usize = 1200;
const STREAM_READ_TIMEOUT_SECS: u64 = 300;
const FOCUSED_PLOT_CONTEXT_MIN_CHAPTERS: u32 = 13;

static RE_FOCUSED_PART_HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?im)(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:\*\*)?\[?\s*(?:(?:제\s*)?[0-9０-９]+\s*부|第\s*[0-9０-９一二三四五六七八九十百]+\s*部|part\s*(?:[0-9０-９]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))(?:\s*[:：\-–—].*)?\s*(?:\]|\*\*)?\s*$",
    )
    .unwrap()
});

fn format_plot_chapter_heading(language: &str, chapter: u32) -> String {
    match language {
        "Korean" => format!("제 {}장", chapter),
        "Japanese" => format!("第 {} 章", chapter),
        _ => format!("Chapter {}", chapter),
    }
}

fn plot_part_heading(boundary: &PlotArcBoundary, language: &str, ordinal: usize) -> String {
    let fallback = format_part_heading_label(language, ordinal as u32);
    let label = boundary
        .label
        .as_deref()
        .filter(|item| !item.trim().is_empty())
        .unwrap_or(&fallback);
    let name = boundary.name.trim();

    if name.is_empty() || name.eq_ignore_ascii_case(label.trim()) || name == "Part" {
        label.trim().to_string()
    } else {
        format!("{}: {}", label.trim(), name)
    }
}

fn compact_title_label(language: &str) -> &'static str {
    match language {
        "Korean" => "제목",
        "Japanese" => "タイトル",
        _ => "Title",
    }
}

fn compact_content_label(language: &str) -> &'static str {
    match language {
        "Korean" => "내용",
        "Japanese" => "内容",
        _ => "Content",
    }
}

fn clean_outline_line(line: &str) -> String {
    line.trim()
        .trim_start_matches(|ch: char| {
            matches!(
                ch,
                '#' | '-'
                    | '*'
                    | '+'
                    | '>'
                    | '['
                    | ']'
                    | ':'
                    | '：'
                    | '.'
                    | ')'
                    | '、'
                    | ' '
                    | '\t'
            )
        })
        .trim_end_matches(|ch: char| matches!(ch, '*' | ']' | ' ' | '\t'))
        .trim()
        .to_string()
}

fn strip_label_value<'a>(line: &'a str, labels: &[&str]) -> Option<&'a str> {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();

    labels.iter().find_map(|label| {
        let label_lower = label.to_ascii_lowercase();
        if lower.starts_with(&label_lower) {
            let value = trimmed[label.len()..]
                .trim_start_matches(|ch: char| matches!(ch, ':' | '：' | '-' | ' ' | '\t'))
                .trim();
            Some(value)
        } else {
            None
        }
    })
}

fn title_value_from_line(line: &str) -> Option<String> {
    strip_label_value(
        line,
        &[
            "제목",
            "장 제목",
            "타이틀",
            "タイトル",
            "章タイトル",
            "Title",
            "Chapter Title",
        ],
    )
    .map(clean_outline_line)
    .filter(|item| !item.is_empty())
}

fn content_value_from_line(line: &str) -> Option<String> {
    strip_label_value(line, &["내용", "本文", "Content", "Synopsis"])
        .map(str::trim)
        .map(str::to_string)
}

fn is_content_label(line: &str) -> bool {
    content_value_from_line(line).is_some()
}

fn is_compact_stop_label(line: &str) -> bool {
    let cleaned = clean_outline_line(line);
    let lower = cleaned.to_ascii_lowercase();

    cleaned.starts_with("핵심 포인트")
        || cleaned.starts_with("중요 포인트")
        || cleaned.starts_with("重要ポイント")
        || cleaned.starts_with("要点")
        || lower.starts_with("key points")
        || lower.starts_with("chapter_function")
        || lower.starts_with("primary_function")
        || lower.starts_with("secondary_function")
        || lower.starts_with("start_scene")
        || lower.starts_with("end_state")
        || lower.starts_with("end_hook")
        || lower.starts_with("must_include")
        || lower.starts_with("must_not_include")
        || lower.starts_with("not_this_chapter")
        || lower.starts_with("chapter_keywords")
        || lower.starts_with("reveal_or_knowledge_step")
        || lower.starts_with("external_threat")
        || lower.starts_with("relationship_drama")
        || lower.starts_with("mystery")
        || lower.starts_with("combat")
        || lower.starts_with("comedy")
        || lower.starts_with("intensity")
}

fn compact_title_from_content_text(text: &str) -> Option<String> {
    let cleaned = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch: char| {
            matches!(
                ch,
                '"' | '\'' | '“' | '”' | '‘' | '’' | '「' | '」' | '『' | '』' | ' ' | '\t'
            )
        })
        .trim()
        .to_string();

    if cleaned.is_empty() {
        return None;
    }

    let mut title = String::new();
    for ch in cleaned.chars() {
        if matches!(ch, '.' | '!' | '?' | '。' | '！' | '？' | '\n' | '\r') {
            break;
        }
        title.push(ch);
        if title.chars().count() >= 44 {
            break;
        }
    }

    let title = title.trim().to_string();
    if title.is_empty() {
        None
    } else if cleaned.chars().count() > title.chars().count() {
        Some(format!("{}...", title.trim_end()))
    } else {
        Some(title)
    }
}

fn infer_chapter_title(lines: &[String]) -> String {
    for line in lines {
        if let Some(title) = title_value_from_line(line) {
            return title;
        }
    }

    if let Some(title) = lines
        .iter()
        .map(|line| clean_outline_line(line))
        .find(|line| {
            !line.is_empty()
                && !is_content_label(line)
                && !is_compact_stop_label(line)
                && line.chars().count() <= 120
        })
    {
        return title;
    }

    for line in lines {
        if let Some(content) = content_value_from_line(line) {
            if let Some(title) = compact_title_from_content_text(&content) {
                return title;
            }
        }
    }

    "Untitled".to_string()
}

fn compact_chapter_plot(chapter_body: &str, language: &str) -> String {
    let lines = chapter_body
        .lines()
        .map(clean_outline_line)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let title = infer_chapter_title(&lines);
    let mut content_lines = Vec::new();

    if let Some(content_index) = lines.iter().position(|line| is_content_label(line)) {
        if let Some(value) = content_value_from_line(&lines[content_index]) {
            if !value.trim().is_empty() {
                content_lines.push(value.trim().to_string());
            }
        }
        for line in lines.iter().skip(content_index + 1) {
            if is_compact_stop_label(line) {
                break;
            }
            content_lines.push(line.to_string());
        }
    } else {
        for line in &lines {
            if is_compact_stop_label(line) {
                break;
            }
            if title_value_from_line(line).is_some() || clean_outline_line(line) == title {
                continue;
            }
            content_lines.push(line.to_string());
        }
    }

    let content = content_lines.join("\n").trim().to_string();
    format!(
        "{}: {}\n{}:\n{}",
        compact_title_label(language),
        title,
        compact_content_label(language),
        if content.is_empty() {
            chapter_body.trim()
        } else {
            content.as_str()
        }
    )
}

fn first_part_heading_start(plot_outline: &str) -> Option<usize> {
    RE_FOCUSED_PART_HEADING
        .find_iter(plot_outline)
        .map(|item| item.start())
        .next()
}

fn setup_sections_before_first_part(plot_outline: &str, boundaries: &[PlotArcBoundary]) -> String {
    let Some(first_boundary) = boundaries
        .iter()
        .min_by_key(|boundary| boundary.start_chapter)
    else {
        return plot_outline.trim().to_string();
    };

    first_part_heading_start(plot_outline)
        .map(|idx| plot_outline[..idx].trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| {
            let first_chapter = first_boundary.start_chapter;
            let marker = format_plot_chapter_heading("English", first_chapter);
            let localized_marker = format_plot_chapter_heading("Korean", first_chapter);
            let japanese_marker = format_plot_chapter_heading("Japanese", first_chapter);
            [marker, localized_marker, japanese_marker]
                .iter()
                .filter_map(|candidate| plot_outline.find(candidate))
                .min()
                .map(|idx| plot_outline[..idx].trim().to_string())
                .unwrap_or_default()
        })
}

fn focused_plot_outline_for_chapter(
    full_plot_outline: &str,
    chapter_plots: &HashMap<u32, String>,
    boundaries: &[PlotArcBoundary],
    chapter: u32,
    total_chapters: u32,
    language: &str,
) -> String {
    if total_chapters < FOCUSED_PLOT_CONTEXT_MIN_CHAPTERS || boundaries.is_empty() {
        return full_plot_outline.to_string();
    }

    let current_part_index = boundaries
        .iter()
        .position(|boundary| boundary.start_chapter <= chapter && chapter <= boundary.end_chapter)
        .unwrap_or(0);
    let setup_sections = setup_sections_before_first_part(full_plot_outline, boundaries);
    let mut sections = Vec::new();
    if !setup_sections.trim().is_empty() {
        sections.push(setup_sections);
    }

    sections.push(
        "[Focused Master Plot Outline]\nFor long outlines, the previous/current/next parts are shown in full. More distant chapters are reduced to title and content only."
            .to_string(),
    );

    for (idx, boundary) in boundaries.iter().enumerate() {
        let include_full_part = idx.abs_diff(current_part_index) <= 1;
        let mut part_lines = vec![plot_part_heading(boundary, language, idx + 1)];

        for chapter_number in boundary.start_chapter..=boundary.end_chapter {
            let Some(chapter_body) = chapter_plots.get(&chapter_number) else {
                continue;
            };

            part_lines.push(format_plot_chapter_heading(language, chapter_number));
            if include_full_part {
                part_lines.push(chapter_body.trim().to_string());
            } else {
                part_lines.push(compact_chapter_plot(chapter_body, language));
            }
        }

        sections.push(part_lines.join("\n"));
    }

    sections.join("\n\n").trim().to_string()
}

fn stream_finish_reason(json: &Value) -> Option<String> {
    json["choices"][0]["finish_reason"]
        .as_str()
        .or_else(|| json["choices"][0]["finishReason"].as_str())
        .map(|reason| reason.trim().to_string())
        .filter(|reason| !reason.is_empty())
}

fn is_successful_finish_reason(reason: &str) -> bool {
    matches!(
        reason.trim().to_ascii_lowercase().as_str(),
        "stop" | "end_turn"
    )
}

fn stream_completion_error(
    context: &str,
    saw_done_marker: bool,
    finish_reason: Option<&str>,
) -> Option<String> {
    if let Some(reason) = finish_reason {
        if is_successful_finish_reason(reason) {
            return None;
        }

        let normalized = reason.trim().to_ascii_lowercase();
        if normalized.contains("length") || normalized.contains("max_tokens") {
            return Some(format!(
                "{} was cut off because the model hit its output limit (finish_reason: {}). Retry before continuing, or reduce the chunk size / increase max_tokens.",
                context, reason
            ));
        }

        return Some(format!(
            "{} stopped before completion (finish_reason: {}). Retry before continuing.",
            context, reason
        ));
    }

    if !saw_done_marker {
        return Some(format!(
            "{} stream ended before the completion marker ([DONE]). The response may be incomplete; retry before continuing.",
            context
        ));
    }

    None
}

fn generation_result(
    full_text: String,
    novel_filename: &str,
    metadata: &NovelMetadata,
) -> NovelGenerationResult {
    NovelGenerationResult {
        full_text,
        novel_filename: novel_filename.to_string(),
        metadata: metadata.clone(),
        error: None,
    }
}

fn generation_error_result(
    full_text: String,
    novel_filename: &str,
    metadata: &NovelMetadata,
    error: String,
) -> NovelGenerationResult {
    NovelGenerationResult {
        full_text,
        novel_filename: novel_filename.to_string(),
        metadata: metadata.clone(),
        error: Some(error),
    }
}

pub async fn generate_novel_stream(
    params: NovelGenerationParams,
    on_event: tauri::ipc::Channel<StreamEvent>,
    stop_flag: Arc<AtomicBool>,
) -> Result<NovelGenerationResult, String> {
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
    let novel_filename = match params.novel_filename {
        Some(filename) => validate_novel_filename(&filename)?,
        None => get_next_novel_filename(),
    };

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
        if let Some(relationships) = params.relationship_state {
            meta.relationship_state = relationships;
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
        if let Some(patterns) = params.recent_scene_patterns {
            meta.recent_scene_patterns = patterns;
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
                let error_msg = format!(
                    "Context reconstruction failed: Chapter {} content is missing. Manual intervention is required before resuming.",
                    ch
                );
                let _ = on_event.send(StreamEvent::full(
                    full_text.clone(),
                    true,
                    Some(error_msg.clone()),
                    None,
                ));
                return Ok(generation_error_result(full_text, &novel_filename, &meta, error_msg));
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
                    let error_msg = format!(
                        "Context reconstruction failed while summarizing Chapter {}: {} Manual intervention is required before resuming.{}",
                        ch,
                        err,
                        save_error
                            .as_ref()
                            .map(|msg| format!(" Also failed to save recovery state: {}", msg))
                            .unwrap_or_default()
                    );
                    let _ = on_event.send(StreamEvent::full(
                        full_text.clone(),
                        true,
                        Some(error_msg.clone()),
                        None,
                    ));
                    return Ok(generation_error_result(full_text, &novel_filename, &meta, error_msg));
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
    let visible_part_headings = plot_arc_boundaries
        .iter()
        .filter(|boundary| !boundary.inferred)
        .enumerate()
        .map(|(idx, boundary)| (boundary.start_chapter, idx as u32 + 1))
        .collect::<Vec<_>>();

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
        let current_chapter_plot_text = chapter_plots
            .get(&ch)
            .map(|plot| plot.trim())
            .filter(|plot| !plot.is_empty());
        let current_chapter_plot_section = current_chapter_plot_text
            .map(|plot| format!("[Current Chapter Plot]\n{}\n", plot))
            .unwrap_or_default();
        let current_chapter_keywords = current_chapter_plot_text
            .map(|plot| sanitize_keywords(&[plot.to_string()]))
            .unwrap_or_default();
        let current_chapter_keywords_section = if current_chapter_keywords.is_empty() {
            String::new()
        } else {
            format!(
                "[Current Chapter Keywords: local focus for this chapter only]\n- {}\n",
                current_chapter_keywords.join("\n- ")
            )
        };

        let expression_cooldown = format_expression_cooldown(&meta.expression_cooldown);
        let expression_cooldown_section = if expression_cooldown.trim().is_empty() {
            String::new()
        } else {
            render_template(
                &prompt_templates.expression_cooldown,
                &[("expression_cooldown", expression_cooldown)],
            )
        };
        let recent_beat_cooldown = format_recent_beat_cooldown(&meta.recent_chapters);
        let scene_pattern_cooldown = format_scene_pattern_cooldown(&meta.recent_scene_patterns, ch);
        let recent_beat_cooldown_section = if recent_beat_cooldown.trim().is_empty()
            && scene_pattern_cooldown.trim().is_empty()
        {
            String::new()
        } else {
            let mut cooldown_lines = Vec::new();
            if !scene_pattern_cooldown.trim().is_empty() {
                cooldown_lines.push(scene_pattern_cooldown);
            }
            if !recent_beat_cooldown.trim().is_empty() {
                cooldown_lines.push(recent_beat_cooldown);
            }
            format!(
                "[Recent Scene Pattern Cooldown]\nThe recent scene structures and beats below were already used. Do not replay them unchanged; only echo one if this chapter transforms it with a new cause, consequence, reversal, or character decision. Respect any cooldown_until_chapter marker.\n{}\n",
                cooldown_lines.join("\n")
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

        let focused_plot_outline = focused_plot_outline_for_chapter(
            &params.plot_outline,
            &chapter_plots,
            &plot_arc_boundaries,
            ch,
            params.total_chapters,
            &params.language,
        );

        let prompt = render_template(
            &prompt_templates.novel_chapter,
            &[
                ("language", params.language.clone()),
                ("total_chapters", params.total_chapters.to_string()),
                ("plot_outline", focused_plot_outline),
                ("chapter", ch.to_string()),
                ("target_tokens", params.target_tokens.to_string()),
                ("current_chapter_plot_section", current_chapter_plot_section),
                (
                    "current_chapter_keywords_section",
                    current_chapter_keywords_section,
                ),
                ("expression_cooldown_section", expression_cooldown_section),
                ("recent_beat_cooldown_section", recent_beat_cooldown_section),
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
                (
                    "relationship_state",
                    if meta.relationship_state.trim().is_empty() {
                        "None yet.".to_string()
                    } else {
                        meta.relationship_state.trim().to_string()
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
        if ch == 1 && params.start_chapter == 1 {
            let title = meta.title.trim();
            if !title.is_empty() {
                full_text.push_str(&format!("\n\n# {}\n\n", title));
            } else {
                let default_title = match params.language.as_str() {
                    "Korean" => "# 제목",
                    "Japanese" => "# 題名",
                    _ => "# Title",
                };
                full_text.push_str(&format!("\n\n{}\n\n", default_title));
            }
        }

        if let Some((_, ordinal)) = visible_part_headings
            .iter()
            .find(|(start_chapter, _)| *start_chapter == ch)
        {
            let label = format_part_heading_label(&params.language, *ordinal);
            full_text.push_str(&format!("\n\n## {}\n\n", label));
        }

        let ch_title = match params.language.as_str() {
            "Korean" => format!("\n\n### 제 {}장\n\n", ch),
            "Japanese" => format!("\n\n### 第 {} 章\n\n", ch),
            _ => format!("\n\n### Chapter {}\n\n", ch),
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
        let mut temp = params.temperature;
        if params.model_name.to_ascii_lowercase().contains("kimi") {
            temp = 1.0;
        }
        body_map.insert("temperature".to_string(), json!(temp));
        body_map.insert("top_p".to_string(), json!(params.top_p));

        let mut final_max_tokens = params.target_tokens.saturating_add(12000).max(16384);
        if params.api_base.contains("googleapis.com") {
            final_max_tokens = final_max_tokens.min(8192);
        }
        body_map.insert("max_tokens".to_string(), json!(final_max_tokens));
        body_map.insert("stream".to_string(), json!(true));

        if !params.api_base.contains("googleapis.com")
            && !params.api_base.contains("opencode.ai")
            && !params.api_base.contains("cerebras.ai")
        {
            body_map.insert(
                "repetition_penalty".to_string(),
                json!(params.repetition_penalty),
            );
        }

        if params.api_base.contains("opencode.ai") && params.model_name.to_ascii_lowercase().contains("deepseek") {
            body_map.insert("thinking".to_string(), json!({ "type": "disabled" }));
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

                    let error_msg = format!(
                        "API Error in Chapter {} ({}): {}",
                        ch, status, err_msg
                    );
                    let _ = on_event.send(StreamEvent::full(
                        full_text.clone(),
                        true,
                        Some(error_msg.clone()),
                        None,
                    ));
                    return Ok(generation_error_result(full_text, &novel_filename, &meta, error_msg));
                }

                let mut stream = response.bytes_stream().eventsource();
                let mut chapter_text = String::new();
                let mut in_thinking = false;
                let mut thinking_tokens: u32 = 0;
                let mut count = 0;
                let read_timeout_duration = Duration::from_secs(STREAM_READ_TIMEOUT_SECS);
                let mut saw_done_marker = false;
                let mut terminal_finish_reason: Option<String> = None;

                loop {
                    if stop_flag.load(Ordering::Relaxed) {
                        break;
                    }
                    match timeout(read_timeout_duration, stream.next()).await {
                        Ok(Some(Ok(evt))) => {
                            let data = evt.data;
                            if data.trim() == "[DONE]" {
                                saw_done_marker = true;
                                break;
                            }
                            if let Ok(json) = serde_json::from_str::<Value>(&data) {
                                if let Some(reason) = stream_finish_reason(&json) {
                                    terminal_finish_reason = Some(reason);
                                }
                                let delta = &json["choices"][0]["delta"];
                                if let Some(reasoning) = delta["reasoning_content"].as_str() {
                                    if !in_thinking {
                                        chapter_text.push_str("<think>\n");
                                        in_thinking = true;
                                    }
                                    chapter_text.push_str(reasoning);
                                    thinking_tokens += 1;
                                    count += 1;
                                    if count % 5 == 0 {
                                        let _ = on_event.send(StreamEvent::chapter_preview(
                                            clean_thought_tags(&chapter_text),
                                            format!("💭 Thinking...({} tokens) Writing...({}/{})", thinking_tokens, ch, params.total_chapters),
                                        ));
                                    }
                                } else if let Some(content) = delta["content"].as_str() {
                                    if !content.is_empty() {
                                        // Detect inline <think> tags (Qwen3, GLM, etc.)
                                        if content.contains("<think>") && !in_thinking {
                                            in_thinking = true;
                                        }
                                        if in_thinking && content.contains("</think>") {
                                            in_thinking = false;
                                            // Immediately notify UI that thinking is done
                                            let _ = on_event.send(StreamEvent::chapter_preview(
                                                clean_thought_tags(&chapter_text),
                                                format!("✍️ Writing...({}/{})", ch, params.total_chapters),
                                            ));
                                        }
                                        chapter_text.push_str(content);
                                        count += 1;
                                        if in_thinking {
                                            thinking_tokens += 1;
                                            if count % 5 == 0 {
                                                let _ = on_event.send(StreamEvent::chapter_preview(
                                                    clean_thought_tags(&chapter_text),
                                                    format!("💭 Thinking...({} tokens) Writing...({}/{})", thinking_tokens, ch, params.total_chapters),
                                                ));
                                            }
                                        } else if count % 5 == 0 {
                                            let _ = on_event.send(StreamEvent::chapter_preview(
                                                clean_thought_tags(&chapter_text),
                                                format!("✍️ Writing...({}/{})", ch, params.total_chapters),
                                            ));
                                        }
                                    }
                                }
                            }
                        }
                        Ok(None) => break,
                        Ok(Some(Err(e))) => {
                            // Rollback on stream error
                            full_text = chapter_start_backup;
                            let error_msg = format!("Stream error in Chapter {}: {}", ch, e);
                            let _ = on_event.send(StreamEvent::full(
                                full_text.clone(),
                                true,
                                Some(error_msg.clone()),
                                None,
                            ));
                            return Ok(generation_error_result(full_text, &novel_filename, &meta, error_msg));
                        }
                        Err(_) => {
                            // Read Timeout
                            full_text = chapter_start_backup;
                            let error_msg = format!(
                                "Read Timeout: Server did not respond for {} minutes during Chapter {}.",
                                STREAM_READ_TIMEOUT_SECS / 60,
                                ch
                            );
                            let _ = on_event.send(StreamEvent::full(
                                full_text.clone(),
                                true,
                                Some(error_msg.clone()),
                                None,
                            ));
                            return Ok(generation_error_result(full_text, &novel_filename, &meta, error_msg));
                        }
                    }
                }

                if in_thinking {
                    chapter_text.push_str("\n</think>\n");
                }

                // If stopped during stream, rollback full_text
                if stop_flag.load(Ordering::Relaxed) {
                    full_text = chapter_start_backup;
                    break;
                }

                if let Some(error_msg) = stream_completion_error(
                    &format!("Chapter {}", ch),
                    saw_done_marker,
                    terminal_finish_reason.as_deref(),
                ) {
                    full_text = chapter_start_backup;
                    let _ = on_event.send(StreamEvent::full(
                        full_text.clone(),
                        true,
                        Some(error_msg.clone()),
                        None,
                    ));
                    return Ok(generation_error_result(full_text, &novel_filename, &meta, error_msg));
                }

                let cleaned_chapter = clean_thought_tags(&chapter_text);

                // Detect empty response (often happens with Google/Gemini due to safety blocks)
                if cleaned_chapter.trim().is_empty() && !stop_flag.load(Ordering::Relaxed) {
                    full_text = chapter_start_backup; // Rollback
                    let error_msg = format!(
                        "Empty response in Chapter {}. The model may have blocked the content due to safety filters or a connection issue.",
                        ch
                    );
                    let _ = on_event.send(StreamEvent::full(
                        full_text.clone(),
                        true,
                        Some(error_msg.clone()),
                        None,
                    ));
                    return Ok(generation_error_result(full_text, &novel_filename, &meta, error_msg));
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
                            let error_msg = format!(
                                "Chapter {} was written, but its summary generation failed: {} Generation is paused to prevent continuity corruption. Resume after manual review; continuity will be rebuilt from the written text.{}",
                                ch,
                                err,
                                save_error
                                    .as_ref()
                                    .map(|msg| format!(" Also failed to save recovery state: {}", msg))
                                    .unwrap_or_default()
                            );
                            let _ = on_event.send(StreamEvent::full(
                                full_text.clone(),
                                true,
                                Some(error_msg.clone()),
                                None,
                            ));
                            return Ok(generation_error_result(full_text, &novel_filename, &meta, error_msg));
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

                let error_msg = format!("API error in Chapter {}: {}", ch, error_msg);
                let _ = on_event.send(StreamEvent::full(
                    full_text.clone(),
                    true,
                    Some(error_msg.clone()),
                    None,
                ));
                return Ok(generation_error_result(full_text, &novel_filename, &meta, error_msg));
            }
        }
    }

    let _ = on_event.send(StreamEvent::full(
        full_text.clone(),
        true,
        None,
        Some("✅ Done".to_string()),
    ));

    Ok(generation_result(full_text, &novel_filename, &meta))
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
    let mut temp = temperature;
    if model_name.to_ascii_lowercase().contains("kimi") {
        temp = 1.0;
    }
    body_map.insert("temperature".to_string(), json!(temp));
    body_map.insert("top_p".to_string(), json!(top_p));

    let mut final_max_tokens = max_tokens;
    if !api_base.contains("googleapis.com") {
        final_max_tokens = final_max_tokens.max(16384);
    } else {
        final_max_tokens = final_max_tokens.min(8192);
    }
    body_map.insert("max_tokens".to_string(), json!(final_max_tokens));
    body_map.insert("stream".to_string(), json!(true));

    if !api_base.contains("googleapis.com")
        && !api_base.contains("opencode.ai")
        && !api_base.contains("cerebras.ai")
    {
        body_map.insert("repetition_penalty".to_string(), json!(repetition_penalty));
    }

    if api_base.contains("opencode.ai") && model_name.to_ascii_lowercase().contains("deepseek") {
        body_map.insert("thinking".to_string(), json!({ "type": "disabled" }));
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
    let mut in_thinking = false;
    let mut thinking_tokens: u32 = 0;
    let mut count = 0;
    let read_timeout_duration = Duration::from_secs(STREAM_READ_TIMEOUT_SECS);
    let mut saw_done_marker = false;
    let mut terminal_finish_reason: Option<String> = None;

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        match timeout(read_timeout_duration, stream.next()).await {
            Ok(Some(Ok(evt))) => {
                let data = evt.data;
                if data.trim() == "[DONE]" {
                    saw_done_marker = true;
                    break;
                }

                if let Ok(json) = serde_json::from_str::<Value>(&data) {
                    if let Some(reason) = stream_finish_reason(&json) {
                        terminal_finish_reason = Some(reason);
                    }
                    let delta = &json["choices"][0]["delta"];
                    if let Some(reasoning) = delta["reasoning_content"].as_str() {
                        if !in_thinking {
                            full_text.push_str("<think>\n");
                            in_thinking = true;
                        }
                        full_text.push_str(reasoning);
                        thinking_tokens += 1;
                        count += 1;
                        if count % 5 == 0 {
                            let _ = on_event.send(StreamEvent::full(
                                clean_thought_tags(&full_text),
                                false,
                                None,
                                Some(format!("💭 Thinking...({} tokens)", thinking_tokens)),
                            ));
                        }
                    } else if let Some(content) = delta["content"].as_str() {
                        if !content.is_empty() {
                            // Detect inline <think> tags (Qwen3, GLM, etc.)
                            if content.contains("<think>") && !in_thinking {
                                in_thinking = true;
                            }
                            if in_thinking && content.contains("</think>") {
                                in_thinking = false;
                                // Immediately notify UI that thinking is done
                                let _ = on_event.send(StreamEvent::full(
                                    clean_thought_tags(&full_text),
                                    false,
                                    None,
                                    Some("⏳ Generating...".to_string()),
                                ));
                            }
                            full_text.push_str(content);
                            count += 1;
                            if in_thinking {
                                thinking_tokens += 1;
                                if count % 5 == 0 {
                                    let _ = on_event.send(StreamEvent::full(
                                        clean_thought_tags(&full_text),
                                        false,
                                        None,
                                        Some(format!("💭 Thinking...({} tokens)", thinking_tokens)),
                                    ));
                                }
                            } else if count % 5 == 0 {
                                let _ = on_event.send(StreamEvent::full(
                                    clean_thought_tags(&full_text),
                                    false,
                                    None,
                                    Some("⏳ Generating...".to_string()),
                                ));
                            }
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
                    Some(format!("Read Timeout: Server did not respond for {} minutes during plot generation.", STREAM_READ_TIMEOUT_SECS / 60)),
                    None,
                ));
                return Ok(());
            }
        }
    }

    if in_thinking {
        full_text.push_str("\n</think>\n");
    }

    if !stop_flag.load(Ordering::Relaxed) {
        if let Some(error_msg) = stream_completion_error(
            "Plot generation",
            saw_done_marker,
            terminal_finish_reason.as_deref(),
        ) {
            let _ = on_event.send(StreamEvent::full(
                clean_thought_tags(&full_text),
                true,
                Some(error_msg),
                None,
            ));
            return Ok(());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focused_plot_context_keeps_adjacent_parts_full_and_compacts_distant_parts() {
        let mut plot =
            String::from("1. 제목\n테스트 소설\n\n2. 핵심 주제의식과 소설 스타일\n테스트 주제\n세계관에는 제 1부라는 시험명이 있다.\n\n");
        for part in 1..=3 {
            plot.push_str(&format!("제 {}부: 테스트 파트 {}\n", part, part));
            let start = (part - 1) * 4 + 1;
            let end = if part == 3 { 13 } else { part * 4 };
            for chapter in start..=end {
                let function = match part {
                    1 => "setup",
                    2 => "reveal",
                    _ => "climax",
                };
                plot.push_str(&format!(
                    "제 {}장: {}장 제목\n내용: {}장 내용\n핵심 포인트: {}장 포인트\nchapter_function: {}\n",
                    chapter, chapter, chapter, chapter, function
                ));
            }
        }
        let chapters = split_plot_into_chapters(&plot);
        let boundaries = split_plot_into_arc_boundaries(&plot);
        assert_eq!(boundaries.len(), 3, "{boundaries:?}");

        let focused =
            focused_plot_outline_for_chapter(&plot, &chapters, &boundaries, 10, 13, "Korean");

        assert!(focused.contains("chapter_function: climax"));
        assert!(focused.contains("chapter_function: reveal"));
        assert!(!focused.contains("chapter_function: setup"));
        assert!(focused.contains("세계관에는 제 1부라는 시험명이 있다."));
        assert_eq!(focused.matches("제 2부: 테스트 파트 2").count(), 1);
        assert_eq!(focused.matches("제 3부: 테스트 파트 3").count(), 1);
        assert!(focused.contains("제목: 1장 제목"));
        assert!(focused.contains("내용:\n1장 내용"));
        assert!(!focused.contains("핵심 포인트: 1장 포인트"));
    }

    #[test]
    fn focused_plot_context_is_disabled_under_thirteen_chapters() {
        let plot = "제 1부\n제 1장\n내용: 전체 유지\nchapter_function: setup";
        let chapters = split_plot_into_chapters(plot);
        let boundaries = split_plot_into_arc_boundaries(plot);

        let focused =
            focused_plot_outline_for_chapter(plot, &chapters, &boundaries, 1, 12, "Korean");

        assert_eq!(focused, plot);
    }

    #[test]
    fn compact_chapter_plot_infers_missing_title_from_content_label() {
        let compact = compact_chapter_plot(
            "내용: 사춘기가 시작되자마자 모든 학생이 머리 위의 상태창을 확인한다.\n핵심 포인트: 운명과 결함의 좌절감\nchapter_function: setup",
            "Korean",
        );

        assert!(
            compact.contains("제목: 사춘기가 시작되자마자 모든 학생이 머리 위의 상태창을 확인한다")
        );
        assert!(compact
            .contains("내용:\n사춘기가 시작되자마자 모든 학생이 머리 위의 상태창을 확인한다."));
        assert!(!compact.contains("핵심 포인트"));
        assert!(!compact.contains("Untitled"));
    }
}
