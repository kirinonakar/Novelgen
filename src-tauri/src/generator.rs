use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use regex::Regex;
use std::fs;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::PathBuf;
use tokio::time::{timeout, sleep};

// Pre-compiled Regexes for performance
static RE_CHAPTER_PLOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:Chapter\s*(\d+)|제?\s*(\d+)\s*장|第?\s*(\d+)\s*章)").unwrap());
static RE_GEN_ERROR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)\n\n\[Generation Stopped/Error\].*$").unwrap());
static RE_CH_KOREAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|\n)[#\s*]*제?\s*(\d+)\s*[장]").unwrap());
static RE_CH_JAPANESE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|\n)[#\s*]*第?\s*(\d+)\s*[장章]").unwrap());
static RE_CH_ENGLISH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|\n)[#\s*]*Chapter\s*(\d+)").unwrap());
static RE_THOUGHT_FULL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<\|channel>thought.*?<channel\|>").unwrap());
static RE_THOUGHT_UNCLOSED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<\|channel>thought.*$").unwrap());
static RE_THOUGHT_BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<thought>.*?</thought>").unwrap());
static RE_THOUGHT_OPEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<thought>.*$").unwrap());
static RE_JSON_TRAILING_COMMA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",(\s*[}\]])").unwrap());

const RECENT_CHAPTER_LIMIT: usize = 4;
const REBUILD_SUMMARY_PAUSE_MS_LOCAL: u64 = 250;
const REBUILD_SUMMARY_PAUSE_MS_GOOGLE: u64 = 1500;

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
    pub current_arc: String,
    pub current_arc_keywords: Vec<String>,
    pub current_arc_start_chapter: u32,
    pub recent_chapters: Vec<ChapterMemory>,
    pub closed_arcs: Vec<ClosedArcMemory>,
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
            current_arc: String::new(),
            current_arc_keywords: Vec::new(),
            current_arc_start_chapter: 1,
            recent_chapters: Vec::new(),
            closed_arcs: Vec::new(),
        }
    }
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
struct ContinuityUpdatePayload {
    story_state: Vec<String>,
    current_arc: Vec<String>,
    current_arc_keywords: Vec<String>,
    close_current_arc: bool,
    closed_arc_summary: Vec<String>,
    closed_arc_keywords: Vec<String>,
}

