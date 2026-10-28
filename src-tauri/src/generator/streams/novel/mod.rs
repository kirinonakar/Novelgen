//! Coordinate chapter generation, rollback, progress delivery, and checkpoint commits.
mod chapter_stream;
mod plot_context;
mod prompt;
mod recovery;
#[cfg(test)]
mod tests;

use super::super::checkpoints::{record_memory_snapshot, validate_resume_snapshots};
use super::super::memory::{
    build_expression_cooldown_from_chapters, ensure_current_arc_has_signal,
    sanitize_closed_arc_memory, save_generation_state_to_disk,
};
use super::super::text::{split_full_text_into_chapters, split_plot_into_chapters};
use super::super::types::{
    NovelGenerationParams, NovelGenerationResult, NovelMetadata, StreamEvent,
};
use super::events::NovelEventSender;
use super::files::get_next_novel_filename;
use crate::continuity_json::sanitize_keywords;
use crate::paths::validate_novel_filename;
use crate::plot_structure::{
    extract_novel_title, format_part_heading_label, split_plot_into_arc_boundaries, PlotArcBoundary,
};
use crate::prompt_templates::PromptTemplates;
use reqwest::Client;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

struct NovelSession {
    params: NovelGenerationParams,
    templates: PromptTemplates,
    client: Client,
    url: String,
    full_text: String,
    events: NovelEventSender,
    filename: String,
    metadata: NovelMetadata,
    chapter_plots: HashMap<u32, String>,
    arc_boundaries: Vec<PlotArcBoundary>,
    chapters: HashMap<u32, String>,
    stop_flag: Arc<AtomicBool>,
}

pub async fn generate_novel_stream(
    params: NovelGenerationParams,
    on_event: tauri::ipc::Channel<StreamEvent>,
    stop_flag: Arc<AtomicBool>,
) -> Result<NovelGenerationResult, String> {
    NovelSession::new(params, on_event, stop_flag)?.run().await
}

impl NovelSession {
    fn new(
        mut params: NovelGenerationParams,
        on_event: tauri::ipc::Channel<StreamEvent>,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let prompt_templates = PromptTemplates::load(params.prompt_templates.as_ref());
        let client = Client::builder().build().unwrap();
        let url = format!("{}/chat/completions", params.api_base.trim_end_matches('/'));

        let full_text = if params.start_chapter == 1 {
            String::new()
        } else {
            params.initial_text.clone()
        };
        let on_event = NovelEventSender::new(on_event, &full_text);
        let chapter_plots = split_plot_into_chapters(&params.plot_outline);
        let plot_arc_boundaries = split_plot_into_arc_boundaries(&params.plot_outline);

        // Ensure we have a filename
        let novel_filename = match params.novel_filename.take() {
            Some(filename) => validate_novel_filename(&filename)?,
            None => get_next_novel_filename(),
        };

        // Restore caller-provided memory only when resuming an existing manuscript.
        let mut meta =
            NovelMetadata::new(&params.language, params.total_chapters, &params.plot_seed);
        meta.target_tokens = params.target_tokens;
        if let Some(title) = extract_novel_title(&params.plot_outline) {
            meta.title = title;
        }
        meta.plot_outline = params.plot_outline.clone();

        if params.start_chapter == 1 {
            // Establish a resumable empty checkpoint before the first provider request.
            save_generation_state_to_disk(&meta, &novel_filename, &full_text)?;
        }

        // Only use provided memory if we are resuming (start_chapter > 1)
        if params.start_chapter > 1 {
            if let Some(recent) = params.recent_chapters.take() {
                meta.recent_chapters = recent;
            }
            if let Some(state) = params.story_state.take() {
                meta.story_state = state;
            }
            if let Some(characters) = params.character_state.take() {
                meta.character_state = characters;
            }
            if let Some(relationships) = params.relationship_state.take() {
                meta.relationship_state = relationships;
            }
            if let Some(arc) = params.current_arc.take() {
                meta.current_arc = arc;
            }
            if let Some(keywords) = params.current_arc_keywords.take() {
                meta.current_arc_keywords = sanitize_keywords(&keywords);
            }
            if let Some(start) = params.current_arc_start_chapter.take() {
                meta.current_arc_start_chapter = start.max(1);
            }
            if let Some(arcs) = params.closed_arcs.take() {
                meta.closed_arcs = arcs.into_iter().map(sanitize_closed_arc_memory).collect();
            }
            if let Some(cooldown) = params.expression_cooldown.take() {
                meta.expression_cooldown = cooldown;
            }
            if let Some(patterns) = params.recent_scene_patterns.take() {
                meta.recent_scene_patterns = patterns;
            }
            if let Some(needs_rebuild) = params.needs_memory_rebuild.take() {
                meta.needs_memory_rebuild = needs_rebuild;
            }
            meta.memory_rebuild_from_chapter = params.memory_rebuild_from_chapter;
            if let Some(fallback_count) = params.continuity_fallback_count.take() {
                meta.continuity_fallback_count = fallback_count;
            }
            meta.memory_snapshots = params.memory_snapshots.take().unwrap_or_default();
            meta.last_refinement = params.last_refinement.take();
            meta.current_chapter = params.start_chapter - 1;
            validate_resume_snapshots(&mut meta, &full_text);
        }

        let current_chapters = if params.start_chapter > 1 {
            split_full_text_into_chapters(&full_text, &params.language)
        } else {
            HashMap::new()
        };
        Ok(Self {
            params,
            templates: prompt_templates,
            client,
            url,
            full_text,
            events: on_event,
            filename: novel_filename,
            metadata: meta,
            chapter_plots,
            arc_boundaries: plot_arc_boundaries,
            chapters: current_chapters,
            stop_flag,
        })
    }

