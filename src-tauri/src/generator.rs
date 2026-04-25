mod api;
mod memory;
mod streams;
mod text;
mod types;

pub use api::{chat_completion, fetch_models_impl, generate_seed_impl};
pub use streams::{
    generate_novel_stream, generate_plot_stream, get_next_novel_filename, suggest_next_chapter,
};
pub use types::{NovelGenerationParams, StreamEvent};

#[cfg(test)]
mod tests {
    use super::memory::{
        format_recent_beat_cooldown, should_reconstruct_context,
        strip_dialogue_for_expression_cooldown,
        CONTINUITY_FALLBACK_WARNING_THRESHOLD,
    };
    use super::text::{
        split_text_by_char_budget, summary_input_char_budget, tail_with_paragraph_boundary,
        SUMMARY_INPUT_MAX_CHARS,
    };
    use super::types::{ChapterMemory, NovelMetadata};

    #[test]
    fn summary_input_budget_scales_with_target_tokens() {
        assert_eq!(summary_input_char_budget(0), 4000);
        assert_eq!(summary_input_char_budget(500), 6000);
        assert_eq!(summary_input_char_budget(2000), 12000);
        assert_eq!(summary_input_char_budget(u32::MAX), SUMMARY_INPUT_MAX_CHARS);
    }

    #[test]
    fn summary_chunking_preserves_full_text_content() {
        let text = format!("{}\n\n{}", "a".repeat(4500), "b".repeat(3500));
        let chunks = split_text_by_char_budget(&text, 4000);

        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 4000));

        let original_without_whitespace: String =
            text.chars().filter(|ch| !ch.is_whitespace()).collect();
        let chunked_without_whitespace: String = chunks
            .join("")
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .collect();

        assert_eq!(chunked_without_whitespace, original_without_whitespace);
    }

    #[test]
    fn preceding_tail_prefers_paragraph_boundary() {
        let text = format!(
            "intro paragraph.\n\nfinal paragraph starts cleanly. {}",
            "x".repeat(500)
        );
        let tail = tail_with_paragraph_boundary(&text, 400);

        assert!(tail.starts_with("final paragraph starts cleanly."));
    }

    #[test]
    fn expression_cooldown_ignores_quoted_dialogue() {
        let phrase = "그는 고개를 끄덕였다";
        let text =
            format!("{phrase}. \"{phrase}.\" “{phrase}.” 「{phrase}.」 서술은 여기서 끝났다.");
        let stripped = strip_dialogue_for_expression_cooldown(&text);

        assert_eq!(stripped.matches(phrase).count(), 1);
        assert!(stripped.contains("서술은 여기서 끝났다"));
    }

    #[test]
    fn recent_beat_cooldown_formats_recent_summary_beats() {
        let mut chapters = std::collections::VecDeque::new();
        chapters.push_back(ChapterMemory {
            chapter: 1,
            summary: "- old setup beat".to_string(),
        });
        chapters.push_back(ChapterMemory {
            chapter: 2,
            summary: "- A shields B at the gate.\n- A shields B at the gate.".to_string(),
        });
        chapters.push_back(ChapterMemory {
            chapter: 3,
            summary: "- B almost confesses but changes the subject.".to_string(),
        });

        let cooldown = format_recent_beat_cooldown(&chapters);

        assert!(cooldown.contains("Chapter 2 beat to avoid replaying unchanged"));
        assert!(cooldown.contains("A shields B at the gate"));
        assert!(cooldown.contains("Chapter 3 beat to avoid replaying unchanged"));
        assert_eq!(cooldown.matches("A shields B at the gate").count(), 1);
    }

    fn resume_memory_with_previous_summary(previous_chapter: u32) -> NovelMetadata {
        let mut meta = NovelMetadata::new("Korean", 10, "seed");
        meta.story_state = "- FACT: durable story memory".to_string();
        meta.character_state = "- CHAR: A | status: active".to_string();
        meta.current_arc = "- ARC: active arc memory".to_string();
        meta.recent_chapters.push_back(ChapterMemory {
            chapter: previous_chapter,
            summary: "previous chapter summary".to_string(),
        });
        meta
    }

    #[test]
    fn resume_skips_reconstruction_for_single_continuity_fallback_with_memory() {
        let mut meta = resume_memory_with_previous_summary(6);
        meta.needs_memory_rebuild = true;
        meta.continuity_fallback_count = 1;

        assert!(!should_reconstruct_context(&meta, 7));
    }

    #[test]
    fn resume_reconstructs_when_previous_chapter_summary_is_missing() {
        let meta = resume_memory_with_previous_summary(5);

        assert!(should_reconstruct_context(&meta, 7));
    }

    #[test]
    fn resume_reconstructs_after_repeated_continuity_fallbacks() {
        let mut meta = resume_memory_with_previous_summary(6);
        meta.needs_memory_rebuild = true;
        meta.continuity_fallback_count = CONTINUITY_FALLBACK_WARNING_THRESHOLD;

        assert!(should_reconstruct_context(&meta, 7));
    }

    #[test]
    fn resume_reconstructs_when_compact_memory_is_empty() {
        let meta = NovelMetadata::new("Korean", 10, "seed");

        assert!(should_reconstruct_context(&meta, 2));
    }
}
