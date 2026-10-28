//! Hash-validated continuity checkpoints. A changed chapter invalidates its entire suffix.

use super::text::{
    novel_chapter_numbers, novel_memory_source, novel_preamble, split_full_text_into_chapters,
};
use super::types::{ChapterMemory, ClosedArcMemory, NovelMetadata};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ChapterMemorySnapshot {
    pub chapter: u32,
    pub manuscript_hash: String,
    pub prefix_hash: String,
    memory: MemoryState,
}

// Deliberately excludes metadata, rebuild flags, and snapshots to avoid recursive copies.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct MemoryState {
    story_state: String,
    character_state: String,
    relationship_state: String,
    current_arc: String,
    current_arc_keywords: Vec<String>,
    current_arc_start_chapter: u32,
    recent_chapters: VecDeque<ChapterMemory>,
    closed_arcs: Vec<ClosedArcMemory>,
    expression_cooldown: Vec<String>,
    recent_scene_patterns: Vec<String>,
    continuity_fallback_count: u32,
}

impl MemoryState {
    fn capture(meta: &NovelMetadata) -> Self {
        Self {
            story_state: meta.story_state.clone(),
            character_state: meta.character_state.clone(),
            relationship_state: meta.relationship_state.clone(),
            current_arc: meta.current_arc.clone(),
            current_arc_keywords: meta.current_arc_keywords.clone(),
            current_arc_start_chapter: meta.current_arc_start_chapter,
            recent_chapters: meta.recent_chapters.clone(),
            closed_arcs: meta.closed_arcs.clone(),
            expression_cooldown: meta.expression_cooldown.clone(),
            recent_scene_patterns: meta.recent_scene_patterns.clone(),
            continuity_fallback_count: meta.continuity_fallback_count,
        }
    }

    fn restore(self, meta: &mut NovelMetadata) {
        meta.story_state = self.story_state;
        meta.character_state = self.character_state;
        meta.relationship_state = self.relationship_state;
        meta.current_arc = self.current_arc;
        meta.current_arc_keywords = self.current_arc_keywords;
        meta.current_arc_start_chapter = self.current_arc_start_chapter;
        meta.recent_chapters = self.recent_chapters;
        meta.closed_arcs = self.closed_arcs;
        meta.expression_cooldown = self.expression_cooldown;
        meta.recent_scene_patterns = self.recent_scene_patterns;
        meta.continuity_fallback_count = self.continuity_fallback_count;
    }
}

