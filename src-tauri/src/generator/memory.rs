use super::api::chat_completion;
use super::text::{split_text_by_char_budget, summary_input_char_budget};
use super::types::{ChapterMemory, ClosedArcMemory, NovelMetadata};
use crate::continuity_json::{
    char_bigrams, parse_continuity_payload, sanitize_keywords, ContinuityUpdatePayload,
};
use crate::paths::{novel_metadata_filename, output_dir, output_json_dir};
use crate::plot_structure::{planned_arc_guidance_for_chapter, PlotArcBoundary};
use crate::prompt_templates::{render_template, PromptTemplates};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::time::Duration;
use tokio::time::sleep;

const RECENT_CHAPTER_LIMIT: usize = 4;
const RECENT_BEAT_COOLDOWN_CHAPTER_LIMIT: usize = 3;
const RECENT_BEAT_COOLDOWN_LIMIT: usize = 8;
const RECENT_BEAT_COOLDOWN_ITEM_MAX_CHARS: usize = 220;
const EXPRESSION_COOLDOWN_CHAPTER_LIMIT: usize = 4;
const EXPRESSION_COOLDOWN_LIMIT: usize = 8;
const HARD_EXPRESSION_COOLDOWN_COUNT: usize = 10;
const STRONG_EXPRESSION_COOLDOWN_COUNT: usize = 5;
const REBUILD_SUMMARY_PAUSE_MS_LOCAL: u64 = 250;
const REBUILD_SUMMARY_PAUSE_MS_GOOGLE: u64 = 1500;
const CONTINUITY_UPDATE_MAX_ATTEMPTS: usize = 3;
const CONTINUITY_UPDATE_RETRY_DELAY_MS: u64 = 1000;
pub(crate) const CONTINUITY_FALLBACK_WARNING_THRESHOLD: u32 = 3;
const SUMMARY_OUTPUT_MAX_TOKENS: u32 = 2000;

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

pub(crate) async fn summarize_chapter_with_templates(
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

pub(crate) fn strip_dialogue_for_expression_cooldown(text: &str) -> String {
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

pub(crate) fn build_expression_cooldown_from_chapters(
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

pub(crate) fn format_expression_cooldown(items: &[String]) -> String {
    items
        .iter()
        .map(|item| normalize_memory_item(item))
        .filter(|item| !item.is_empty())
        .take(EXPRESSION_COOLDOWN_LIMIT)
        .map(|item| format!("- {}", item))
        .collect::<Vec<_>>()
        .join("\n")
}

fn trim_to_char_limit(text: &str, limit: usize) -> String {
    let mut trimmed = text.chars().take(limit).collect::<String>();
    if text.chars().count() > limit {
        trimmed.push_str("...");
    }
    trimmed
}

fn recent_summary_beat_lines(summary: &str) -> Vec<String> {
    summary
        .lines()
        .map(normalize_memory_item)
        .filter(|line| {
            let lower = line.to_lowercase();
            !line.is_empty()
                && lower != "none yet."
                && lower != "none"
                && line.chars().count() >= 12
        })
        .collect()
}

pub(crate) fn format_recent_beat_cooldown(chapters: &VecDeque<ChapterMemory>) -> String {
    if chapters.is_empty() {
        return String::new();
    }

    let mut seen = HashSet::new();
    let mut items = Vec::new();
    let start = chapters
        .len()
        .saturating_sub(RECENT_BEAT_COOLDOWN_CHAPTER_LIMIT);

    for entry in chapters.iter().skip(start) {
        for line in recent_summary_beat_lines(&entry.summary) {
            let key = line
                .chars()
                .filter(|ch| !ch.is_whitespace() && !ch.is_ascii_punctuation())
                .collect::<String>()
                .to_lowercase();
            if key.is_empty() || !seen.insert(key) {
                continue;
            }

            items.push(format!(
                "- Chapter {} beat to avoid replaying unchanged: {}",
                entry.chapter,
                trim_to_char_limit(&line, RECENT_BEAT_COOLDOWN_ITEM_MAX_CHARS)
            ));

            if items.len() >= RECENT_BEAT_COOLDOWN_LIMIT {
                break;
            }
        }

        if items.len() >= RECENT_BEAT_COOLDOWN_LIMIT {
            break;
        }
    }

    items.join("\n")
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

pub(crate) fn should_reconstruct_context(meta: &NovelMetadata, start_chapter: u32) -> bool {
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

pub(crate) fn reconstruction_summary_pause(api_base: &str) -> Duration {
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

pub(crate) fn select_relevant_closed_arc(
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

pub(crate) fn latest_closed_arc_before_current(
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

pub(crate) fn ensure_current_arc_has_signal(
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

pub(crate) fn sanitize_closed_arc_memory(mut arc: ClosedArcMemory) -> ClosedArcMemory {
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

pub(crate) fn close_due_planned_arcs(
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

pub(crate) fn save_generation_state_to_disk(
    meta: &NovelMetadata,
    novel_filename: &str,
    full_text: &str,
) -> Result<(), String> {
    let dir = output_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create output directory {:?}: {}", dir, e))?;
    }
    let json_dir = output_json_dir();
    if !json_dir.exists() {
        fs::create_dir_all(&json_dir)
            .map_err(|e| format!("Failed to create metadata directory {:?}: {}", json_dir, e))?;
    }

    let txt_path = dir.join(novel_filename);
    let json_path = json_dir.join(novel_metadata_filename(novel_filename));

    fs::write(&txt_path, full_text)
        .map_err(|e| format!("Failed to write novel text to {:?}: {}", txt_path, e))?;

    let meta_json = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("Failed to serialize metadata for {:?}: {}", json_path, e))?;
    fs::write(&json_path, meta_json)
        .map_err(|e| format!("Failed to write metadata to {:?}: {}", json_path, e))?;

    Ok(())
}

pub(crate) async fn apply_chapter_memory_update(
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