    fn into_result(self, error: Option<String>) -> NovelGenerationResult {
        NovelGenerationResult {
            full_text: self.full_text,
            novel_filename: self.filename,
            metadata: self.metadata,
            error,
        }
    }

    fn fail(self, error: String) -> NovelGenerationResult {
        let _ = self
            .events
            .full(&self.full_text, true, Some(error.clone()), None);
        self.into_result(Some(error))
    }

    async fn run(mut self) -> Result<NovelGenerationResult, String> {
        if let Err(error) = self.restore_context().await {
            return Ok(self.fail(error));
        }
        let visible_part_headings = self
            .arc_boundaries
            .iter()
            .filter(|boundary| !boundary.inferred)
            .enumerate()
            .map(|(idx, boundary)| (boundary.start_chapter, idx as u32 + 1))
            .collect::<Vec<_>>();

        for ch in self.params.start_chapter..=self.params.total_chapters {
            if self.stop_flag.load(Ordering::Relaxed) {
                break;
            }

            ensure_current_arc_has_signal(
                &mut self.metadata,
                &self.arc_boundaries,
                ch,
                self.params.total_chapters,
                self.chapter_plots.get(&ch).map(|plot| plot.as_str()),
                &[],
            );

            // Save state at the start of chapter to handle rollback on stop
            let chapter_start_backup = self.full_text.clone();
            self.events.begin_chapter(&self.full_text);

            let _ = self.events.full(
                &self.full_text,
                false,
                None,
                Some(format!("Writing...({}/{})", ch, self.params.total_chapters)),
            );

            self.metadata.expression_cooldown = build_expression_cooldown_from_chapters(
                &self.full_text,
                &self.chapters,
                &self.params.language,
                &self.templates,
            );
            record_memory_snapshot(&mut self.metadata, &self.full_text, ch);

            let prompt = self.chapter_prompt(ch);

            // Title Header
            if ch == 1 && self.params.start_chapter == 1 {
                let title = self.metadata.title.trim();
                if !title.is_empty() {
                    self.full_text.push_str(&format!("\n\n# {}\n\n", title));
                } else {
                    let default_title = match self.params.language.as_str() {
                        "Korean" => "# 제목",
                        "Japanese" => "# 題名",
                        _ => "# Title",
                    };
                    self.full_text
                        .push_str(&format!("\n\n{}\n\n", default_title));
                }
            }

            if let Some((_, ordinal)) = visible_part_headings
                .iter()
                .find(|(start_chapter, _)| *start_chapter == ch)
            {
                let label = format_part_heading_label(&self.params.language, *ordinal);
                self.full_text.push_str(&format!("\n\n## {}\n\n", label));
            }

            let ch_title = match self.params.language.as_str() {
                "Korean" => format!("\n\n### 제 {}장\n\n", ch),
                "Japanese" => format!("\n\n### 第 {} 章\n\n", ch),
                _ => format!("\n\n### Chapter {}\n\n", ch),
            };

            self.full_text.push_str(&ch_title);

            // Check stop flag before starting the API request
            if self.stop_flag.load(Ordering::Relaxed) {
                self.full_text = chapter_start_backup;
                break;
            }

            let _ = self.events.full(
                &self.full_text,
                false,
                None,
                Some(format!("Writing...({}/{})", ch, self.params.total_chapters)),
            );

            let cleaned_chapter = match self.stream_chapter(ch, prompt).await {
                Ok(Some(chapter)) => chapter,
                Ok(None) => {
                    self.full_text = chapter_start_backup;
                    break;
                }
                Err(error) => {
                    self.full_text = chapter_start_backup;
                    return Ok(self.fail(error));
                }
            };
            self.full_text.push_str(&cleaned_chapter);
            self.full_text.push('\n');
            self.chapters.insert(ch, cleaned_chapter.clone());
            if ch < self.params.total_chapters && !self.stop_flag.load(Ordering::Relaxed) {
                if let Err(error) = self.summarize_completed_chapter(ch, &cleaned_chapter).await {
                    return Ok(self.fail(error));
                }
            }
            self.metadata.current_chapter = ch;
            self.metadata.expression_cooldown = build_expression_cooldown_from_chapters(
                &self.full_text,
                &self.chapters,
                &self.params.language,
                &self.templates,
            );

            // Final chapter state to frontend
            let _ = self.events.full(
                &self.full_text,
                false,
                None,
                Some(format!("Writing...({}/{})", ch, self.params.total_chapters)),
            );

            // Commit the completed chapter and its continuity metadata together.
            if let Err(save_err) =
                save_generation_state_to_disk(&self.metadata, &self.filename, &self.full_text)
            {
                eprintln!("[Backend] Failed to save generation state: {}", save_err);
                let _ = self.events.full(
                    &self.full_text,
                    false,
                    None,
                    Some(format!(
                        "⚠️ Warning: Failed to save progress to disk. {}",
                        save_err
                    )),
                );
            }
        }
        let _ = self
            .events
            .full(&self.full_text, true, None, Some("✅ Done".to_string()));
        Ok(self.into_result(None))
    }
}