pub fn split_plot_into_chapters(plot_text: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let matches: Vec<_> = RE_CHAPTER_PLOT.captures_iter(plot_text).collect();
    for i in 0..matches.len() {
        let cap = &matches[i];
        // Try to get number from any of the capture groups
        let num: u32 = cap.get(1).or(cap.get(2)).or(cap.get(3))
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

pub async fn summarize_chapter(
    api_base: &str, model_name: &str, api_key: &str, 
    chapter_text: &str, language: &str
) -> Result<String, String> {
    let prompt = format!(
        "Summarize the following chapter in {language} as 4-6 concise bullet points.\n\
        Focus only on key plot events, character changes, new facts, and unresolved developments that matter for continuity.\n\
        Output only bullet points.\n\n\
        Chapter Content:\n{}", chapter_text.chars().take(4000).collect::<String>()
    );
    
    let mut attempts = 0;
    let max_attempts = 3;
    
    while attempts < max_attempts {
        match chat_completion(api_base, model_name, api_key, "You are a professional novelist.", &prompt, 0.5, 0.95, 2000, 1.0).await {
            Ok(summary) => {
                if !summary.trim().is_empty() {
                    return Ok(summary);
                }
                println!("[Backend] Summary attempt {} returned empty content. Retrying...", attempts + 1);
            },
            Err(e) => {
                println!("[Backend] Summary attempt {} failed: {}. Retrying...", attempts + 1, e);
            }
        }
        attempts += 1;
        if attempts < max_attempts {
            sleep(Duration::from_secs(1)).await;
        }
    }

    Err("Summary generation failed after 3 attempts.".to_string())
}

fn format_chapter_memories(chapters: &[ChapterMemory]) -> String {
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

fn sanitize_keywords(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();

    for value in values {
        for part in value.split(|c: char| matches!(c, ',' | ';' | '/' | '|' | '\n')) {
            let allow_single_non_ascii = part
                .chars()
                .any(|c| c.is_alphanumeric() && !c.is_ascii());
            let normalized: String = part
                .trim()
                .trim_matches(|c: char| matches!(c, '-' | '*' | '•' | '[' | ']' | '(' | ')' | '{' | '}' | '"' | '\'' | '`'))
                .chars()
                .filter(|c| c.is_alphanumeric())
                .flat_map(|c| c.to_lowercase())
                .collect();

            if normalized.chars().count() < 2 && !allow_single_non_ascii {
                continue;
            }

            if seen.insert(normalized.clone()) {
                cleaned.push(normalized);
            }

            if cleaned.len() >= 12 {
                return cleaned;
            }
        }
    }

    cleaned
}

fn reconstruction_summary_pause(api_base: &str) -> Duration {
    if api_base.contains("googleapis.com") {
        Duration::from_millis(REBUILD_SUMMARY_PAUSE_MS_GOOGLE)
    } else {
        Duration::from_millis(REBUILD_SUMMARY_PAUSE_MS_LOCAL)
    }
}

fn normalized_char_stream(text: &str) -> Vec<char> {
    text.chars()
        .flat_map(|c| c.to_lowercase())
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn char_bigrams(text: &str) -> HashSet<String> {
    let chars = normalized_char_stream(text);
    if chars.len() < 2 {
        return HashSet::new();
    }

    chars
        .windows(2)
        .map(|window| window.iter().collect::<String>())
        .collect()
}

fn parse_continuity_payload(text: &str) -> Option<ContinuityUpdatePayload> {
    fn sanitize_model_json(raw: &str) -> String {
        let trimmed = raw
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```JSON")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .trim_matches('`')
            .trim()
            .replace('\u{feff}', "");

        let mut cleaned = trimmed;
        loop {
            let next = RE_JSON_TRAILING_COMMA.replace_all(&cleaned, "$1").to_string();
            if next == cleaned {
                return next;
            }
            cleaned = next;
        }
    }

    let sanitized_full = sanitize_model_json(text);

    serde_json::from_str::<ContinuityUpdatePayload>(&sanitized_full)
        .ok()
        .or_else(|| {
            let start = sanitized_full.find('{')?;
            let end = sanitized_full.rfind('}')?;
            let sliced = sanitize_model_json(&sanitized_full[start..=end]);
            serde_json::from_str::<ContinuityUpdatePayload>(&sliced).ok()
        })
}

async fn update_continuity_memory(
    api_base: &str,
    model_name: &str,
    api_key: &str,
    story_state: &str,
    current_arc: &str,
    current_arc_start_chapter: u32,
    recent_chapters: &[ChapterMemory],
    latest_summary: &ChapterMemory,
    language: &str,
) -> ContinuityUpdatePayload {
    let prompt = format!(
        "You maintain compact continuity memory for a serialized novel.\n\
        Update the continuity memory below using the latest chapter summary.\n\
        Write in {language}.\n\n\
        Return one valid JSON object only. Do not use markdown fences. Do not add any text before or after the JSON.\n\
        JSON schema:\n\
        {{\n\
          \"story_state\": [\"FACT: ...\", \"OPEN: ...\"],\n\
          \"current_arc\": [\"ARC: ...\"],\n\
          \"current_arc_keywords\": [\"keyword1\", \"keyword2\"],\n\
          \"close_current_arc\": false,\n\
          \"closed_arc_summary\": [\"ARC: ...\"],\n\
          \"closed_arc_keywords\": [\"keyword1\", \"keyword2\"]\n\
        }}\n\n\
        Rules:\n\
        - STORY_STATE: 8-14 bullets max.\n\
        - STORY_STATE is long-term canon memory. Every item must begin with either 'FACT:' or 'OPEN:'.\n\
        - Keep only durable facts needed for future continuity: goals, relationships, secrets, injuries, faction shifts, world-rule changes, unresolved promises, and active mysteries.\n\
        - Remove obsolete or fully resolved details.\n\
        - CURRENT_ARC: 5-8 bullets max.\n\
        - CURRENT_ARC is short-term arc memory. Every item must begin with 'ARC:'.\n\
        - The current arc started at Chapter {current_arc_start_chapter}.\n\
        - Focus CURRENT_ARC on the active objective, conflict, latest turning points, and what still remains unresolved inside this arc.\n\
        - current_arc_keywords must contain 3-8 concise canonical keywords for the active current arc. Prefer base forms and name/entity terms. Avoid particles or inflections.\n\
        - Decide whether the current major arc has meaningfully concluded by the end of the latest chapter.\n\
        - Set close_current_arc to true only if the arc's main short-term conflict or objective has genuinely reached a stopping point.\n\
        - If close_current_arc is true, fill closed_arc_summary with 4-8 'ARC:' items summarizing the finished arc, and fill closed_arc_keywords with 3-8 concise canonical keywords for that finished arc.\n\
        - If close_current_arc is false, closed_arc_summary and closed_arc_keywords must be empty arrays.\n\
        - If the latest chapter closes the previous arc and clearly establishes a new next arc, current_arc may describe that next arc. Otherwise current_arc may be an empty array.\n\
        - Do not move a short-lived scene detail into STORY_STATE unless it changes ongoing canon.\n\
        - If something is uncertain, keep it as OPEN or ARC rather than FACT.\n\
        - No prose paragraphs. No extra keys. No commentary.\n\n\
        Existing STORY_STATE:\n{}\n\n\
        Existing CURRENT_ARC:\n{}\n\n\
        Recent Chapter Summaries:\n{}\n\n\
        Latest Chapter Summary (Chapter {}):\n{}",
        if story_state.trim().is_empty() {
            "None yet."
        } else {
            story_state.trim()
        },
        if current_arc.trim().is_empty() {
            "None yet."
        } else {
            current_arc.trim()
        },
        format_chapter_memories(recent_chapters),
        latest_summary.chapter,
        latest_summary.summary.trim(),
    );

    let fallback_story_state_lines = if story_state.trim().is_empty() {
        vec![format!("OPEN: {}", latest_summary.summary.trim())]
    } else {
        memory_lines_from_text(story_state)
    };
    let fallback_current_arc_lines = if current_arc.trim().is_empty() {
        vec![format!("ARC: {}", latest_summary.summary.trim())]
    } else {
        memory_lines_from_text(current_arc)
    };
    let fallback_keywords = sanitize_keywords(&vec![latest_summary.summary.clone()]);

    match chat_completion(
        api_base,
        model_name,
        api_key,
        "You are a continuity editor for serialized fiction.",
        &prompt,
        0.2,
        0.9,
        1800,
        1.0,
    )
    .await
    {
        Ok(raw) => parse_continuity_payload(&raw).unwrap_or(ContinuityUpdatePayload {
            story_state: fallback_story_state_lines.clone(),
            current_arc: fallback_current_arc_lines.clone(),
            current_arc_keywords: fallback_keywords,
            close_current_arc: false,
            closed_arc_summary: Vec::new(),
            closed_arc_keywords: Vec::new(),
        }),
        Err(_) => ContinuityUpdatePayload {
            story_state: fallback_story_state_lines,
            current_arc: fallback_current_arc_lines,
            current_arc_keywords: fallback_keywords,
            close_current_arc: false,
            closed_arc_summary: Vec::new(),
            closed_arc_keywords: Vec::new(),
        },
    }
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

    let query_keywords: HashSet<String> = sanitize_keywords(current_arc_keywords).into_iter().collect();
    let query_bigrams = char_bigrams(&query_text);
    if query_keywords.is_empty() && query_bigrams.is_empty() {
        return None;
    }

    let best = closed_arcs
        .iter()
        .filter(|arc| arc.end_chapter < current_arc_start_chapter)
        .map(|arc| {
            let arc_keywords: HashSet<String> = arc.keywords.iter().cloned().collect();
            let keyword_overlap = arc_keywords.intersection(&query_keywords).count() as i32;
            let arc_bigrams = char_bigrams(&arc.summary);
            let bigram_overlap = arc_bigrams.intersection(&query_bigrams).count() as i32;
            let score = keyword_overlap * 100 + bigram_overlap;
            (arc, score, keyword_overlap, bigram_overlap)
        })
        .max_by_key(|(arc, score, _, _)| (*score, arc.end_chapter as i32));

    match best {
        Some((arc, _score, keyword_overlap, bigram_overlap))
            if keyword_overlap > 0 || bigram_overlap >= 2 =>
        {
            Some(arc.clone())
        }
        _ => None,
    }
}

fn save_generation_state_to_disk(meta: &NovelMetadata, novel_filename: &str, full_text: &str) -> Result<(), String> {
    let base = get_base_dir();
    let mut dir = base.clone();
    dir.push("output");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create output directory {:?}: {}", dir, e))?;
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
    api_base: &str,
    model_name: &str,
    api_key: &str,
    language: &str,
) {
    let latest_summary = ChapterMemory {
        chapter: chapter_number,
        summary: chapter_summary,
    };

    meta.recent_chapters.push(latest_summary.clone());
    if meta.recent_chapters.len() > RECENT_CHAPTER_LIMIT {
        meta.recent_chapters.remove(0);
    }

    let previous_arc_summary = meta.current_arc.clone();
    let previous_arc_keywords = meta.current_arc_keywords.clone();
    let continuity = update_continuity_memory(
        api_base,
        model_name,
        api_key,
        &meta.story_state,
        &meta.current_arc,
        meta.current_arc_start_chapter.max(1),
        &meta.recent_chapters,
        &latest_summary,
        language,
    )
    .await;

    meta.story_state = format_story_state(&continuity.story_state);
    meta.current_arc = format_arc_memory(&continuity.current_arc);
    meta.current_arc_keywords = sanitize_keywords(&continuity.current_arc_keywords);
    meta.needs_memory_rebuild = false;

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
                    let keywords = sanitize_keywords(&continuity.closed_arc_keywords);
                    if keywords.is_empty() {
                        previous_arc_keywords
                    } else {
                        keywords
                    }
                },
            });
        }

        meta.current_arc_start_chapter = chapter_number + 1;
    }
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

