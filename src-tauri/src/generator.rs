use crate::continuity_json::{
    char_bigrams, parse_continuity_payload, sanitize_keywords, ContinuityUpdatePayload,
};
use crate::paths::get_base_dir;
use crate::plot_structure::{
    extract_novel_title, planned_arc_guidance_for_chapter, split_plot_into_arc_boundaries,
    PlotArcBoundary,
};
use crate::prompt_templates::{render_template, PromptTemplateOverrides, PromptTemplates};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::time::{sleep, timeout};

// Pre-compiled Regexes for performance
static RE_CHAPTER_PLOT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:Chapter\s*(\d+)|제?\s*(\d+)\s*장|第?\s*(\d+)\s*章)").unwrap()
});
static RE_GEN_ERROR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\n\n\[Generation Stopped/Error\].*$").unwrap());
static RE_CH_KOREAN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|\n)[#\s*]*제?\s*(\d+)\s*[장]").unwrap());
static RE_CH_JAPANESE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|\n)[#\s*]*第?\s*(\d+)\s*[장章]").unwrap());
static RE_CH_ENGLISH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|\n)[#\s*]*Chapter\s*(\d+)").unwrap());
static RE_THOUGHT_FULL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<\|channel>thought.*?<channel\|>").unwrap());
static RE_THOUGHT_UNCLOSED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<\|channel>thought.*$").unwrap());
static RE_THOUGHT_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<thought>.*?</thought>").unwrap());
static RE_THOUGHT_OPEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<thought>.*$").unwrap());
static CHAT_CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .expect("failed to build shared chat completion client")
});

const RECENT_CHAPTER_LIMIT: usize = 4;
const EXPRESSION_COOLDOWN_CHAPTER_LIMIT: usize = 4;
const EXPRESSION_COOLDOWN_LIMIT: usize = 8;
const HARD_EXPRESSION_COOLDOWN_COUNT: usize = 10;
const STRONG_EXPRESSION_COOLDOWN_COUNT: usize = 5;
const REBUILD_SUMMARY_PAUSE_MS_LOCAL: u64 = 250;
const REBUILD_SUMMARY_PAUSE_MS_GOOGLE: u64 = 1500;
const CONTINUITY_UPDATE_MAX_ATTEMPTS: usize = 3;
const CONTINUITY_UPDATE_RETRY_DELAY_MS: u64 = 1000;
const CONTINUITY_FALLBACK_WARNING_THRESHOLD: u32 = 3;
const DIRECT_PRECEDING_TAIL_CHARS: usize = 1200;
const SUMMARY_INPUT_CHARS_PER_TARGET_TOKEN: usize = 4;
const SUMMARY_INPUT_MIN_CHARS: usize = 4000;
const SUMMARY_INPUT_MAX_CHARS: usize = 120_000;
const SUMMARY_OUTPUT_MAX_TOKENS: u32 = 2000;

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
    pub current_chapter: u32,
    pub needs_memory_rebuild: bool,
    pub plot_seed: String,
    pub plot_outline: String,
    pub story_state: String,
    pub character_state: String,
    pub current_arc: String,
    pub current_arc_keywords: Vec<String>,
    pub current_arc_start_chapter: u32,
    pub recent_chapters: VecDeque<ChapterMemory>,
    pub closed_arcs: Vec<ClosedArcMemory>,
    pub expression_cooldown: Vec<String>,
    pub continuity_fallback_count: u32,
}

impl NovelMetadata {
    pub fn new(lang: &str, total_ch: u32, seed: &str) -> Self {
        Self {
            title: "Novel".to_string(),
            language: lang.to_string(),
            num_chapters: total_ch,
            current_chapter: 0,
            needs_memory_rebuild: false,
            plot_seed: seed.to_string(),
            plot_outline: String::new(),
            story_state: String::new(),
            character_state: String::new(),
            current_arc: String::new(),
            current_arc_keywords: Vec::new(),
            current_arc_start_chapter: 1,
            recent_chapters: VecDeque::new(),
            closed_arcs: Vec::new(),
            expression_cooldown: Vec::new(),
            continuity_fallback_count: 0,
        }
    }
}

pub fn split_plot_into_chapters(plot_text: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let matches: Vec<_> = RE_CHAPTER_PLOT.captures_iter(plot_text).collect();
    for i in 0..matches.len() {
        let cap = &matches[i];
        // Try to get number from any of the capture groups
        let num: u32 = cap
            .get(1)
            .or(cap.get(2))
            .or(cap.get(3))
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);

        let start = cap.get(0).unwrap().end();
        let end = if i + 1 < matches.len() {
            matches[i + 1].get(0).unwrap().start()
        } else {
            plot_text.len()
        };

        if num > 0 {
            map.insert(num, plot_text[start..end].trim().to_string());
        }
    }
    map
}

pub fn split_full_text_into_chapters(text: &str, lang: &str) -> HashMap<u32, String> {
    let mut chapters = HashMap::new();
    // Removed error messages before splitting
    let contents = RE_GEN_ERROR.replace_all(text, "");

    let pattern = match lang {
        "Korean" => &RE_CH_KOREAN,
        "Japanese" => &RE_CH_JAPANESE,
        _ => &RE_CH_ENGLISH,
    };

    let matches: Vec<_> = pattern.captures_iter(&contents).collect();
    for i in 0..matches.len() {
        let cap = &matches[i];
        if let Some(m) = cap.get(1) {
            if let Ok(num) = m.as_str().parse::<u32>() {
                let start = cap.get(0).unwrap().end();
                let end = if i + 1 < matches.len() {
                    matches[i + 1].get(0).unwrap().start()
                } else {
                    contents.len()
                };
                chapters.insert(num, contents[start..end].trim().to_string());
            }
        }
    }
    chapters
}

