//! Restore saved continuity and summarize completed chapters with recovery checkpoints.
use super::super::super::checkpoints::record_memory_snapshot;
use super::super::super::memory::{
    apply_chapter_memory_update, build_expression_cooldown_from_chapters, close_due_planned_arcs,
    context_reconstruction_start, ensure_current_arc_has_signal, reconstruction_summary_pause,
    save_generation_state_to_disk, summarize_chapter_with_templates,
    CONTINUITY_FALLBACK_WARNING_THRESHOLD,
};
use super::NovelSession;
use std::sync::atomic::Ordering;
use tokio::time::sleep;

impl NovelSession {
    pub(super) async fn restore_context(&mut self) -> Result<(), String> {
        if let Some(rebuild_start) =
            context_reconstruction_start(&self.metadata, self.params.start_chapter)
        {
            if rebuild_start == 1 {
                // A true full rebuild must not replay chapters into old memory.
                self.metadata.recent_chapters.clear();
                self.metadata.story_state.clear();
                self.metadata.character_state.clear();
                self.metadata.relationship_state.clear();
                self.metadata.current_arc.clear();
                self.metadata.current_arc_keywords.clear();
                self.metadata.current_arc_start_chapter = 1;
                self.metadata.closed_arcs.clear();
                self.metadata.recent_scene_patterns.clear();
                self.metadata.continuity_fallback_count = 0;
                self.metadata.expression_cooldown.clear();
                self.metadata.memory_snapshots.clear();
            }
            self.metadata.current_chapter = self.params.start_chapter - 1;
            self.metadata.needs_memory_rebuild = true;
            self.metadata.memory_rebuild_from_chapter = Some(rebuild_start);
            let _ = self.events.full(
                &self.full_text,
                false,
                None,
                Some(if rebuild_start == self.params.start_chapter - 1 {
                    format!("🔄 Retrying summary for Chapter {}...", rebuild_start)
                } else {
                    format!(
                        "🔄 Reconstructing context from Chapter {}...",
                        rebuild_start
                    )
                }),
            );

            let rebuild_target = self.params.start_chapter.saturating_sub(1);
            let rebuild_pause = reconstruction_summary_pause(&self.params.api_base);
            for ch in rebuild_start..self.params.start_chapter {
                let _ = self.events.full(
                    &self.full_text,
                    false,
                    None,
                    Some(format!(
                        "🔄 Summarizing saved Chapter {} (through Chapter {})...",
                        ch, rebuild_target
                    )),
                );

                let content = self
                    .chapters
                    .get(&ch)
                    .map(String::as_str)
                    .unwrap_or_default();
                if content.trim().is_empty() {
                    self.metadata.needs_memory_rebuild = true;
                    let save_error = save_generation_state_to_disk(
                        &self.metadata,
                        &self.filename,
                        &self.full_text,
                    )
                    .err();
                    if let Some(save_err) = &save_error {
                        eprintln!(
                            "[Backend] Failed to save reconstruction failure metadata: {}",
                            save_err
                        );
                    }
                    self.stop_flag.store(true, Ordering::Relaxed);
                    let error_msg = format!(
                        "Context reconstruction failed: Chapter {} content is missing. Manual intervention is required before resuming.{}",
                        ch,
                        save_error
                            .as_ref()
                            .map(|msg| format!(" Also failed to save recovery metadata: {}", msg))
                            .unwrap_or_default()
                    );
                    return Err(error_msg);
                }

                let summary = match summarize_chapter_with_templates(
                    &self.params.api_base,
                    &self.params.provider,
                    &self.params.model_name,
                    &self.params.api_key,
                    content,
                    &self.params.language,
                    self.params.target_tokens,
                    &self.templates,
                    &self.params.thinking_level,
                )
                .await
                {
                    Ok(summary) => summary,
                    Err(err) => {
                        self.metadata.needs_memory_rebuild = true;
                        let save_error = save_generation_state_to_disk(
                            &self.metadata,
                            &self.filename,
                            &self.full_text,
                        )
                        .err();
                        if let Some(save_err) = &save_error {
                            eprintln!(
                                "[Backend] Failed to save reconstruction state: {}",
                                save_err
                            );
                        }
                        self.stop_flag.store(true, Ordering::Relaxed);
                        let error_msg = format!(
                            "Context reconstruction failed while summarizing Chapter {}: {} Manual intervention is required before resuming.{}",
                            ch,
                            err,
                            save_error
                                .as_ref()
                                .map(|msg| format!(" Also failed to save recovery state: {}", msg))
                                .unwrap_or_default()
                        );
                        return Err(error_msg);
                    }
                };

                let continuity_fallback_used = apply_chapter_memory_update(
                    &mut self.metadata,
                    ch,
                    summary,
                    self.params.total_chapters,
                    &self.arc_boundaries,
                    &self.params.api_base,
                    &self.params.provider,
                    &self.params.model_name,
                    &self.params.api_key,
                    &self.params.language,
                    &self.templates,
                    &self.params.thinking_level,
                )
                .await;
                if continuity_fallback_used {
                    let warning = if self.metadata.continuity_fallback_count
                        >= CONTINUITY_FALLBACK_WARNING_THRESHOLD
                    {
                        format!(
                            "⚠️ Continuity JSON fallback used while reconstructing Chapter {} ({} consecutive fallbacks). Continuing with conservative memory.",
                            ch,
                            self.metadata.continuity_fallback_count
                        )
                    } else {
                        format!(
                            "⚠️ Continuity JSON fallback used while reconstructing Chapter {} ({}/{} consecutive). Continuing with saved memory.",
                            ch,
                            self.metadata.continuity_fallback_count,
                            CONTINUITY_FALLBACK_WARNING_THRESHOLD
                        )
                    };
                    let _ = self
                        .events
                        .full(&self.full_text, false, None, Some(warning));
                }
                self.metadata.memory_rebuild_from_chapter = if ch < rebuild_target {
                    Some(ch + 1)
                } else {
                    None
                };
                self.metadata.needs_memory_rebuild =
                    self.metadata.memory_rebuild_from_chapter.is_some();
                let prefix_chapters = self
                    .chapters
                    .iter()
                    .filter(|(number, _)| **number <= ch)
                    .map(|(number, body)| (*number, body.clone()))
                    .collect();
                self.metadata.expression_cooldown = build_expression_cooldown_from_chapters(
                    "",
                    &prefix_chapters,
                    &self.params.language,
                    &self.templates,
                );
                record_memory_snapshot(&mut self.metadata, &self.full_text, ch);
                if let Err(save_err) =
                    save_generation_state_to_disk(&self.metadata, &self.filename, &self.full_text)
                {
                    eprintln!(
                        "[Backend] Failed to save reconstruction progress: {}",
                        save_err
                    );
                    let _ = self.events.full(
                        &self.full_text,
                        false,
                        None,
                        Some(format!(
                            "⚠️ Warning: Failed to save reconstructed metadata for Chapter {}. {}",
                            ch, save_err
                        )),
                    );
                }

                if ch < self.params.start_chapter - 1 {
                    sleep(rebuild_pause).await;
                }
            }
        }

        if self.params.start_chapter > 1 {
            self.metadata.current_chapter = self.params.start_chapter - 1;
            close_due_planned_arcs(
                &mut self.metadata,
                &self.arc_boundaries,
                self.params.start_chapter - 1,
                self.params.total_chapters,
                "",
                &[],
                None,
                false,
            );
            if let Err(save_err) =
                save_generation_state_to_disk(&self.metadata, &self.filename, &self.full_text)
            {
                eprintln!("[Backend] Failed to save resume baseline: {}", save_err);
                let _ = self.events.full(
                    &self.full_text,
                    false,
                    None,
                    Some(format!(
                        "⚠️ Warning: Failed to save resume metadata baseline. {}",
                        save_err
                    )),
                );
            }
        }

        ensure_current_arc_has_signal(
            &mut self.metadata,
            &self.arc_boundaries,
            self.params.start_chapter,
            self.params.total_chapters,
            self.chapter_plots
                .get(&self.params.start_chapter)
                .map(|plot| plot.as_str()),
            &[],
        );

        Ok(())
    }

