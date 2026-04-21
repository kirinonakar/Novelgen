use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use regex::Regex;
use std::fs;
use std::collections::HashMap;
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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NovelMetadata {
    pub title: String,
    pub language: String,
    pub num_chapters: u32,
    pub current_chapter: u32,
    pub plot_seed: String,
    pub plot_outline: String,
    pub grand_summary: String,
    pub chapter_summaries: Vec<String>,
}

impl NovelMetadata {
    pub fn new(lang: &str, total_ch: u32, seed: &str) -> Self {
        Self {
            title: "Novel".to_string(),
            language: lang.to_string(),
            num_chapters: total_ch,
            current_chapter: 0,
            plot_seed: seed.to_string(),
            plot_outline: String::new(),
            grand_summary: String::new(),
            chapter_summaries: Vec::new(),
        }
    }
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
) -> String {
    let prompt = format!(
        "Summarize the following chapter in 3-4 sentences in {language}.\n\
        Focus only on key plot events and character changes that are essential for continuity.\n\n\
        Chapter Content:\n{}", chapter_text.chars().take(4000).collect::<String>()
    );
    
    let mut attempts = 0;
    let max_attempts = 3;
    
    while attempts < max_attempts {
        match chat_completion(api_base, model_name, api_key, "You are a professional novelist.", &prompt, 0.5, 0.95, 2000, 1.0).await {
            Ok(summary) => {
                if !summary.trim().is_empty() {
                    return summary;
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

    // Final fallback if all attempts fail
    let fallback = chapter_text.chars().take(200).collect::<String>();
    format!("[Summary Fallback]: {}...", fallback.trim())
}

pub async fn merge_summaries(
    api_base: &str, model_name: &str, api_key: &str, 
    grand_summary: &str, recent_summary: &str, language: &str
) -> String {
    if grand_summary.is_empty() {
        return recent_summary.to_string();
    }
    
    let prompt = format!(
        "Update the following 'Grand Summary' of a novel by incorporating the 'New Chapter Summary' below.\n\
        The resulting summary should be concise (around 5-8 sentences), chronological, and cover all major plot points so far.\n\
        Write in {language}.\n\n\
        Current Grand Summary:\n{grand_summary}\n\n\
        New Chapter Summary to Incorporate:\n{recent_summary}"
    );
    
    match chat_completion(api_base, model_name, api_key, "You are a professional novelist.", &prompt, 0.5, 0.95, 2000, 1.0).await {
        Ok(merged) => merged,
        Err(_) => grand_summary.to_string(),
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
    pub chapter_summaries: Option<Vec<String>>,
    pub grand_summary: Option<String>,
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
    
    // Only use provided summaries if we are resuming (start_chapter > 1)
    if params.start_chapter > 1 {
        if let Some(sums) = params.chapter_summaries {
            meta.chapter_summaries = sums;
        }
        if let Some(gs) = params.grand_summary {
            meta.grand_summary = gs;
        }
    }

    if params.start_chapter > 1 && meta.chapter_summaries.is_empty() {
        let _ = on_event.send(StreamEvent {
            content: full_text.clone(),
            is_finished: false,
            error: None,
            status: Some("🔄 Reconstructing context...".to_string()),
        });
        
        let chapters_map = split_full_text_into_chapters(&full_text, &params.language);
        for ch in 1..params.start_chapter {
            let content = chapters_map.get(&ch).cloned().unwrap_or_default();
            if content.len() >= 100 {
                let summary = summarize_chapter(&params.api_base, &params.model_name, &params.api_key, &content, &params.language).await;
                meta.chapter_summaries.push(summary);
            } else {
                let fallback = content.chars().take(200).collect::<String>();
                meta.chapter_summaries.push(format!("[Summary Fallback]: {}...", fallback.trim()));
            }
        }
        
        // Sliding window compression
        while meta.chapter_summaries.len() > 5 {
            let oldest = meta.chapter_summaries.remove(0);
            if !oldest.is_empty() {
                meta.grand_summary = merge_summaries(&params.api_base, &params.model_name, &params.api_key, &meta.grand_summary, &oldest, &params.language).await;
            }
        }
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
        prompt.push_str("CRITICAL INSTRUCTION:\n1. Write ONLY Chapter {}. Do not rush into future chapters.\n");
        prompt.push_str(&format!("2. Target length: ~{} tokens.\n", params.target_tokens));
        prompt.push_str("3. Output ONLY the story text. No meta-talk.\n4. NEVER use internal reasoning tags or <|thought|> tokens.\n\n");
        
        prompt.push_str(&format!("### CURRENT FOCUS: Chapter {} ###\n", ch));
        if let Some(ch_plot) = chapter_plots.get(&ch) {
            prompt.push_str(&format!("- Current Chapter Plot: {}\n\n", ch_plot));
        }

        if !meta.grand_summary.is_empty() {
            let covered_up_to = ch.saturating_sub(meta.chapter_summaries.len() as u32).saturating_sub(1);
            prompt.push_str(&format!("[Grand Summary (Chapters 1 to {})]\n{}\n\n", covered_up_to, meta.grand_summary));
        }

        if !meta.chapter_summaries.is_empty() {
            prompt.push_str("[Recent Chapter Summaries]\n");
            let start_idx = ch.saturating_sub(meta.chapter_summaries.len() as u32);
            for (i, s) in meta.chapter_summaries.iter().enumerate() {
                if !s.is_empty() {
                    prompt.push_str(&format!("Chapter {}: {}\n", start_idx + i as u32, s));
                }
            }
            prompt.push_str("\n");

            // Previous content tail
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

                    let summary = summarize_chapter(&params.api_base, &params.model_name, &params.api_key, &cleaned_chapter, &params.language).await;
                    meta.chapter_summaries.push(summary);
                    if meta.chapter_summaries.len() > 5 {
                        let oldest = meta.chapter_summaries.remove(0);
                        if !oldest.is_empty() {
                            meta.grand_summary = merge_summaries(&params.api_base, &params.model_name, &params.api_key, &meta.grand_summary, &oldest, &params.language).await;
                        }
                    }
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
                let base = get_base_dir();
                let mut dir = base.clone();
                dir.push("output");
                if !dir.exists() { let _ = fs::create_dir_all(&dir); }
                
                let txt_path = dir.join(&novel_filename);
                let json_path = dir.join(novel_filename.replace(".txt", ".json"));
                
                let _ = fs::write(txt_path, &full_text);
                if let Ok(meta_json) = serde_json::to_string_pretty(&meta) {
                    let _ = fs::write(json_path, meta_json);
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