fn summary_input_char_budget(target_tokens: u32) -> usize {
    let token_budget = target_tokens.saturating_add(1000).max(1000) as usize;
    token_budget
        .saturating_mul(SUMMARY_INPUT_CHARS_PER_TARGET_TOKEN)
        .clamp(SUMMARY_INPUT_MIN_CHARS, SUMMARY_INPUT_MAX_CHARS)
}

fn split_text_by_char_budget(text: &str, max_chars: usize) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let max_chars = max_chars.max(1);
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= max_chars {
        return vec![trimmed.to_string()];
    }

    let mut chunks = Vec::new();
    let mut start = 0;

    while start < chars.len() {
        let mut end = (start + max_chars).min(chars.len());

        if end < chars.len() {
            let min_split = start + (max_chars / 2).max(1);
            let split_at_newline = (min_split..end)
                .rev()
                .find(|idx| matches!(chars[*idx], '\n' | '\r'));
            let split_at_sentence = (min_split..end).rev().find(|idx| {
                matches!(
                    chars[*idx],
                    '.' | '!' | '?' | ';' | '。' | '！' | '？' | '…'
                )
            });

            if let Some(boundary) = split_at_newline.or(split_at_sentence) {
                end = (boundary + 1).min(chars.len());
            }
        }

        let chunk: String = chars[start..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        if !chunk.is_empty() {
            chunks.push(chunk);
        }

        start = end;
        while start < chars.len() && chars[start].is_whitespace() {
            start += 1;
        }
    }

    chunks
}

async fn summarize_text_with_templates(
    api_base: &str,
    model_name: &str,
    api_key: &str,
    summary_input: &str,
    language: &str,
    templates: &PromptTemplates,
) -> Result<String, String> {
    let prompt = render_template(
        &templates.chapter_summary,
        &[
            ("language", language.to_string()),
            ("chapter_text", summary_input.to_string()),
        ],
    );

    let mut attempts = 0;
    let max_attempts = 3;

    while attempts < max_attempts {
        match chat_completion(
            api_base,
            model_name,
            api_key,
            &templates.chapter_summary_system,
            &prompt,
            0.5,
            0.95,
            SUMMARY_OUTPUT_MAX_TOKENS,
            1.0,
        )
        .await
        {
            Ok(summary) => {
                if !summary.trim().is_empty() {
                    return Ok(summary);
                }
                println!(
                    "[Backend] Summary attempt {} returned empty content. Retrying...",
                    attempts + 1
                );
            }
            Err(e) => {
                println!(
                    "[Backend] Summary attempt {} failed: {}. Retrying...",
                    attempts + 1,
                    e
                );
            }
        }
        attempts += 1;
        if attempts < max_attempts {
            sleep(Duration::from_secs(1)).await;
        }
    }

    Err("Summary generation failed after 3 attempts.".to_string())
}

async fn summarize_chapter_with_templates(
    api_base: &str,
    model_name: &str,
    api_key: &str,
    chapter_text: &str,
    language: &str,
    target_tokens: u32,
    templates: &PromptTemplates,
) -> Result<String, String> {
    let char_budget = summary_input_char_budget(target_tokens);
    let chunks = split_text_by_char_budget(chapter_text, char_budget);

    if chunks.is_empty() {
        return Err("Cannot summarize an empty chapter.".to_string());
    }

    if chunks.len() == 1 {
        return summarize_text_with_templates(
            api_base, model_name, api_key, &chunks[0], language, templates,
        )
        .await;
    }

    println!(
        "[Backend] Chapter summary input has {} chars; splitting into {} chunks using target_tokens={} ({} chars/chunk).",
        chapter_text.chars().count(),
        chunks.len(),
        target_tokens,
        char_budget
    );

    let mut chunk_summaries = Vec::new();
    let total_chunks = chunks.len();

    for (idx, chunk) in chunks.iter().enumerate() {
        let part_input = format!("[Chapter part {}/{}]\n{}", idx + 1, total_chunks, chunk);
        let summary = summarize_text_with_templates(
            api_base,
            model_name,
            api_key,
            &part_input,
            language,
            templates,
        )
        .await
        .map_err(|err| {
            format!(
                "Summary generation failed for chapter part {}/{}: {}",
                idx + 1,
                total_chunks,
                err
            )
        })?;

        chunk_summaries.push(format!("Part {}:\n{}", idx + 1, summary.trim()));
    }

    Ok(chunk_summaries.join("\n\n"))
}

fn format_chapter_memories(chapters: &VecDeque<ChapterMemory>) -> String {
    if chapters.is_empty() {
        return "None yet.".to_string();
    }

    chapters
        .iter()
        .map(|entry| format!("Chapter {}:\n{}", entry.chapter, entry.summary.trim()))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn normalize_memory_item(raw: &str) -> String {
    raw.trim()
        .trim_start_matches(|c: char| matches!(c, '-' | '*' | '•' | ' ' | '\t'))
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '`'))
        .trim()
        .to_string()
}

fn memory_lines_from_text(text: &str) -> Vec<String> {
    text.lines()
        .map(normalize_memory_item)
        .filter(|line| !line.is_empty())
        .collect()
}

fn format_story_state(items: &[String]) -> String {
    let mut normalized = Vec::new();

    for item in items {
        let cleaned = normalize_memory_item(item);
        if cleaned.is_empty() {
            continue;
        }

        let upper = cleaned.to_uppercase();
        if upper.starts_with("FACT:") || upper.starts_with("OPEN:") {
            normalized.push(format!("- {}", cleaned));
        } else {
            normalized.push(format!("- OPEN: {}", cleaned));
        }
    }

    if normalized.is_empty() {
        "None yet.".to_string()
    } else {
        normalized.join("\n")
    }
}