fn hash(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

// Hash the same persisted representation during capture and validation, including headings
// and preceding chapter dependencies. Missing chapters prevent reuse beyond that point.
fn chapter_hashes(meta: &NovelMetadata, text: &str) -> BTreeMap<u32, (String, String)> {
    let source = novel_memory_source(text);
    let chapters = split_full_text_into_chapters(&source, &meta.language);
    let mut prefix = hash(&[
        "novel-memory-v1",
        &meta.language,
        &meta.num_chapters.to_string(),
        &meta.plot_outline,
        novel_preamble(&source, &meta.language),
    ]);
    let mut hashes = BTreeMap::new();
    for (index, number) in novel_chapter_numbers(&source, &meta.language)
        .into_iter()
        .enumerate()
    {
        let chapter = index as u32 + 1;
        if chapter != number {
            break;
        }
        let Some(body) = chapters.get(&chapter).filter(|s| !s.trim().is_empty()) else {
            break;
        };
        let manuscript = hash(&[body]);
        prefix = hash(&[&prefix, &chapter.to_string(), &manuscript]);
        hashes.insert(chapter, (manuscript, prefix.clone()));
    }
    hashes
}

pub(crate) fn record_memory_snapshot(meta: &mut NovelMetadata, text: &str, chapter: u32) {
    if !meta
        .recent_chapters
        .iter()
        .any(|entry| entry.chapter == chapter && !entry.summary.trim().is_empty())
    {
        return; // Never certify an unsummarized final chapter or failed summary.
    }
    let hashes = chapter_hashes(meta, text);
    let Some((manuscript_hash, prefix_hash)) = hashes.get(&chapter) else {
        return;
    };
    // Drop snapshots from a replaced or no longer matching suffix.
    meta.memory_snapshots.retain(|snapshot| {
        snapshot.chapter < chapter
            && hashes.get(&snapshot.chapter).is_some_and(|(body, prefix)| {
                body == &snapshot.manuscript_hash && prefix == &snapshot.prefix_hash
            })
    });
    meta.memory_snapshots.push(ChapterMemorySnapshot {
        chapter,
        manuscript_hash: manuscript_hash.clone(),
        prefix_hash: prefix_hash.clone(),
        memory: MemoryState::capture(meta),
    });
}

fn restore_valid_prefix(meta: &mut NovelMetadata, text: &str) {
    let hashes = chapter_hashes(meta, text);
    meta.memory_snapshots.retain(|snapshot| {
        hashes.get(&snapshot.chapter).is_some_and(|(body, prefix)| {
            body == &snapshot.manuscript_hash && prefix == &snapshot.prefix_hash
        })
    });
    let latest = meta
        .memory_snapshots
        .iter()
        .max_by_key(|snapshot| snapshot.chapter)
        .cloned();
    let through = if let Some(snapshot) = latest {
        snapshot.memory.restore(meta);
        snapshot.chapter
    } else {
        let empty = NovelMetadata::new(&meta.language, meta.num_chapters, &meta.plot_seed);
        MemoryState::capture(&empty).restore(meta);
        0
    };
    meta.memory_rebuild_from_chapter = (through < meta.current_chapter).then_some(through + 1);
    meta.needs_memory_rebuild = meta.memory_rebuild_from_chapter.is_some();
}

pub(crate) fn validate_resume_snapshots(meta: &mut NovelMetadata, text: &str) {
    let hashes = chapter_hashes(meta, text);
    if meta.memory_snapshots.iter().any(|snapshot| {
        !hashes.get(&snapshot.chapter).is_some_and(|(body, prefix)| {
            body == &snapshot.manuscript_hash && prefix == &snapshot.prefix_hash
        })
    }) {
        restore_valid_prefix(meta, text);
    }
}

pub fn prepare_refined_metadata(
    meta: &mut NovelMetadata,
    text: &str,
    previous: Option<&(String, String)>,
) {
    // Legacy files have no per-chapter provenance. Keep their memory only when both
    // persisted text and memory inputs are unchanged; otherwise rebuild conservatively.
    let unchanged = previous.is_some_and(|(old_text, old_json)| {
        old_text.replace("\r\n", "\n").trim() == text.replace("\r\n", "\n").trim()
            && serde_json::from_str::<NovelMetadata>(old_json).is_ok_and(|old| {
                old.language == meta.language
                    && old.num_chapters == meta.num_chapters
                    && old.plot_outline == meta.plot_outline
            })
    });
    if unchanged {
        validate_resume_snapshots(meta, text);
    } else {
        restore_valid_prefix(meta, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::memory::context_reconstruction_start;

    fn manuscript(through: u32) -> String {
        (1..=through)
            .map(|ch| format!("Chapter {ch}\n\nOriginal chapter {ch}.\n\n"))
            .collect()
    }

    fn saved_novel() -> (NovelMetadata, String) {
        let mut meta = NovelMetadata::new("English", 30, "seed");
        meta.plot_outline = "Original outline".into();
        for ch in 1..=29 {
            meta.current_chapter = ch;
            meta.story_state = format!("Story through {ch}");
            meta.character_state = format!("Characters through {ch}");
            meta.relationship_state = format!("Relations through {ch}");
            meta.current_arc = format!("Arc through {ch}");
            meta.current_arc_start_chapter = ch;
            meta.current_arc_keywords = vec![format!("keyword {ch}")];
            meta.expression_cooldown = vec![format!("expression {ch}")];
            meta.recent_scene_patterns = vec![format!("pattern {ch}")];
            meta.closed_arcs = vec![ClosedArcMemory {
                start_chapter: 1,
                end_chapter: ch,
                summary: format!("Closed through {ch}"),
                keywords: vec![],
            }];
            meta.recent_chapters.push_back(ChapterMemory {
                chapter: ch,
                summary: format!("Summary {ch}"),
            });
            if meta.recent_chapters.len() > 4 {
                meta.recent_chapters.pop_front();
            }
            record_memory_snapshot(&mut meta, &manuscript(ch), ch);
        }
        meta.current_chapter = 30; // The final chapter is not summarized during normal generation.
        (meta, manuscript(30))
    }

    fn previous(meta: &NovelMetadata, text: &str) -> (String, String) {
        (text.into(), serde_json::to_string(meta).unwrap())
    }

    #[test]
    fn changing_chapter_28_restores_all_memory_through_27_only() {
        let (mut meta, text) = saved_novel();
        let old = previous(&meta, &text);
        let expected = serde_json::to_value(&meta.memory_snapshots[26].memory).unwrap();
        // Match refinement's automatic normalization of part separators as well.
        let revised = format!(
            "## Part 1\n\n{}",
            text.replace("Chapter 11\n", "## Part 2\n\nChapter 11\n")
                .replace("Chapter 21\n", "## Part 3\n\nChapter 21\n")
                .replace("Original chapter 28.", "Revised chapter 28.")
        );
        prepare_refined_metadata(&mut meta, &revised, Some(&old));
        assert_eq!(meta.current_chapter, 30);
        assert_eq!(meta.memory_rebuild_from_chapter, Some(28));
        assert_eq!(context_reconstruction_start(&meta, 31), Some(28));
        assert_eq!(meta.memory_snapshots.len(), 27);
        assert_eq!(
            serde_json::to_value(MemoryState::capture(&meta)).unwrap(),
            expected
        );
        // Repeated chapter saves and disk round trips must retain the same baseline.
        let checkpoint = previous(&meta, &revised);
        let mut meta: NovelMetadata = serde_json::from_str(&checkpoint.1).unwrap();
        prepare_refined_metadata(&mut meta, &revised, Some(&checkpoint));
        assert_eq!(context_reconstruction_start(&meta, 31), Some(28));
        let revised_again = revised.replace("Original chapter 29.", "Revised chapter 29.");
        prepare_refined_metadata(&mut meta, &revised_again, Some(&checkpoint));
        assert_eq!(context_reconstruction_start(&meta, 31), Some(28));
    }

    #[test]
    fn earlier_edit_invalidates_all_dependent_hashes_even_when_later_bodies_are_unchanged() {
        let (mut meta, text) = saved_novel();
        let hashes = chapter_hashes(&meta, &text);
        let revised = text.replace("Original chapter 2.", "Changed chapter 2.");
        let changed_hashes = chapter_hashes(&meta, &revised);
        assert_eq!(hashes[&28].0, changed_hashes[&28].0);
        assert_ne!(hashes[&28].1, changed_hashes[&28].1);
        prepare_refined_metadata(&mut meta, &revised, None);
        assert_eq!(meta.memory_rebuild_from_chapter, Some(2));
        assert_eq!(meta.story_state, "Story through 1");
        assert_eq!(meta.memory_snapshots.len(), 1);
    }

    #[test]
    fn unchanged_legacy_memory_is_preserved_but_edited_legacy_memory_is_cleared() {
        let (mut meta, text) = saved_novel();
        meta.memory_snapshots.clear();
        let old = previous(&meta, &text);
        prepare_refined_metadata(&mut meta, &text.replace("\n", "\r\n"), Some(&old));
        assert!(!meta.needs_memory_rebuild);
        assert_eq!(meta.story_state, "Story through 29");
        prepare_refined_metadata(
            &mut meta,
            &text.replace("chapter 28.", "changed chapter 28."),
            Some(&old),
        );
        assert_eq!(meta.memory_rebuild_from_chapter, Some(1));
        assert!(meta.story_state.is_empty());
        assert!(meta.character_state.is_empty());
        assert!(meta.relationship_state.is_empty());
        assert!(meta.expression_cooldown.is_empty());
        assert!(meta.closed_arcs.is_empty());
        assert_eq!(meta.current_chapter, 30);
    }

    #[test]
    fn changed_outline_language_or_preamble_prevents_stale_snapshot_reuse() {
        for change in ["outline", "language", "preamble"] {
            let (mut meta, text) = saved_novel();
            let old = previous(&meta, &text);
            let mut revised = text.clone();
            match change {
                "outline" => meta.plot_outline.push_str(" new rules"),
                "language" => meta.language = "Korean".into(),
                _ => revised.insert_str(0, "New prologue.\n\n"),
            }
            prepare_refined_metadata(&mut meta, &revised, Some(&old));
            assert_eq!(meta.memory_rebuild_from_chapter, Some(1), "{change}");
            assert!(meta.memory_snapshots.is_empty());
        }
    }

    #[test]
    fn resume_truncation_and_external_edits_restore_the_latest_matching_checkpoint() {
        let (mut meta, _) = saved_novel();
        meta.current_chapter = 10;
        validate_resume_snapshots(&mut meta, &manuscript(10));
        assert_eq!(meta.story_state, "Story through 10");
        assert_eq!(meta.memory_rebuild_from_chapter, None);
        assert_eq!(context_reconstruction_start(&meta, 11), None);
        assert_eq!(meta.memory_snapshots.len(), 10);
        validate_resume_snapshots(
            &mut meta,
            &manuscript(10).replace("Original chapter 8.", "Edited chapter 8."),
        );
        assert_eq!(meta.story_state, "Story through 7");
        assert_eq!(context_reconstruction_start(&meta, 11), Some(8));
    }

    #[test]
    fn missing_chapter_and_missing_summary_never_certify_a_checkpoint() {
        let (mut meta, text) = saved_novel();
        let revised = text.replace("Chapter 4\n\nOriginal chapter 4.\n\n", "");
        prepare_refined_metadata(&mut meta, &revised, None);
        // The preceding chapter chunk may also change when a chapter is deleted.
        assert!(meta
            .memory_snapshots
            .iter()
            .all(|snapshot| snapshot.chapter < 4));
        assert!(meta.memory_rebuild_from_chapter.unwrap() <= 4);
        let count = meta.memory_snapshots.len();
        record_memory_snapshot(&mut meta, &text, 30);
        assert_eq!(meta.memory_snapshots.len(), count);
    }

    #[test]
    fn reordered_chapters_cannot_reuse_memory_from_the_old_order() {
        let (mut meta, text) = saved_novel();
        let second = "Chapter 2\n\nOriginal chapter 2.\n\n";
        let third = "Chapter 3\n\nOriginal chapter 3.\n\n";
        let revised = text.replace(&format!("{second}{third}"), &format!("{third}{second}"));
        prepare_refined_metadata(&mut meta, &revised, None);
        assert_eq!(meta.memory_rebuild_from_chapter, Some(2));
        assert_eq!(meta.story_state, "Story through 1");
    }
}
