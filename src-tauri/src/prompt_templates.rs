use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

const DEFAULT_CHAPTER_SUMMARY_SYSTEM: &str = include_str!("../prompts/chapter_summary_system.txt");
const DEFAULT_CHAPTER_SUMMARY: &str = include_str!("../prompts/chapter_summary.txt");
const DEFAULT_CONTINUITY_SYSTEM: &str = include_str!("../prompts/continuity_system.txt");
const DEFAULT_CONTINUITY_UPDATE: &str = include_str!("../prompts/continuity_update.txt");
const DEFAULT_CONTINUITY_RETRY: &str = include_str!("../prompts/continuity_retry.txt");
const DEFAULT_SEED_EMPTY: &str = include_str!("../prompts/seed_empty.txt");
const DEFAULT_SEED_EXPAND: &str = include_str!("../prompts/seed_expand.txt");
const DEFAULT_NOVEL_CHAPTER: &str = include_str!("../prompts/novel_chapter.txt");
const DEFAULT_EXPRESSION_COOLDOWN: &str = include_str!("../prompts/expression_cooldown.txt");
const DEFAULT_EXPRESSION_COOLDOWN_PHRASES_KOREAN: &str =
    include_str!("../prompts/expression_cooldown_phrases_korean.txt");
const DEFAULT_EXPRESSION_COOLDOWN_PHRASES_JAPANESE: &str =
    include_str!("../prompts/expression_cooldown_phrases_japanese.txt");
const DEFAULT_EXPRESSION_COOLDOWN_PHRASES_ENGLISH: &str =
    include_str!("../prompts/expression_cooldown_phrases_english.txt");

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct PromptTemplateOverrides {
    pub chapter_summary_system: Option<String>,
    pub chapter_summary: Option<String>,
    pub continuity_system: Option<String>,
    pub continuity_update: Option<String>,
    pub continuity_retry: Option<String>,
    pub seed_empty: Option<String>,
    pub seed_expand: Option<String>,
    pub novel_chapter: Option<String>,
    pub expression_cooldown: Option<String>,
    pub expression_cooldown_phrases_korean: Option<String>,
    pub expression_cooldown_phrases_japanese: Option<String>,
    pub expression_cooldown_phrases_english: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PromptTemplates {
    pub chapter_summary_system: String,
    pub chapter_summary: String,
    pub continuity_system: String,
    pub continuity_update: String,
    pub continuity_retry: String,
    pub seed_empty: String,
    pub seed_expand: String,
    pub novel_chapter: String,
    pub expression_cooldown: String,
    pub expression_cooldown_phrases_korean: Vec<String>,
    pub expression_cooldown_phrases_japanese: Vec<String>,
    pub expression_cooldown_phrases_english: Vec<String>,
}

impl PromptTemplates {
    pub fn load(overrides: Option<&PromptTemplateOverrides>) -> Self {
        Self {
            chapter_summary_system: resolve_template(
                "chapter_summary_system",
                DEFAULT_CHAPTER_SUMMARY_SYSTEM,
                overrides.and_then(|item| item.chapter_summary_system.as_ref()),
            ),
            chapter_summary: resolve_template(
                "chapter_summary",
                DEFAULT_CHAPTER_SUMMARY,
                overrides.and_then(|item| item.chapter_summary.as_ref()),
            ),
            continuity_system: resolve_template(
                "continuity_system",
                DEFAULT_CONTINUITY_SYSTEM,
                overrides.and_then(|item| item.continuity_system.as_ref()),
            ),
            continuity_update: resolve_template(
                "continuity_update",
                DEFAULT_CONTINUITY_UPDATE,
                overrides.and_then(|item| item.continuity_update.as_ref()),
            ),
            continuity_retry: resolve_template(
                "continuity_retry",
                DEFAULT_CONTINUITY_RETRY,
                overrides.and_then(|item| item.continuity_retry.as_ref()),
            ),
            seed_empty: resolve_template(
                "seed_empty",
                DEFAULT_SEED_EMPTY,
                overrides.and_then(|item| item.seed_empty.as_ref()),
            ),
            seed_expand: resolve_template(
                "seed_expand",
                DEFAULT_SEED_EXPAND,
                overrides.and_then(|item| item.seed_expand.as_ref()),
            ),
            novel_chapter: resolve_template(
                "novel_chapter",
                DEFAULT_NOVEL_CHAPTER,
                overrides.and_then(|item| item.novel_chapter.as_ref()),
            ),
            expression_cooldown: resolve_template(
                "expression_cooldown",
                DEFAULT_EXPRESSION_COOLDOWN,
                overrides.and_then(|item| item.expression_cooldown.as_ref()),
            ),
            expression_cooldown_phrases_korean: resolve_phrase_list(
                "expression_cooldown_phrases_korean",
                DEFAULT_EXPRESSION_COOLDOWN_PHRASES_KOREAN,
                overrides.and_then(|item| item.expression_cooldown_phrases_korean.as_ref()),
            ),
            expression_cooldown_phrases_japanese: resolve_phrase_list(
                "expression_cooldown_phrases_japanese",
                DEFAULT_EXPRESSION_COOLDOWN_PHRASES_JAPANESE,
                overrides.and_then(|item| item.expression_cooldown_phrases_japanese.as_ref()),
            ),
            expression_cooldown_phrases_english: resolve_phrase_list(
                "expression_cooldown_phrases_english",
                DEFAULT_EXPRESSION_COOLDOWN_PHRASES_ENGLISH,
                overrides.and_then(|item| item.expression_cooldown_phrases_english.as_ref()),
            ),
        }
    }

    pub fn expression_cooldown_phrases(&self, language: &str) -> &[String] {
        match language {
            "Korean" => &self.expression_cooldown_phrases_korean,
            "Japanese" => &self.expression_cooldown_phrases_japanese,
            _ => &self.expression_cooldown_phrases_english,
        }
    }
}

pub fn render_template(template: &str, values: &[(&str, String)]) -> String {
    let mut rendered = template.to_string();
    for (key, value) in values {
        rendered = rendered.replace(&format!("{{{{{}}}}}", key), value);
    }
    rendered
}

fn resolve_template(name: &str, default_text: &str, override_text: Option<&String>) -> String {
    if let Some(text) = override_text {
        if !text.trim().is_empty() {
            return text.clone();
        }
    }

    read_template_file(name).unwrap_or_else(|| default_text.to_string())
}

fn resolve_phrase_list(name: &str, default_text: &str, override_text: Option<&String>) -> Vec<String> {
    let text = override_text
        .filter(|text| !text.trim().is_empty())
        .cloned()
        .or_else(|| read_template_file(name))
        .unwrap_or_else(|| default_text.to_string());

    parse_phrase_list(&text)
}

fn parse_phrase_list(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

fn read_template_file(name: &str) -> Option<String> {
    let filename = format!("{}.txt", name);
    for dir in prompt_search_dirs() {
        let path = dir.join(&filename);
        if let Ok(text) = fs::read_to_string(&path) {
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }

    None
}

fn prompt_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("prompts"));
        dirs.push(cwd.join("src-tauri").join("prompts"));
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            dirs.push(exe_dir.join("prompts"));
        }
    }

    dirs
}