fn format_character_state(items: &[String]) -> String {
    let mut normalized = Vec::new();

    for item in items {
        let cleaned = normalize_memory_item(item);
        if cleaned.is_empty() {
            continue;
        }

        let upper = cleaned.to_uppercase();
        if upper.starts_with("CHAR:") {
            normalized.push(format!("- {}", cleaned));
        } else {
            normalized.push(format!("- CHAR: {}", cleaned));
        }
    }

    normalized.join("\n")
}

fn format_arc_memory(items: &[String]) -> String {
    let mut normalized = Vec::new();

    for item in items {
        let cleaned = normalize_memory_item(item);
        if cleaned.is_empty() {
            continue;
        }

        let upper = cleaned.to_uppercase();
        if upper.starts_with("ARC:") {
            normalized.push(format!("- {}", cleaned));
        } else {
            normalized.push(format!("- ARC: {}", cleaned));
        }
    }

    if normalized.is_empty() {
        String::new()
    } else {
        normalized.join("\n")
    }
}

fn cooldown_threshold(phrase: &str) -> usize {
    let len = phrase.chars().count();
    if len <= 2 {
        8
    } else if len <= 4 {
        4
    } else {
        3
    }
}

fn recent_text_for_expression_cooldown_from_chapters(
    full_text: &str,
    chapters: &HashMap<u32, String>,
) -> String {
    if chapters.is_empty() {
        return full_text
            .chars()
            .rev()
            .take(20000)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }

    let mut chapter_numbers: Vec<u32> = chapters.keys().cloned().collect();
    chapter_numbers.sort_unstable();
    let start = chapter_numbers
        .len()
        .saturating_sub(EXPRESSION_COOLDOWN_CHAPTER_LIMIT);

    chapter_numbers[start..]
        .iter()
        .filter_map(|chapter| chapters.get(chapter))
        .cloned()
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn strip_dialogue_for_expression_cooldown(text: &str) -> String {
    let mut stripped = String::with_capacity(text.len());
    let mut quote_stack: Vec<char> = Vec::new();

    for ch in text.chars() {
        if let Some(close_quote) = quote_stack.last().copied() {
            if ch == close_quote {
                quote_stack.pop();
            }
            stripped.push(if ch == '\n' { '\n' } else { ' ' });
            continue;
        }

        let close_quote = match ch {
            '"' => Some('"'),
            '“' => Some('”'),
            '「' => Some('」'),
            '『' => Some('』'),
            '«' => Some('»'),
            _ => None,
        };

        if let Some(close_quote) = close_quote {
            quote_stack.push(close_quote);
            stripped.push(' ');
        } else {
            stripped.push(ch);
        }
    }

    stripped
}

fn build_expression_cooldown_from_chapters(
    full_text: &str,
    chapters: &HashMap<u32, String>,
    language: &str,
    templates: &PromptTemplates,
) -> Vec<String> {
    let recent_text = recent_text_for_expression_cooldown_from_chapters(full_text, chapters);
    let narration_text = strip_dialogue_for_expression_cooldown(&recent_text);
    build_expression_cooldown_from_text(&narration_text, language, templates)
}

fn build_expression_cooldown_from_text(
    recent_text: &str,
    language: &str,
    templates: &PromptTemplates,
) -> Vec<String> {
    if recent_text.trim().is_empty() {
        return Vec::new();
    }

    let mut items = templates
        .expression_cooldown_phrases(language)
        .iter()
        .filter_map(|phrase| {
            let count = recent_text.matches(phrase).count();
            if count >= cooldown_threshold(phrase) {
                Some((phrase.clone(), count))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    items.sort_by(|(left_phrase, left_count), (right_phrase, right_count)| {
        right_count
            .cmp(left_count)
            .then_with(|| left_phrase.cmp(right_phrase))
    });

    items
        .into_iter()
        .take(EXPRESSION_COOLDOWN_LIMIT)
        .map(|(phrase, count)| format_expression_cooldown_item(&phrase, count))
        .collect()
}

fn expression_cooldown_level(count: usize) -> &'static str {
    if count >= HARD_EXPRESSION_COOLDOWN_COUNT {
        "hard cooldown"
    } else if count >= STRONG_EXPRESSION_COOLDOWN_COUNT {
        "strong cooldown"
    } else {
        "soft cooldown"
    }
}

fn format_expression_cooldown_item(phrase: &str, count: usize) -> String {
    format!(
        "{} ({}: recently used {} times)",
        phrase,
        expression_cooldown_level(count),
        count
    )
}

fn format_expression_cooldown(items: &[String]) -> String {
    items
        .iter()
        .map(|item| normalize_memory_item(item))
        .filter(|item| !item.is_empty())
        .take(EXPRESSION_COOLDOWN_LIMIT)
        .map(|item| format!("- {}", item))
        .collect::<Vec<_>>()
        .join("\n")
}

fn memory_text_has_signal(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("none yet.")
}

fn compact_memory_is_empty(meta: &NovelMetadata) -> bool {
    meta.recent_chapters.is_empty()
        && meta.closed_arcs.is_empty()
        && !memory_text_has_signal(&meta.story_state)
        && !memory_text_has_signal(&meta.character_state)
        && !memory_text_has_signal(&meta.current_arc)
}

fn has_previous_chapter_summary(meta: &NovelMetadata, start_chapter: u32) -> bool {
    if start_chapter <= 1 {
        return true;
    }

    let previous_chapter = start_chapter.saturating_sub(1);
    meta.recent_chapters
        .iter()
        .any(|entry| entry.chapter == previous_chapter && !entry.summary.trim().is_empty())
}

fn should_reconstruct_context(meta: &NovelMetadata, start_chapter: u32) -> bool {
    if start_chapter <= 1 {
        return false;
    }

    if compact_memory_is_empty(meta) {
        return true;
    }

    if !has_previous_chapter_summary(meta, start_chapter) {
        return true;
    }

    if !meta.needs_memory_rebuild {
        return false;
    }

    meta.continuity_fallback_count == 0
        || meta.continuity_fallback_count >= CONTINUITY_FALLBACK_WARNING_THRESHOLD
}

fn reconstruction_summary_pause(api_base: &str) -> Duration {
    if api_base.contains("googleapis.com") {
        Duration::from_millis(REBUILD_SUMMARY_PAUSE_MS_GOOGLE)
    } else {
        Duration::from_millis(REBUILD_SUMMARY_PAUSE_MS_LOCAL)
    }
}

fn truncate_for_log(text: &str, max_chars: usize) -> String {
    let mut truncated = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        truncated.push_str("...");
    }
    truncated
}

fn paragraph_boundary_end(chars: &[char], idx: usize) -> Option<usize> {
    if chars.get(idx) == Some(&'\n') && chars.get(idx + 1) == Some(&'\n') {
        Some(idx + 2)
    } else if chars.get(idx) == Some(&'\r')
        && chars.get(idx + 1) == Some(&'\n')
        && chars.get(idx + 2) == Some(&'\r')
        && chars.get(idx + 3) == Some(&'\n')
    {
        Some(idx + 4)
    } else {
        None
    }
}

fn tail_with_paragraph_boundary(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= max_chars {
        return trimmed.to_string();
    }

    let target_start = chars.len().saturating_sub(max_chars);
    let lookback_start = target_start.saturating_sub(max_chars);
    let mut start = target_start;

    for idx in (lookback_start..target_start).rev() {
        if let Some(boundary_end) = paragraph_boundary_end(&chars, idx) {
            start = boundary_end;
            break;
        }
    }

    if start == target_start {
        let min_remaining = (max_chars / 2).max(1);
        for idx in target_start..chars.len().saturating_sub(1) {
            if let Some(boundary_end) = paragraph_boundary_end(&chars, idx) {
                if chars.len().saturating_sub(boundary_end) >= min_remaining {
                    start = boundary_end;
                    break;
                }
            }
        }
    }

    while start < chars.len() && chars[start].is_whitespace() {
        start += 1;
    }

    chars[start..].iter().collect::<String>().trim().to_string()
}

struct ContinuityUpdateResult {
    payload: ContinuityUpdatePayload,
    used_fallback: bool,
}

async fn update_continuity_memory(
    api_base: &str,
    model_name: &str,
    api_key: &str,
    story_state: &str,
    character_state: &str,
    current_arc: &str,
    current_arc_start_chapter: u32,
    planned_arc_guidance: &str,
    recent_chapters: &VecDeque<ChapterMemory>,
    latest_summary: &ChapterMemory,
    language: &str,
    templates: &PromptTemplates,
) -> ContinuityUpdateResult {
    let base_prompt = render_template(
        &templates.continuity_update,
        &[
            ("language", language.to_string()),
            (
                "current_arc_start_chapter",
                current_arc_start_chapter.to_string(),
            ),
            (
                "story_state",
                if story_state.trim().is_empty() {
                    "None yet.".to_string()
                } else {
                    story_state.trim().to_string()
                },
            ),
            (
                "character_state",
                if character_state.trim().is_empty() {
                    "None yet.".to_string()
                } else {
                    character_state.trim().to_string()
                },
            ),
            (
                "current_arc",
                if current_arc.trim().is_empty() {
                    "None yet.".to_string()
                } else {
                    current_arc.trim().to_string()
                },
            ),
            ("planned_arc_guidance", planned_arc_guidance.to_string()),
            (
                "recent_chapter_summaries",
                format_chapter_memories(recent_chapters),
            ),
            ("latest_chapter", latest_summary.chapter.to_string()),
            ("latest_summary", latest_summary.summary.trim().to_string()),
        ],
    );

    let fallback_story_state_lines = if story_state.trim().is_empty() {
        vec![format!("OPEN: {}", latest_summary.summary.trim())]
    } else {
        memory_lines_from_text(story_state)
    };
    let fallback_character_state_lines = if character_state.trim().is_empty() {
        Vec::new()
    } else {
        memory_lines_from_text(character_state)
    };
    let fallback_current_arc_lines = if current_arc.trim().is_empty() {
        vec![format!("ARC: {}", latest_summary.summary.trim())]
    } else {
        memory_lines_from_text(current_arc)
    };
    let fallback_keywords = sanitize_keywords(&vec![latest_summary.summary.clone()]);
    let fallback_payload = || ContinuityUpdateResult {
        payload: ContinuityUpdatePayload {
            story_state: fallback_story_state_lines.clone(),
            character_state: fallback_character_state_lines.clone(),
            current_arc: fallback_current_arc_lines.clone(),
            current_arc_keywords: fallback_keywords.clone(),
            close_current_arc: false,
            closed_arc_summary: Vec::new(),
            closed_arc_keywords: Vec::new(),
        },
        used_fallback: true,
    };

    let mut retry_feedback: Option<String> = None;

    for attempt in 0..CONTINUITY_UPDATE_MAX_ATTEMPTS {
        let prompt = if let Some(feedback) = &retry_feedback {
            render_template(
                &templates.continuity_retry,
                &[
                    ("base_prompt", base_prompt.clone()),
                    ("feedback", feedback.clone()),
                ],
            )
        } else {
            base_prompt.clone()
        };

        match chat_completion(
            api_base,
            model_name,
            api_key,
            &templates.continuity_system,
            &prompt,
            0.2,
            0.9,
            2400,
            1.0,
        )
        .await
        {
            Ok(raw) => {
                if let Some(payload) = parse_continuity_payload(&raw) {
                    return ContinuityUpdateResult {
                        payload,
                        used_fallback: false,
                    };
                }

                let excerpt = truncate_for_log(&raw, 600);
                if attempt + 1 < CONTINUITY_UPDATE_MAX_ATTEMPTS {
                    println!(
                        "[Backend] Continuity payload attempt {} returned invalid JSON/schema. Retrying...",
                        attempt + 1
                    );
                    retry_feedback = Some(format!(
                        "The previous response was not a usable continuity payload. \
                        It must be a single valid JSON object with concise keyword arrays and no extra text. \
                        Previous response excerpt: {}",
                        excerpt
                    ));
                    sleep(Duration::from_millis(CONTINUITY_UPDATE_RETRY_DELAY_MS)).await;
                    continue;
                }

                println!(
                    "[Backend] Continuity payload parse failed after {} attempts. Falling back to conservative memory update. Last raw response: {}",
                    CONTINUITY_UPDATE_MAX_ATTEMPTS,
                    excerpt
                );
                return fallback_payload();
            }
            Err(error) => {
                if attempt + 1 < CONTINUITY_UPDATE_MAX_ATTEMPTS {
                    println!(
                        "[Backend] Continuity update attempt {} failed: {}. Retrying...",
                        attempt + 1,
                        error
                    );
                    retry_feedback = Some(format!(
                        "The previous attempt failed before producing a usable payload ({error}). \
                        Return exactly one valid JSON object that matches the schema."
                    ));
                    sleep(Duration::from_millis(CONTINUITY_UPDATE_RETRY_DELAY_MS)).await;
                    continue;
                }

                println!(
                    "[Backend] Continuity update request failed after {} attempts. Falling back to conservative memory update. Error: {}",
                    CONTINUITY_UPDATE_MAX_ATTEMPTS,
                    error
                );
                return fallback_payload();
            }
        }
    }

    fallback_payload()
}

fn select_relevant_closed_arc(
    closed_arcs: &[ClosedArcMemory],
    chapter_plot: Option<&String>,
    current_arc: &str,
    current_arc_keywords: &[String],
    current_arc_start_chapter: u32,
) -> Option<ClosedArcMemory> {
    if closed_arcs.is_empty() {
        return None;
    }

    let mut query_text = String::new();
    if let Some(plot) = chapter_plot {
        query_text.push_str(plot);
        query_text.push('\n');
    }
    query_text.push_str(current_arc);

    let query_keywords = sanitize_keywords(current_arc_keywords);
    let query_bigrams = char_bigrams(&query_text);
    if query_keywords.is_empty() && query_bigrams.is_empty() {
        return None;
    }

    let best = closed_arcs
        .iter()
        .filter(|arc| arc.end_chapter < current_arc_start_chapter)
        .map(|arc| {
            let (keyword_score, keyword_signal) =
                keyword_recall_score(&arc.keywords, &query_keywords);
            let arc_bigrams = char_bigrams(&arc.summary);
            let bigram_overlap = arc_bigrams.intersection(&query_bigrams).count() as i32;
            let score = keyword_score + bigram_overlap;
            (arc, score, keyword_signal, bigram_overlap)
        })
        .max_by_key(|(arc, score, _, _)| (*score, arc.end_chapter as i32));

    match best {
        Some((arc, _score, keyword_signal, bigram_overlap))
            if keyword_signal > 0 || bigram_overlap >= 2 =>
        {
            Some(arc.clone())
        }
        _ => None,
    }
}

fn latest_closed_arc_before_current(
    closed_arcs: &[ClosedArcMemory],
    current_arc_start_chapter: u32,
) -> Option<ClosedArcMemory> {
    closed_arcs
        .iter()
        .filter(|arc| arc.end_chapter < current_arc_start_chapter)
        .max_by_key(|arc| (arc.end_chapter, arc.start_chapter))
        .cloned()
}

fn closed_arc_matches_boundary(arc: &ClosedArcMemory, boundary: &PlotArcBoundary) -> bool {
    arc.end_chapter == boundary.end_chapter
        || (arc.start_chapter <= boundary.start_chapter && arc.end_chapter >= boundary.end_chapter)
}

fn due_planned_arc_boundary<'a>(
    boundaries: &'a [PlotArcBoundary],
    meta: &NovelMetadata,
    current_chapter: u32,
    total_chapters: u32,
) -> Option<&'a PlotArcBoundary> {
    let active_start = meta.current_arc_start_chapter.max(1);

    boundaries
        .iter()
        .filter(|boundary| boundary.end_chapter < total_chapters)
        .filter(|boundary| boundary.end_chapter <= current_chapter)
        .filter(|boundary| boundary.end_chapter >= active_start)
        .filter(|boundary| {
            !meta
                .closed_arcs
                .iter()
                .any(|arc| closed_arc_matches_boundary(arc, boundary))
        })
        .min_by_key(|boundary| boundary.end_chapter)
}

