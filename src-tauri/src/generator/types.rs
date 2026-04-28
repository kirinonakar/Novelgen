use crate::prompt_templates::PromptTemplateOverrides;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct ChapterMemory {
    pub chapter: u32,
    pub summary: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct ClosedArcMemory {
    pub start_chapter: u32,
    pub end_chapter: u32,
    pub summary: String,
    pub keywords: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct NovelMetadata {
    pub title: String,
    pub language: String,
    pub num_chapters: u32,
    pub target_tokens: u32,
    pub current_chapter: u32,
    pub needs_memory_rebuild: bool,
    pub plot_seed: String,
    pub plot_outline: String,
    pub story_state: String,
    pub character_state: String,
    pub relationship_state: String,
    pub current_arc: String,
    pub current_arc_keywords: Vec<String>,
    pub current_arc_start_chapter: u32,
    pub recent_chapters: VecDeque<ChapterMemory>,
    pub closed_arcs: Vec<ClosedArcMemory>,
    pub expression_cooldown: Vec<String>,
    pub recent_scene_patterns: Vec<String>,
    pub continuity_fallback_count: u32,
}

impl NovelMetadata {
    pub fn new(lang: &str, total_ch: u32, seed: &str) -> Self {
        Self {
            title: "Novel".to_string(),
            language: lang.to_string(),
            num_chapters: total_ch,
            target_tokens: 0,
            current_chapter: 0,
            needs_memory_rebuild: false,
            plot_seed: seed.to_string(),
            plot_outline: String::new(),
            story_state: String::new(),
            character_state: String::new(),
            relationship_state: String::new(),
            current_arc: String::new(),
            current_arc_keywords: Vec::new(),
            current_arc_start_chapter: 1,
            recent_chapters: VecDeque::new(),
            closed_arcs: Vec::new(),
            expression_cooldown: Vec::new(),
            recent_scene_patterns: Vec::new(),
            continuity_fallback_count: 0,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct StreamEvent {
    pub content: String,
    pub is_finished: bool,
    pub error: Option<String>,
    pub status: Option<String>,
    pub is_chapter_preview: bool,
}

impl StreamEvent {
    pub(crate) fn full(
        content: String,
        is_finished: bool,
        error: Option<String>,
        status: Option<String>,
    ) -> Self {
        Self {
            content,
            is_finished,
            error,
            status,
            is_chapter_preview: false,
        }
    }

    pub(crate) fn chapter_preview(content: String, status: String) -> Self {
        Self {
            content,
            is_finished: false,
            error: None,
            status: Some(status),
            is_chapter_preview: true,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct NovelGenerationResult {
    pub full_text: String,
    pub novel_filename: String,
    pub metadata: NovelMetadata,
}

#[derive(Deserialize)]
pub struct NovelGenerationParams {
    pub api_base: String,
    pub model_name: String,
    pub api_key: String,
    pub system_prompt: String,
    pub plot_outline: String,
    pub initial_text: String,
    pub start_chapter: u32,
    pub total_chapters: u32,
    pub target_tokens: u32,
    pub language: String,
    pub temperature: f32,
    pub top_p: f32,
    pub repetition_penalty: f32,
    pub plot_seed: String,
    pub novel_filename: Option<String>,
    pub recent_chapters: Option<VecDeque<ChapterMemory>>,
    pub story_state: Option<String>,
    pub character_state: Option<String>,
    pub relationship_state: Option<String>,
    pub current_arc: Option<String>,
    pub current_arc_keywords: Option<Vec<String>>,
    pub current_arc_start_chapter: Option<u32>,
    pub closed_arcs: Option<Vec<ClosedArcMemory>>,
    pub expression_cooldown: Option<Vec<String>>,
    pub recent_scene_patterns: Option<Vec<String>>,
    pub needs_memory_rebuild: Option<bool>,
    pub continuity_fallback_count: Option<u32>,
    pub prompt_templates: Option<PromptTemplateOverrides>,
}
