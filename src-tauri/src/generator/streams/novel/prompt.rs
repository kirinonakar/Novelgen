//! Assemble chapter prompts from plot, continuity, cooldowns, and preceding prose.
use super::super::super::memory::{
    format_expression_cooldown, format_recent_beat_cooldown, format_scene_pattern_cooldown,
    latest_closed_arc_before_current, select_relevant_closed_arc,
};
use super::super::super::text::tail_with_paragraph_boundary;
use super::plot_context::focused_plot_outline_for_chapter;
use super::NovelSession;
use crate::continuity_json::sanitize_keywords;
use crate::prompt_templates::render_template;

const DIRECT_PRECEDING_TAIL_CHARS: usize = 1200;

impl NovelSession {
    pub(super) fn chapter_prompt(&self, ch: u32) -> String {
        let active_arc_start = self.metadata.current_arc_start_chapter.max(1);
        let current_chapter_plot_text = self
            .chapter_plots
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

        let expression_cooldown = format_expression_cooldown(&self.metadata.expression_cooldown);
        let expression_cooldown_section = if expression_cooldown.trim().is_empty() {
            String::new()
        } else {
            render_template(
                &self.templates.expression_cooldown,
                &[("expression_cooldown", expression_cooldown)],
            )
        };
        let recent_beat_cooldown = format_recent_beat_cooldown(&self.metadata.recent_chapters);
        let scene_pattern_cooldown =
            format_scene_pattern_cooldown(&self.metadata.recent_scene_patterns, ch);
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
            latest_closed_arc_before_current(&self.metadata.closed_arcs, active_arc_start);
        let relevant_closed_arc = select_relevant_closed_arc(
            &self.metadata.closed_arcs,
            self.chapter_plots.get(&ch),
            &self.metadata.current_arc,
            &self.metadata.current_arc_keywords,
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
        if !self.metadata.recent_chapters.is_empty() {
            recent_chapter_summaries_section
                .push_str("[Recent Chapter Summaries: Immediate continuity bridge]\n");
            for entry in &self.metadata.recent_chapters {
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
            if let Some(prev_text) = self.chapters.get(&last_ch) {
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
            &self.params.plot_outline,
            &self.chapter_plots,
            &self.arc_boundaries,
            ch,
            self.params.total_chapters,
            &self.params.language,
        );

        render_template(
            &self.templates.novel_chapter,
            &[
                ("language", self.params.language.clone()),
                ("total_chapters", self.params.total_chapters.to_string()),
                ("plot_outline", focused_plot_outline),
                ("chapter", ch.to_string()),
                ("target_tokens", self.params.target_tokens.to_string()),
                ("current_chapter_plot_section", current_chapter_plot_section),
                (
                    "current_chapter_keywords_section",
                    current_chapter_keywords_section,
                ),
                ("expression_cooldown_section", expression_cooldown_section),
                ("recent_beat_cooldown_section", recent_beat_cooldown_section),
                (
                    "story_state",
                    if self.metadata.story_state.trim().is_empty() {
                        "None yet.".to_string()
                    } else {
                        self.metadata.story_state.trim().to_string()
                    },
                ),
                (
                    "character_state",
                    if self.metadata.character_state.trim().is_empty() {
                        "None yet.".to_string()
                    } else {
                        self.metadata.character_state.trim().to_string()
                    },
                ),
                (
                    "relationship_state",
                    if self.metadata.relationship_state.trim().is_empty() {
                        "None yet.".to_string()
                    } else {
                        self.metadata.relationship_state.trim().to_string()
                    },
                ),
                ("current_arc_start_chapter", active_arc_start.to_string()),
                (
                    "current_arc",
                    if self.metadata.current_arc.trim().is_empty() {
                        "None yet. Establish the new arc from the chapter plot, recent chapters, and story state.".to_string()
                    } else {
                        self.metadata.current_arc.trim().to_string()
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
        )
    }
}