fn push_unique_arc_item(items: &mut Vec<String>, seen: &mut HashSet<String>, raw: &str) {
    let cleaned = normalize_memory_item(raw);
    if cleaned.is_empty() {
        return;
    }

    let key = cleaned
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect::<String>();
    if key.is_empty() || !seen.insert(key) {
        return;
    }

    items.push(cleaned);
}

fn keyword_match_key(text: &str) -> String {
    text.chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn keyword_recall_score(arc_keywords: &[String], query_keywords: &[String]) -> (i32, i32) {
    let arc_keys = arc_keywords
        .iter()
        .map(|keyword| keyword_match_key(keyword))
        .filter(|key| !key.is_empty())
        .collect::<HashSet<_>>();
    let query_keys = query_keywords
        .iter()
        .map(|keyword| keyword_match_key(keyword))
        .filter(|key| !key.is_empty())
        .collect::<HashSet<_>>();

    let mut score = 0;
    let mut signal = 0;

    for query_key in &query_keys {
        if arc_keys.contains(query_key) {
            score += 100;
            signal += 1;
            continue;
        }

        let partial_match = arc_keys.iter().any(|arc_key| {
            query_key.chars().count() >= 3
                && arc_key.chars().count() >= 3
                && (query_key.contains(arc_key) || arc_key.contains(query_key))
        });
        if partial_match {
            score += 40;
            signal += 1;
        }
    }

    (score, signal)
}

fn closed_arc_summary_from_boundary(
    boundary: &PlotArcBoundary,
    fallback_arc_summary: &str,
    latest_summary: Option<&str>,
) -> String {
    let mut items = Vec::new();
    let mut seen = HashSet::new();

    for item in &boundary.summary_items {
        push_unique_arc_item(&mut items, &mut seen, item);
        if items.len() >= 3 {
            break;
        }
    }

    for item in memory_lines_from_text(fallback_arc_summary) {
        push_unique_arc_item(&mut items, &mut seen, &item);
        if items.len() >= 6 {
            break;
        }
    }

    if let Some(summary) = latest_summary {
        for item in memory_lines_from_text(summary) {
            push_unique_arc_item(&mut items, &mut seen, &item);
            if items.len() >= 8 {
                break;
            }
        }
    }

    if items.is_empty() {
        items.push(format!(
            "ARC: {} covered Chapters {}-{}.",
            boundary.name, boundary.start_chapter, boundary.end_chapter
        ));
    }

    format_arc_memory(&items)
}

fn closed_arc_keywords_from_boundary(
    boundary: &PlotArcBoundary,
    fallback_keywords: &[String],
) -> Vec<String> {
    let mut sources = Vec::new();
    sources.extend(fallback_keywords.iter().cloned());
    sources.extend(boundary.keywords.clone());
    if sources.is_empty() {
        sources.push(boundary.name.clone());
    }

    sanitize_keywords(&sources).into_iter().take(8).collect()
}

fn planned_boundary_for_chapter(
    boundaries: &[PlotArcBoundary],
    chapter: u32,
) -> Option<&PlotArcBoundary> {
    boundaries
        .iter()
        .find(|boundary| boundary.start_chapter <= chapter && chapter <= boundary.end_chapter)
        .or_else(|| {
            boundaries
                .iter()
                .filter(|boundary| boundary.start_chapter > chapter)
                .min_by_key(|boundary| boundary.start_chapter)
        })
}

fn ensure_current_arc_has_signal(
    meta: &mut NovelMetadata,
    boundaries: &[PlotArcBoundary],
    chapter: u32,
    total_chapters: u32,
    fallback_text: Option<&str>,
    fallback_keywords: &[String],
) {
    if chapter == 0 || chapter > total_chapters {
        return;
    }

    let boundary = planned_boundary_for_chapter(boundaries, chapter);

    if meta.current_arc.trim().is_empty() {
        let mut items = Vec::new();
        let mut seen = HashSet::new();

        if let Some(boundary) = boundary {
            push_unique_arc_item(
                &mut items,
                &mut seen,
                &format!(
                    "ARC: {} begins at Chapter {} and should carry forward the consequences of the previous arc.",
                    boundary.name, chapter
                ),
            );
            for item in &boundary.summary_items {
                push_unique_arc_item(&mut items, &mut seen, item);
                if items.len() >= 5 {
                    break;
                }
            }
        }

        if let Some(text) = fallback_text {
            for item in memory_lines_from_text(text) {
                push_unique_arc_item(&mut items, &mut seen, &item);
                if items.len() >= 6 {
                    break;
                }
            }
        }

        if items.is_empty() {
            items.push(format!(
                "ARC: Chapter {} starts the next active arc; carry forward the previous arc's consequences into the new objective.",
                chapter
            ));
        }

        meta.current_arc = format_arc_memory(&items);
    }

    if meta.current_arc_keywords.is_empty() {
        let mut sources = Vec::new();
        sources.extend(fallback_keywords.iter().cloned());
        if let Some(boundary) = boundary {
            sources.push(boundary.name.clone());
            sources.extend(boundary.keywords.clone());
            sources.extend(boundary.summary_items.clone());
        }
        if let Some(text) = fallback_text {
            sources.push(text.to_string());
        }
        sources.push(meta.current_arc.clone());

        meta.current_arc_keywords = sanitize_keywords(&sources).into_iter().take(8).collect();
        if meta.current_arc_keywords.is_empty() {
            meta.current_arc_keywords = vec!["active objective".to_string()];
        }
    }
}

fn sanitize_closed_arc_memory(mut arc: ClosedArcMemory) -> ClosedArcMemory {
    let mut sources = arc.keywords.clone();
    sources.push(arc.summary.clone());

    let keywords = sanitize_keywords(&sources)
        .into_iter()
        .take(8)
        .collect::<Vec<_>>();
    if !keywords.is_empty() {
        arc.keywords = keywords;
    }

    arc
}

fn close_due_planned_arcs(
    meta: &mut NovelMetadata,
    boundaries: &[PlotArcBoundary],
    current_chapter: u32,
    total_chapters: u32,
    fallback_arc_summary: &str,
    fallback_arc_keywords: &[String],
    latest_summary: Option<&str>,
    clear_current_arc_at_latest_boundary: bool,
) {
    while let Some(boundary) =
        due_planned_arc_boundary(boundaries, meta, current_chapter, total_chapters).cloned()
    {
        let start_chapter = meta
            .current_arc_start_chapter
            .max(1)
            .max(boundary.start_chapter)
            .min(boundary.end_chapter);
        let summary =
            closed_arc_summary_from_boundary(&boundary, fallback_arc_summary, latest_summary);
        let keywords = closed_arc_keywords_from_boundary(&boundary, fallback_arc_keywords);

        if !summary.trim().is_empty() {
            meta.closed_arcs.push(ClosedArcMemory {
                start_chapter,
                end_chapter: boundary.end_chapter,
                summary,
                keywords,
            });
        }

        meta.current_arc_start_chapter = boundary.end_chapter + 1;

        if clear_current_arc_at_latest_boundary && boundary.end_chapter == current_chapter {
            meta.current_arc.clear();
            meta.current_arc_keywords.clear();
        }
    }
}

fn save_generation_state_to_disk(
    meta: &NovelMetadata,
    novel_filename: &str,
    full_text: &str,
) -> Result<(), String> {
    let base = get_base_dir();
    let mut dir = base.clone();
    dir.push("output");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create output directory {:?}: {}", dir, e))?;
    }

    let txt_path = dir.join(novel_filename);
    let json_path = dir.join(novel_filename.replace(".txt", ".json"));

    fs::write(&txt_path, full_text)
        .map_err(|e| format!("Failed to write novel text to {:?}: {}", txt_path, e))?;

    let meta_json = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("Failed to serialize metadata for {:?}: {}", json_path, e))?;
    fs::write(&json_path, meta_json)
        .map_err(|e| format!("Failed to write metadata to {:?}: {}", json_path, e))?;

    Ok(())
}