    pub(super) async fn summarize_completed_chapter(
        &mut self,
        ch: u32,
        cleaned_chapter: &str,
    ) -> Result<(), String> {
        // 🌟 요약 시작 전 UI 업데이트 이벤트 발송
        let _ = self.events.full(
            &self.full_text,
            false,
            None,
            Some(format!("Summarizing Chapter {}...", ch)),
        );

        let summary = match summarize_chapter_with_templates(
            &self.params.api_base,
            &self.params.provider,
            &self.params.model_name,
            &self.params.api_key,
            cleaned_chapter,
            &self.params.language,
            self.params.target_tokens,
            &self.templates,
            &self.params.thinking_level,
        )
        .await
        {
            Ok(summary) => summary,
            Err(err) => {
                self.metadata.current_chapter = ch;
                self.metadata.needs_memory_rebuild = true;
                self.metadata.memory_rebuild_from_chapter = Some(ch);
                let save_error =
                    save_generation_state_to_disk(&self.metadata, &self.filename, &self.full_text)
                        .err();
                if let Some(save_err) = &save_error {
                    eprintln!(
                        "[Backend] Failed to save paused generation state: {}",
                        save_err
                    );
                }
                self.stop_flag.store(true, Ordering::Relaxed);
                let error_msg = format!(
                    "Chapter {} was written, but its summary generation failed: {} Generation is paused. On resume, only this chapter's summary and continuity update will be retried using the saved context.{}",
                    ch,
                    err,
                    save_error
                        .as_ref()
                        .map(|msg| format!(" Also failed to save recovery state: {}", msg))
                        .unwrap_or_default()
                );
                return Err(error_msg);
            }
        };

        let continuity_fallback_used = apply_chapter_memory_update(
            &mut self.metadata,
            ch,
            summary,
            self.params.total_chapters,
            &self.arc_boundaries,
            &self.params.api_base,
            &self.params.provider,
            &self.params.model_name,
            &self.params.api_key,
            &self.params.language,
            &self.templates,
            &self.params.thinking_level,
        )
        .await;
        if continuity_fallback_used {
            let warning = if self.metadata.continuity_fallback_count
                >= CONTINUITY_FALLBACK_WARNING_THRESHOLD
            {
                format!(
                    "⚠️ Continuity JSON fallback has been used {} consecutive times. Continuing with conservative memory; check continuity JSON output if this persists.",
                    self.metadata.continuity_fallback_count
                )
            } else {
                format!(
                    "⚠️ Continuity JSON fallback used for Chapter {} ({}/{} consecutive). Continuing with saved recent summary.",
                    ch,
                    self.metadata.continuity_fallback_count,
                    CONTINUITY_FALLBACK_WARNING_THRESHOLD
                )
            };
            let _ = self
                .events
                .full(&self.full_text, false, None, Some(warning));
        }
        Ok(())
    }
}
