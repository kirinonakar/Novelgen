use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use regex::Regex;
use std::fs;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NovelMetadata {
    pub title: String,
    pub language: String,
    pub num_chapters: u32,
    pub current_chapter: u32,
    pub plot_seed: String,
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
            grand_summary: String::new(),
            chapter_summaries: Vec::new(),
        }
    }
}

pub fn split_plot_into_chapters(plot_text: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    // Improved pattern to match Chapter markers more robustly
    let pattern = Regex::new(r"(?i)(?:Chapter\s*(\d+)|제?\s*(\d+)\s*장|第?\s*(\d+)\s*章)").unwrap();
    
    let matches: Vec<_> = pattern.captures_iter(plot_text).collect();
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
    let re_error = Regex::new(r"(?s)\n\n\[Generation Stopped/Error\].*$").unwrap();
    let contents = re_error.replace_all(text, "");

    let pattern_str = if lang == "Korean" {
        r"(?i)(?:^|\n)#?\s*제?\s*(\d+)\s*[장]"
    } else if lang == "Japanese" {
        r"(?i)(?:^|\n)#?\s*第?\s*(\d+)\s*[章]"
    } else {
        r"(?i)(?:^|\n)#?\s*Chapter\s*(\d+)"
    };
    let pattern = Regex::new(pattern_str).unwrap();
    
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
    
    match chat_completion(api_base, model_name, api_key, "You are a professional novelist.", &prompt, 0.5, 0.95, 2000, 1.0).await {
        Ok(summary) => summary,
        Err(_) => String::new(),
    }
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
        Err(_) => format!("{}\n{}", grand_summary, recent_summary),
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
    let re_full = Regex::new(r"(?s)<\|channel>thought.*?<channel\|>").unwrap();
    let text = re_full.replace_all(text, "");
    
    // 2. Unclosed blocks at the end of a stream
    let re_unclosed = Regex::new(r"(?s)<\|channel>thought.*$").unwrap();
    let text = re_unclosed.replace_all(&text, "");
    
    // 3. Alternative <thought> tags
    let re_thought_block = Regex::new(r"(?s)<thought>.*?</thought>").unwrap();
    let text = re_thought_block.replace_all(&text, "");
    let re_thought_open = Regex::new(r"(?s)<thought>.*$").unwrap();
    let text = re_thought_open.replace_all(&text, "");

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
    language: &str, temperature: f32, top_p: f32
) -> Result<String, String> {
    let client = Client::builder().timeout(Duration::from_secs(30)).build().unwrap();
    
    let prompt = format!(
        "Based on your assigned writing style, genre, and persona in the system prompt, \
        brainstorm a highly creative, unique, and engaging initial plot seed (core idea) for a new novel. \
        Write the seed in {language}. Keep it concise (about 3-5 sentences). \
        Output ONLY the plot seed text. Do not include titles, greetings, meta-commentary, or any internal reasoning tags like <|channel>thought."
    );

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
    let client = Client::builder().timeout(Duration::from_secs(60)).build().unwrap();
    let url = format!("{}/chat/completions", api_base.trim_end_matches('/'));
    
    let request_body = json!({
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ],
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": max_tokens,
        "repetition_penalty": repetition_penalty
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
}

pub async fn generate_novel_stream(
    params: NovelGenerationParams,
    on_event: tauri::ipc::Channel<StreamEvent>,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let client = Client::builder().timeout(Duration::from_secs(180)).build().unwrap();
    let url = format!("{}/chat/completions", params.api_base.trim_end_matches('/'));
    
    let mut full_text = params.initial_text.clone();
    let chapter_plots = split_plot_into_chapters(&params.plot_outline);
    
    // Ensure we have a filename
    let novel_filename = params.novel_filename.unwrap_or_else(get_next_novel_filename);
    
    // 1. Initial State / Reconstruction
    let mut meta = NovelMetadata::new(&params.language, params.total_chapters, &params.plot_seed);
    
    if params.start_chapter > 1 {
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
                meta.chapter_summaries.push(String::new());
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

    // 2. Generation Loop
    for ch in params.start_chapter..=params.total_chapters {
        if stop_flag.load(Ordering::Relaxed) { break; }
        
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

        if params.api_base.contains("googleapis.com") {
            // Google's OpenAI proxy usually prefers standard OpenAI params
            body_map.insert("frequency_penalty".to_string(), json!(params.repetition_penalty - 1.0));
        } else {
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
                        .unwrap_or("Unknown API error");
                    
                    let _ = on_event.send(StreamEvent {
                        content: full_text.clone(),
                        is_finished: true,
                        error: Some(format!("API Error in Chapter {} ({}): {}", ch, status, err_msg)),
                        status: None,
                    });
                    return Ok(());
                }

                let mut stream = response.bytes_stream().eventsource();
                let mut chapter_text = String::new();
                let mut count = 0;

                while let Some(event) = stream.next().await {
                    if stop_flag.load(Ordering::Relaxed) {
                        break;
                    }
                    match event {
                        Ok(evt) => {
                            let data = evt.data;
                            if data == "[DONE]" { break; }
                            if let Ok(json) = serde_json::from_str::<Value>(&data) {
                                if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                                    chapter_text.push_str(content);
                                    count += 1;
                                    if count % 10 == 0 {
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
                        Err(e) => {
                             let _ = on_event.send(StreamEvent {
                                content: full_text.clone(),
                                is_finished: true,
                                error: Some(format!("Stream error in Chapter {}: {}", ch, e)),
                                status: None,
                            });
                            return Ok(());
                        }
                    }
                }
                
                let cleaned_chapter = clean_thought_tags(&chapter_text);
                full_text.push_str(&cleaned_chapter);
                full_text.push('\n');

                // 3. Post-Chapter Processing
                let summary = summarize_chapter(&params.api_base, &params.model_name, &params.api_key, &cleaned_chapter, &params.language).await;
                meta.chapter_summaries.push(summary);
                if meta.chapter_summaries.len() > 5 {
                    let oldest = meta.chapter_summaries.remove(0);
                    if !oldest.is_empty() {
                        meta.grand_summary = merge_summaries(&params.api_base, &params.model_name, &params.api_key, &meta.grand_summary, &oldest, &params.language).await;
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
                let mut dir = std::env::current_dir().unwrap_or_default();
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

                let _ = on_event.send(StreamEvent {
                    content: full_text,
                    is_finished: true,
                    error: Some(format!("API error in Chapter {}: {}", ch, error_msg)),
                    status: None,
                });
                return Ok(());
            }
        }
    }

    // Ported from app.py: If generation successfully reached the final chapter, delete metadata
    if meta.current_chapter == params.total_chapters {
        let mut dir = std::env::current_dir().unwrap_or_default();
        dir.push("output");
        let json_path = dir.join(novel_filename.replace(".txt", ".json"));
        if json_path.exists() {
            let _ = fs::remove_file(json_path);
        }
    }

    let _ = on_event.send(StreamEvent {
        content: full_text,
        is_finished: true,
        error: None,
        status: None,
    });
    
    Ok(())
}

pub async fn generate_plot_stream(
    api_base: &str, model_name: &str, api_key: &str, system_prompt: &str, 
    prompt: &str, temperature: f32, top_p: f32, repetition_penalty: f32, max_tokens: u32,
    on_event: tauri::ipc::Channel<StreamEvent>,
    stop_flag: Arc<AtomicBool>
) -> Result<(), String> {
    let client = Client::builder().timeout(Duration::from_secs(60)).build().unwrap();
    let url = format!("{}/chat/completions", api_base.trim_end_matches('/'));
    
    let request_body = json!({
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ],
        "temperature": temperature,
        "top_p": top_p,
        "repetition_penalty": repetition_penalty,
        "max_tokens": max_tokens,
        "stream": true
    });

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

    while let Some(event) = stream.next().await {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        match event {
            Ok(evt) => {
                let data = evt.data;
                if data == "[DONE]" { break; }
                
                if let Ok(json) = serde_json::from_str::<Value>(&data) {
                    if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                        full_text.push_str(content);
                        count += 1;
                        if count % 10 == 0 {
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
            Err(e) => {
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

pub fn suggest_next_chapter(text: &str, lang: &str) -> u32 {
    let chapters = split_full_text_into_chapters(text, lang);
    let mut max_valid = 0;
    for (num, content) in chapters {
        if content.len() >= 300 {
            if num > max_valid {
                max_valid = num;
            }
        }
    }
    max_valid + 1
}

pub fn get_next_novel_filename() -> String {
    let mut dir = std::env::current_dir().unwrap_or_default();
    dir.push("output");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    
    let mut max_num = 0;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("novel_") && name.ends_with(".txt") {
                    if name.len() > 10 {
                        let num_str = &name[6..name.len()-4];
                        if let Ok(num) = num_str.parse::<u32>() {
                            if num > max_num {
                                max_num = num;
                            }
                        }
                    }
                }
            }
        }
    }
    format!("novel_{:03}.txt", max_num + 1)
}