async fn apply_chapter_memory_update(
    meta: &mut NovelMetadata,
    chapter_number: u32,
    chapter_summary: String,
    total_chapters: u32,
    plot_arc_boundaries: &[PlotArcBoundary],
    api_base: &str,
    model_name: &str,
    api_key: &str,
    language: &str,
    templates: &PromptTemplates,
) -> bool {
    let latest_summary = ChapterMemory {
        chapter: chapter_number,
        summary: chapter_summary,
    };

    meta.recent_chapters.push_back(latest_summary.clone());
    if meta.recent_chapters.len() > RECENT_CHAPTER_LIMIT {
        meta.recent_chapters.pop_front();
    }

    let previous_arc_summary = meta.current_arc.clone();
    let previous_arc_keywords = meta.current_arc_keywords.clone();
    let planned_arc_guidance = planned_arc_guidance_for_chapter(
        plot_arc_boundaries,
        meta.current_arc_start_chapter.max(1),
        chapter_number,
        total_chapters,
    );
    let continuity_result = update_continuity_memory(
        api_base,
        model_name,
        api_key,
        &meta.story_state,
        &meta.character_state,
        &meta.current_arc,
        meta.current_arc_start_chapter.max(1),
        &planned_arc_guidance,
        &meta.recent_chapters,
        &latest_summary,
        language,
        templates,
    )
    .await;
    let continuity = continuity_result.payload;

    meta.story_state = format_story_state(&continuity.story_state);
    meta.character_state = format_character_state(&continuity.character_state);
    meta.current_arc = format_arc_memory(&continuity.current_arc);
    meta.current_arc_keywords = sanitize_keywords(&continuity.current_arc_keywords);
    if continuity_result.used_fallback {
        meta.continuity_fallback_count = meta.continuity_fallback_count.saturating_add(1);
    } else {
        meta.continuity_fallback_count = 0;
    }
    meta.needs_memory_rebuild =
        meta.continuity_fallback_count >= CONTINUITY_FALLBACK_WARNING_THRESHOLD;

    if continuity.close_current_arc && chapter_number < total_chapters {
        let closed_summary = if continuity.closed_arc_summary.is_empty() {
            previous_arc_summary.trim().to_string()
        } else {
            format_arc_memory(&continuity.closed_arc_summary)
        };

        if !closed_summary.trim().is_empty() {
            meta.closed_arcs.push(ClosedArcMemory {
                start_chapter: meta.current_arc_start_chapter.max(1),
                end_chapter: chapter_number,
                summary: closed_summary,
                keywords: {
                    let keyword_sources = previous_arc_keywords
                        .iter()
                        .cloned()
                        .chain(continuity.closed_arc_keywords.iter().cloned())
                        .collect::<Vec<_>>();
                    let keywords = sanitize_keywords(&keyword_sources);
                    if keywords.is_empty() {
                        previous_arc_keywords.clone()
                    } else {
                        keywords
                    }
                },
            });
        }

        meta.current_arc_start_chapter = chapter_number + 1;
    }

    close_due_planned_arcs(
        meta,
        plot_arc_boundaries,
        chapter_number,
        total_chapters,
        &previous_arc_summary,
        &previous_arc_keywords,
        Some(&latest_summary.summary),
        true,
    );

    ensure_current_arc_has_signal(
        meta,
        plot_arc_boundaries,
        if chapter_number < total_chapters {
            chapter_number.saturating_add(1)
        } else {
            chapter_number
        },
        total_chapters,
        Some(&latest_summary.summary),
        &previous_arc_keywords,
    );

    continuity_result.used_fallback
}