fn get_base_dir() -> PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("src-tauri").exists() || cwd.join("tauri.conf.json").exists() {
            return cwd;
        }
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            return exe_dir.to_path_buf();
        }
    }
    std::env::current_dir().unwrap_or_default()
}

pub async fn fetch_models_impl(api_base: &str) -> Result<Vec<String>, String> {
    let client = Client::builder().timeout(Duration::from_secs(5)).build().unwrap();
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
                    let mut models: Vec<String> = model_list.data.into_iter().map(|m| m.id).collect();
                    models.sort();
                    if !models.is_empty() { return Ok(models); }
                }
            }
            Ok(fallback_models)
        }
        Err(_) => Ok(fallback_models)
    }
}

pub async fn generate_seed_impl(
    api_base: &str, model_name: &str, api_key: &str, system_prompt: &str, 
    language: &str, temperature: f32, top_p: f32, input_seed: &str
) -> Result<String, String> {
    let client = Client::builder().timeout(Duration::from_secs(120)).build().unwrap();
    
    let prompt = if input_seed.trim().is_empty() {
        format!(
            "Based on your assigned writing style, genre, and persona in the system prompt, \
            brainstorm a highly creative, unique, and engaging initial plot seed (core idea) for a new novel. \
            Write the seed in {language}. Keep it concise (about 3-5 sentences). \
            Output ONLY the plot seed text. Do not include titles, greetings, meta-commentary, or any internal reasoning tags like <|channel>thought."
        )
    } else {
        format!(
            "Based on the following initial idea and your assigned writing style, refine and expand this into a highly creative, unique, and engaging plot seed for a new novel.\n\n\
            [Initial Idea]\n{}\n\n\
            Write the refined seed in {language}. Keep it concise (about 3-5 sentences). \
            Output ONLY the expanded plot seed text. Do not include titles, greetings, meta-commentary, or any internal reasoning tags like <|channel>thought.",
            input_seed
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

    let res = client.post(&url)
        .bearer_auth(api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let response_json: Value = res.json().await.map_err(|e| format!("Failed to parse response: {}", e))?;

    
    if status.is_success() {
        if let Some(content) = response_json["choices"][0]["message"]["content"].as_str() {
            Ok(clean_thought_tags(content))
        } else {
            Err(format!("Invalid response format: {}", response_json))
        }
    } else {
        let err_msg = response_json["error"]["message"].as_str()
            .or(response_json["message"].as_str())
            .unwrap_or("Unknown API error");
        Err(format!("API Error ({}): {}", status, err_msg))
    }
}

pub async fn chat_completion(
    api_base: &str, model_name: &str, api_key: &str, system_prompt: &str, prompt: &str,
    temperature: f32, top_p: f32, max_tokens: u32, repetition_penalty: f32
) -> Result<String, String> {
    let client = Client::builder().timeout(Duration::from_secs(180)).build().unwrap();
    let url = format!("{}/chat/completions", api_base.trim_end_matches('/'));
    
    let mut body_map = serde_json::Map::new();
    body_map.insert("model".to_string(), json!(model_name));
    body_map.insert("messages".to_string(), json!([
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt}
    ]));
    body_map.insert("temperature".to_string(), json!(temperature));
    body_map.insert("top_p".to_string(), json!(top_p));
    body_map.insert("max_tokens".to_string(), json!(max_tokens));

    if !api_base.contains("googleapis.com") {
        body_map.insert("repetition_penalty".to_string(), json!(repetition_penalty));
    }
    
    let request_body = Value::Object(body_map);

    let res = client.post(&url)
        .bearer_auth(api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let response_json: Value = res.json().await.map_err(|e| format!("Failed to parse response: {}", e))?;
    
    if status.is_success() {
        if let Some(content) = response_json["choices"][0]["message"]["content"].as_str() {
            Ok(clean_thought_tags(content))
        } else {
            Err(format!("Invalid response format: {}", response_json))
        }
    } else {
        let err_msg = response_json["error"]["message"].as_str()
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
    pub recent_chapters: Option<Vec<ChapterMemory>>,
    pub story_state: Option<String>,
    pub current_arc: Option<String>,
    pub current_arc_keywords: Option<Vec<String>>,
    pub current_arc_start_chapter: Option<u32>,
    pub closed_arcs: Option<Vec<ClosedArcMemory>>,
    pub needs_memory_rebuild: Option<bool>,
}

pub async fn generate_novel_stream(
    params: NovelGenerationParams,
    on_event: tauri::ipc::Channel<StreamEvent>,
    stop_flag: Arc<AtomicBool>,
) -> Result<String, String> {
    let client = Client::builder().build().unwrap();
    let url = format!("{}/chat/completions", params.api_base.trim_end_matches('/'));
    
    let mut full_text = if params.start_chapter == 1 { String::new() } else { params.initial_text.clone() };
    let chapter_plots = split_plot_into_chapters(&params.plot_outline);
    
    // Ensure we have a filename
    let novel_filename = params.novel_filename.unwrap_or_else(get_next_novel_filename);
    
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
    meta.plot_outline = params.plot_outline.clone();
    
    // Only use provided memory if we are resuming (start_chapter > 1)
    if params.start_chapter > 1 {
        if let Some(recent) = params.recent_chapters {
            meta.recent_chapters = recent;
        }
        if let Some(state) = params.story_state {
            meta.story_state = state;
        }
        if let Some(arc) = params.current_arc {
            meta.current_arc = arc;
        }
        if let Some(keywords) = params.current_arc_keywords {
            meta.current_arc_keywords = keywords;
        }
        if let Some(start) = params.current_arc_start_chapter {
            meta.current_arc_start_chapter = start.max(1);
        }
        if let Some(arcs) = params.closed_arcs {
            meta.closed_arcs = arcs;
        }
        if let Some(needs_rebuild) = params.needs_memory_rebuild {
            meta.needs_memory_rebuild = needs_rebuild;
        }
    }

    let needs_reconstruction = params.start_chapter > 1
        && (meta.needs_memory_rebuild
            || (meta.recent_chapters.is_empty()
                && meta.closed_arcs.is_empty()
                && meta.story_state.trim().is_empty()
                && meta.current_arc.trim().is_empty()));

    if needs_reconstruction {
        let _ = on_event.send(StreamEvent {
            content: full_text.clone(),
            is_finished: false,
            error: None,
            status: Some("🔄 Reconstructing context...".to_string()),
        });
        
        let chapters_map = split_full_text_into_chapters(&full_text, &params.language);
        let rebuild_target = params.start_chapter.saturating_sub(1);
        let rebuild_pause = reconstruction_summary_pause(&params.api_base);
        for ch in 1..params.start_chapter {
            let _ = on_event.send(StreamEvent {
                content: full_text.clone(),
                is_finished: false,
                error: None,
                status: Some(format!("🔄 Reconstructing context... ({}/{})", ch, rebuild_target)),
            });

            let content = chapters_map.get(&ch).cloned().unwrap_or_default();
            if content.trim().is_empty() {
                stop_flag.store(true, Ordering::Relaxed);
                let _ = on_event.send(StreamEvent {
                    content: full_text.clone(),
                    is_finished: true,
                    error: Some(format!(
                        "Context reconstruction failed: Chapter {} content is missing. Manual intervention is required before resuming.",
                        ch
                    )),
                    status: None,
                });
                return Ok(full_text);
            }

            let summary = match summarize_chapter(
                &params.api_base,
                &params.model_name,
                &params.api_key,
                &content,
                &params.language,
            )
            .await
            {
                Ok(summary) => summary,
                Err(err) => {
                    meta.needs_memory_rebuild = true;
                    let save_error = save_generation_state_to_disk(&meta, &novel_filename, &full_text).err();
                    if let Some(save_err) = &save_error {
                        eprintln!("[Backend] Failed to save reconstruction state: {}", save_err);
                    }
                    stop_flag.store(true, Ordering::Relaxed);
                    let _ = on_event.send(StreamEvent {
                        content: full_text.clone(),
                        is_finished: true,
                        error: Some(format!(
                            "Context reconstruction failed while summarizing Chapter {}: {} Manual intervention is required before resuming.{}",
                            ch,
                            err,
                            save_error
                                .as_ref()
                                .map(|msg| format!(" Also failed to save recovery state: {}", msg))
                                .unwrap_or_default()
                        )),
                        status: None,
                    });
                    return Ok(full_text);
                }
            };

            apply_chapter_memory_update(
                &mut meta,
                ch,
                summary,
                params.total_chapters,
                &params.api_base,
                &params.model_name,
                &params.api_key,
                &params.language,
            )
            .await;
            meta.current_chapter = ch;

            if ch < params.start_chapter - 1 {
                sleep(rebuild_pause).await;
            }
        }
        meta.needs_memory_rebuild = false;
    }
    
    if params.start_chapter > 1 {
        meta.current_chapter = params.start_chapter - 1;
    }

    // 2. Generation Loop
    for ch in params.start_chapter..=params.total_chapters {
        if stop_flag.load(Ordering::Relaxed) { break; }
        
        // Save state at the start of chapter to handle rollback on stop
        let chapter_start_backup = full_text.clone();

        let _ = on_event.send(StreamEvent {
            content: full_text.clone(),
            is_finished: false,
            error: None,
            status: Some(format!("Writing...({}/{})", ch, params.total_chapters)),
        });

        // Build hierarchical prompt
        let mut prompt = format!("You are a professional novelist writing a novel in {}.\n\n", params.language);
        prompt.push_str(&format!("[Book Information]\n- Total Chapters: {}\n", params.total_chapters));
        prompt.push_str(&format!("- Master Plot Outline:\n{}\n\n", params.plot_outline));
        prompt.push_str(&format!("CRITICAL INSTRUCTION:\n1. Write ONLY Chapter {}. Do not rush into future chapters.\n", ch));
        prompt.push_str(&format!("2. Target length: ~{} tokens.\n", params.target_tokens));
        prompt.push_str("3. Output ONLY the story text. No meta-talk.\n4. NEVER use internal reasoning tags or <|thought|> tokens.\n5. Treat the memory blocks below as literal continuity instructions, not loose inspiration.\n6. Do not reinterpret one block as serving the purpose of another block.\n\n");
        
        prompt.push_str(&format!("### CURRENT FOCUS: Chapter {} ###\n", ch));
        if let Some(ch_plot) = chapter_plots.get(&ch) {
            prompt.push_str(&format!("- Current Chapter Plot: {}\n\n", ch_plot));
        }

        prompt.push_str(
            "[Craft Rules]\n\
            - Strongly prefer show-don't-tell. Reveal emotions, realizations, and tensions through sensory detail, action, body language, atmosphere, and subtext before using abstract explanation.\n\
            - Do not flatten important moments into blunt summary statements such as 'the peace was fake' when you can dramatize them through uncanny sound, gesture, silence, setting, or contradiction.\n\
            - Avoid repetitive stock transition crutches such as '그때였다', '바로 그 순간', 'suddenly', or similar formulaic scene-turn phrases. Change pace through concrete interruption, discovery, motion, dialogue, sensory shift, or reaction instead of relying on the same connector.\n\
            - Do not over-explain distinctive setting mechanics or signature motifs as if reminding the reader of a glossary entry every chapter. If a character perceives emotions as colors or notices another recurring phenomenon, render it as a varied lived sensation inside the scene rather than repeating the same explanatory sentence pattern.\n\
            - When using a special perception, power, rule, curse, system, or world mechanic, emphasize what feels strange, vivid, intimate, or newly consequential in this moment. Skip the parts the reader already understands unless the scene genuinely reveals a new nuance or contradiction.\n\
            - Make recurring characters sound different from one another. Differentiate dialogue by role, class, education, faith, profession, emotional habits, and personal temperament.\n\
            - Avoid giving every major character the same philosophical, solemn, or tragic voice. A soldier should feel more direct and concrete; a priest, noble, scholar, or ruler may sound more formal, restrained, or layered with inner conflict if appropriate.\n\
            - Let dialogue rhythm, sentence length, word choice, and what each character avoids saying all contribute to voice distinction.\n\
            - Preserve long-form pacing. Not every chapter needs battle, escalation, or an ending shock.\n\
            - If the outline and current plot allow it, occasionally use a breathing-room chapter or quieter scene for aftermath, reflection, memory, bonding, grief, recovery, or character interiority.\n\
            - Quiet endings, emotional pauses, and resolved scene endings are allowed when they improve rhythm and make later escalation stronger.\n\n"
        );

        prompt.push_str(
            "[Memory Interpretation Rules]\n\
            - [Directly Preceding Content] is the highest-priority local scene context for immediate tone, physical continuity, and line-to-line carryover.\n\
            - [Story State] contains established canon facts and durable unresolved threads. Treat each bullet literally.\n\
            - FACT bullets are already true in the story world unless this chapter explicitly changes them on-screen.\n\
            - OPEN bullets are unresolved long-term threads or uncertainties that may matter later.\n\
            - [Current Arc] contains the active short-term objective, conflict, and near-term direction for the present arc only.\n\
            - ARC bullets are not full world history; they describe what is currently in motion.\n\
            - [Recent Chapter Summaries] are compressed continuity bridges for the last few chapters.\n\
            - [Relevant Closed Arc] is background reference from an earlier resolved arc. Use it only if it naturally matters here, and do not let it override current canon.\n\
            - [Master Plot Outline] is a planning guide. Do not pull future chapter events forward just because they appear later in the outline.\n\
            - If any sources seem to conflict, preserve already-written canon instead of introducing contradictions.\n\
            - CRITICAL: Do NOT re-explain established world rules (for example, repeating that something is data/code rather than a physical phenomenon) in every chapter. Assume the reader already knows the core world mechanics and focus on moving the plot forward.\n\
            - Conflict priority from highest to lowest: Directly Preceding Content > Story State > Current Arc > Recent Chapter Summaries > Relevant Closed Arc > Current Chapter Plot > later parts of Master Plot Outline.\n\
            - If a lower-priority source conflicts with a higher-priority source, follow the higher-priority source.\n\
            - Do not resolve an OPEN thread or revive a closed arc unless this chapter's plot or scene justifies it.\n\n"
        );

        let active_arc_start = meta.current_arc_start_chapter.max(1);
        prompt.push_str(&format!(
            "[Story State: Established canon facts and durable unresolved threads]\n{}\n\n",
            if meta.story_state.trim().is_empty() {
                "None yet."
            } else {
                meta.story_state.trim()
            }
        ));
        prompt.push_str(&format!(
            "[Current Arc (Started at Chapter {}): Active short-term conflict and direction for the present arc]\n{}\n\n",
            active_arc_start,
            if meta.current_arc.trim().is_empty() {
                "None yet. Establish the new arc from the chapter plot, recent chapters, and story state."
            } else {
                meta.current_arc.trim()
            }
        ));

        if let Some(relevant_arc) = select_relevant_closed_arc(
            &meta.closed_arcs,
            chapter_plots.get(&ch),
            &meta.current_arc,
            &meta.current_arc_keywords,
            active_arc_start,
        ) {
            prompt.push_str(&format!(
                "[Relevant Closed Arc (Chapters {} to {}): Past background reference only]\n{}\n\n",
                relevant_arc.start_chapter,
                relevant_arc.end_chapter,
                relevant_arc.summary.trim()
            ));
        }

        if !meta.recent_chapters.is_empty() {
            prompt.push_str("[Recent Chapter Summaries: Immediate continuity bridge]\n");
            for entry in &meta.recent_chapters {
                if !entry.summary.trim().is_empty() {
                    prompt.push_str(&format!("Chapter {}:\n{}\n\n", entry.chapter, entry.summary.trim()));
                }
            }
        }

        if ch > 1 {
            let last_ch = ch - 1;
            let tail_len = 1200;
            let current_chapters = split_full_text_into_chapters(&full_text, &params.language);
            if let Some(prev_text) = current_chapters.get(&last_ch) {
                let tail: String = prev_text.chars().rev().take(tail_len).collect::<String>().chars().rev().collect();
                prompt.push_str(&format!("[Directly Preceding Content (End of Chapter {})]\n\"{}\"\n\n", last_ch, tail));
            }
        }
        prompt.push_str("Please begin writing the chapter now.");

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

        let _ = on_event.send(StreamEvent {
            content: full_text.clone(),
            is_finished: false,
            error: None,
            status: Some(format!("Writing...({}/{})", ch, params.total_chapters)),
        });
        
        // STREAM CHAPTER
        let mut body_map = serde_json::Map::new();
        body_map.insert("model".to_string(), json!(params.model_name));
        body_map.insert("messages".to_string(), json!([
            {"role": "system", "content": params.system_prompt},
            {"role": "user", "content": prompt}
        ]));
        body_map.insert("temperature".to_string(), json!(params.temperature));
        body_map.insert("top_p".to_string(), json!(params.top_p));
        body_map.insert("max_tokens".to_string(), json!(params.target_tokens + 1000));
        body_map.insert("stream".to_string(), json!(true));

        if !params.api_base.contains("googleapis.com") {
            body_map.insert("repetition_penalty".to_string(), json!(params.repetition_penalty));
        }
        
        let request_body = Value::Object(body_map);

        let res = client.post(&url)
            .bearer_auth(&params.api_key)
            .json(&request_body)
            .send()
            .await;

        match res {
            Ok(response) => {
                let status = response.status();
                if !status.is_success() {
                    let err_json: Value = response.json().await.unwrap_or(json!({}));
                    let err_msg = err_json["error"]["message"].as_str()
                        .or(err_json["message"].as_str())
                        .unwrap_or_else(|| "Unknown API error (Check API key or parameters)");
                    
                    // Rollback on error
                    full_text = chapter_start_backup;
                    
                    let _ = on_event.send(StreamEvent {
                        content: full_text.clone(),
                        is_finished: true,
                        error: Some(format!("API Error in Chapter {} ({}): {}", ch, status, err_msg)),
                        status: None,
                    });
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
                            if data == "[DONE]" { break; }
                            if let Ok(json) = serde_json::from_str::<Value>(&data) {
                                if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                                    chapter_text.push_str(content);
                                    count += 1;
                                    if count % 5 == 0 {
                                        let _ = on_event.send(StreamEvent {
                                            content: format!("{}{}", full_text, clean_thought_tags(&chapter_text)),
                                            is_finished: false,
                                            error: None,
                                            status: Some(format!("Writing...({}/{})", ch, params.total_chapters)),
                                        });
                                    }
                                }
                            }
                        }
                        Ok(None) => break,
                        Ok(Some(Err(e))) => {
                             // Rollback on stream error
                             full_text = chapter_start_backup;
                             let _ = on_event.send(StreamEvent {
                                content: full_text.clone(),
                                is_finished: true,
                                error: Some(format!("Stream error in Chapter {}: {}", ch, e)),
                                status: None,
                             });
                            return Ok(full_text);
                        }
                        Err(_) => {
                            // Read Timeout
                            full_text = chapter_start_backup;
                            let _ = on_event.send(StreamEvent {
                                content: full_text.clone(),
                                is_finished: true,
                                error: Some(format!("Read Timeout: Server did not respond for 3 minutes during Chapter {}.", ch)),
                                status: None,
                            });
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
                    let _ = on_event.send(StreamEvent {
                        content: full_text.clone(),
                        is_finished: true,
                        error: Some(format!("Empty response in Chapter {}. The model may have blocked the content due to safety filters or a connection issue.", ch)),
                        status: None,
                    });
                    return Ok(full_text);
                }

                full_text.push_str(&cleaned_chapter);
                full_text.push('\n');

                // 3. Post-Chapter Processing
                if ch < params.total_chapters && !stop_flag.load(Ordering::Relaxed) {
                    // 🌟 요약 시작 전 UI 업데이트 이벤트 발송
                    let _ = on_event.send(StreamEvent {
                        content: full_text.clone(),
                        is_finished: false,
                        error: None,
                        status: Some(format!("Summarizing Chapter {}...", ch)),
                    });

                    let summary = match summarize_chapter(
                        &params.api_base,
                        &params.model_name,
                        &params.api_key,
                        &cleaned_chapter,
                        &params.language,
                    )
                    .await
                    {
                        Ok(summary) => summary,
                        Err(err) => {
                            meta.current_chapter = ch;
                            meta.needs_memory_rebuild = true;
                            let save_error = save_generation_state_to_disk(&meta, &novel_filename, &full_text).err();
                            if let Some(save_err) = &save_error {
                                eprintln!("[Backend] Failed to save paused generation state: {}", save_err);
                            }
                            stop_flag.store(true, Ordering::Relaxed);
                            let _ = on_event.send(StreamEvent {
                                content: full_text.clone(),
                                is_finished: true,
                                error: Some(format!(
                                    "Chapter {} was written, but its summary generation failed: {} Generation is paused to prevent continuity corruption. Resume after manual review; continuity will be rebuilt from the written text.{}",
                                    ch,
                                    err,
                                    save_error
                                        .as_ref()
                                        .map(|msg| format!(" Also failed to save recovery state: {}", msg))
                                        .unwrap_or_default()
                                )),
                                status: None,
                            });
                            return Ok(full_text);
                        }
                    };

                    apply_chapter_memory_update(
                        &mut meta,
                        ch,
                        summary,
                        params.total_chapters,
                        &params.api_base,
                        &params.model_name,
                        &params.api_key,
                        &params.language,
                    )
                    .await;
                }
                meta.current_chapter = ch;

                // Send progress update
                let _ = on_event.send(StreamEvent {
                    content: full_text.clone(),
                    is_finished: false,
                    error: None,
                    status: Some(format!("Writing...({}/{})", ch, params.total_chapters)),
                });
                
                // Final chapter state to frontend
                let _ = on_event.send(StreamEvent {
                    content: full_text.clone(),
                    is_finished: false,
                    error: None,
                    status: Some(format!("Writing...({}/{})", ch, params.total_chapters)),
                });

        // 4. Save State to Disk
                if let Err(save_err) = save_generation_state_to_disk(&meta, &novel_filename, &full_text) {
                    eprintln!("[Backend] Failed to save generation state: {}", save_err);
                    let _ = on_event.send(StreamEvent {
                        content: full_text.clone(),
                        is_finished: false,
                        error: None,
                        status: Some(format!("⚠️ Warning: Failed to save progress to disk. {}", save_err)),
                    });
                }
            }
            Err(e) => {
                let mut error_msg = e.to_string();
                if error_msg.contains("Failed to parse input at pos 0") {
                    error_msg.push_str("\n\n💡 [Hint] Model mismatch detected. Ensure LM Studio chat template is correctly set for models like Gemma 4.");
                }

                // Rollback on connection error
                full_text = chapter_start_backup;

                let _ = on_event.send(StreamEvent {
                    content: full_text.clone(),
                    is_finished: true,
                    error: Some(format!("API error in Chapter {}: {}", ch, error_msg)),
                    status: None,
                });
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

    let _ = on_event.send(StreamEvent {
        content: full_text.clone(),
        is_finished: true,
        error: None,
        status: Some("✅ Done".to_string()),
    });
    
    Ok(full_text)
}

pub async fn generate_plot_stream(
    api_base: &str, model_name: &str, api_key: &str, system_prompt: &str, 
    prompt: &str, temperature: f32, top_p: f32, repetition_penalty: f32, max_tokens: u32,
    on_event: tauri::ipc::Channel<StreamEvent>,
    stop_flag: Arc<AtomicBool>
) -> Result<(), String> {
    let client = Client::builder().build().unwrap();
    let url = format!("{}/chat/completions", api_base.trim_end_matches('/'));
    
    let mut body_map = serde_json::Map::new();
    body_map.insert("model".to_string(), json!(model_name));
    body_map.insert("messages".to_string(), json!([
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt}
    ]));
    body_map.insert("temperature".to_string(), json!(temperature));
    body_map.insert("top_p".to_string(), json!(top_p));
    body_map.insert("max_tokens".to_string(), json!(max_tokens));
    body_map.insert("stream".to_string(), json!(true));

    if !api_base.contains("googleapis.com") {
        body_map.insert("repetition_penalty".to_string(), json!(repetition_penalty));
    }
    
    let request_body = Value::Object(body_map);

    let res = client.post(&url)
        .bearer_auth(api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    if !status.is_success() {
        let err_json: Value = res.json().await.unwrap_or(json!({}));
        let err_msg = err_json["error"]["message"].as_str()
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
                if data == "[DONE]" { break; }
                
                if let Ok(json) = serde_json::from_str::<Value>(&data) {
                    if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                        full_text.push_str(content);
                        count += 1;
                        if count % 5 == 0 {
                            let _ = on_event.send(StreamEvent {
                                content: clean_thought_tags(&full_text),
                                is_finished: false,
                                error: None,
                                status: None,
                            });
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

                let _ = on_event.send(StreamEvent {
                    content: clean_thought_tags(&full_text),
                    is_finished: true,
                    error: Some(error_msg),
                    status: None,
                });
                return Ok(());
            }
            Err(_) => {
                let _ = on_event.send(StreamEvent {
                    content: clean_thought_tags(&full_text),
                    is_finished: true,
                    error: Some("Read Timeout: Server did not respond for 3 minutes during plot generation.".to_string()),
                    status: None,
                });
                return Ok(());
            }
        }
    }

    let _ = on_event.send(StreamEvent {
        content: clean_thought_tags(&full_text),
        is_finished: true,
        error: None,
        status: None,
    });
    
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
                    let seq_part = &name[prefix.len()..name.len()-4];
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