#[derive(Deserialize)]
pub struct ModelList {
    pub data: Vec<ModelData>,
}

#[derive(Deserialize, Clone)]
pub struct ModelData {
    pub id: String,
}

pub const LM_STUDIO_MODELS: &[&str] = &[
    "unsloth/gemma-4-31b-it",
    "unsloth/gemma-4-26b-a4b-it",
    "qwen/qwen3.5-35b-a3b",
    "qwen3.5-27b",
];

pub const GOOGLE_MODELS: &[&str] = &[
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemma-4-26b-a4b-it",
    "gemma-4-31b-it",
];

pub fn clean_thought_tags(text: &str) -> String {
    // Ported from app.py: Remove internal reasoning tags like <|channel>thought ... <channel|>
    // 1. Complete blocks
    let text = RE_THOUGHT_FULL.replace_all(text, "");

    // 2. Unclosed blocks at the end of a stream
    let text = RE_THOUGHT_UNCLOSED.replace_all(&text, "");

    // 3. Alternative <thought> tags
    let text = RE_THOUGHT_BLOCK.replace_all(&text, "");
    let text = RE_THOUGHT_OPEN.replace_all(&text, "");

    // 4. Individual leaked tokens
    text.replace("<|channel>thought", "")
        .replace("<channel|>", "")
        .replace("<|thought|>", "")
        .replace("<thought>", "")
        .replace("</thought>", "")
        .trim()
        .to_string()
}

pub async fn fetch_models_impl(api_base: &str) -> Result<Vec<String>, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let url = if api_base.ends_with('/') {
        format!("{}models", api_base)
    } else {
        format!("{}/models", api_base)
    };

    let fallback_models = if api_base.contains("googleapis.com") {
        GOOGLE_MODELS.iter().map(|&s| s.to_string()).collect()
    } else {
        LM_STUDIO_MODELS.iter().map(|&s| s.to_string()).collect()
    };

    match client.get(&url).send().await {
        Ok(res) => {
            if res.status().is_success() {
                if let Ok(model_list) = res.json::<ModelList>().await {
                    let mut models: Vec<String> =
                        model_list.data.into_iter().map(|m| m.id).collect();
                    models.sort();
                    if !models.is_empty() {
                        return Ok(models);
                    }
                }
            }
            Ok(fallback_models)
        }
        Err(_) => Ok(fallback_models),
    }
}

pub async fn generate_seed_impl(
    api_base: &str,
    model_name: &str,
    api_key: &str,
    system_prompt: &str,
    language: &str,
    temperature: f32,
    top_p: f32,
    input_seed: &str,
) -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap();
    let prompt_templates = PromptTemplates::load(None);

    let prompt = if input_seed.trim().is_empty() {
        render_template(
            &prompt_templates.seed_empty,
            &[("language", language.to_string())],
        )
    } else {
        render_template(
            &prompt_templates.seed_expand,
            &[
                ("language", language.to_string()),
                ("input_seed", input_seed.to_string()),
            ],
        )
    };

    let url = format!("{}/chat/completions", api_base.trim_end_matches('/'));
    let request_body = json!({
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ],
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": 2000
    });

    let res = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let response_json: Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if status.is_success() {
        if let Some(content) = response_json["choices"][0]["message"]["content"].as_str() {
            Ok(clean_thought_tags(content))
        } else {
            Err(format!("Invalid response format: {}", response_json))
        }
    } else {
        let err_msg = response_json["error"]["message"]
            .as_str()
            .or(response_json["message"].as_str())
            .unwrap_or("Unknown API error");
        Err(format!("API Error ({}): {}", status, err_msg))
    }
}

pub async fn chat_completion(
    api_base: &str,
    model_name: &str,
    api_key: &str,
    system_prompt: &str,
    prompt: &str,
    temperature: f32,
    top_p: f32,
    max_tokens: u32,
    repetition_penalty: f32,
) -> Result<String, String> {
    let client = &*CHAT_CLIENT;
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
    let response_json: Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if status.is_success() {
        if let Some(content) = response_json["choices"][0]["message"]["content"].as_str() {
            Ok(clean_thought_tags(content))
        } else {
            Err(format!("Invalid response format: {}", response_json))
        }
    } else {
        let err_msg = response_json["error"]["message"]
            .as_str()
            .or(response_json["message"].as_str())
            .unwrap_or_else(|| "Unknown API error (Check API key or parameters)");
        Err(format!("API Error ({}): {}", status, err_msg))
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
    fn full(
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

    fn chapter_preview(content: String, status: String) -> Self {
        Self {
            content,
            is_finished: false,
            error: None,
            status: Some(status),
            is_chapter_preview: true,
        }
    }
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
    pub current_arc: Option<String>,
    pub current_arc_keywords: Option<Vec<String>>,
    pub current_arc_start_chapter: Option<u32>,
    pub closed_arcs: Option<Vec<ClosedArcMemory>>,
    pub expression_cooldown: Option<Vec<String>>,
    pub needs_memory_rebuild: Option<bool>,
    pub continuity_fallback_count: Option<u32>,
    pub prompt_templates: Option<PromptTemplateOverrides>,
}

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

    // If starting from chapter 1, clean up all existing metadata to avoid cross-contamination
    if params.start_chapter == 1 {
        let mut dir = get_base_dir();
        dir.push("output");
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("json") {
                    let _ = fs::remove_file(path);
                }
            }
        }
    }

    // 1. Initial State / Reconstruction
    let mut meta = NovelMetadata::new(&params.language, params.total_chapters, &params.plot_seed);
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

    // Ported from app.py: If generation successfully reached the final chapter, delete metadata
    if meta.current_chapter >= params.total_chapters {
        let base = get_base_dir();
        let mut dir = base.clone();
        dir.push("output");
        let json_path = dir.join(novel_filename.replace(".txt", ".json"));
        if json_path.exists() {
            let _ = fs::remove_file(json_path);
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

#[cfg(test)]
mod tests {
    use super::*;

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
