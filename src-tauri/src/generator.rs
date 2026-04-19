use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use regex::Regex;

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

    let response_json: Value = res.json().await.map_err(|e| e.to_string())?;
    
    if let Some(content) = response_json["choices"][0]["message"]["content"].as_str() {
        Ok(clean_thought_tags(content))
    } else {
        Err(format!("Invalid response format: {}", response_json))
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

    let response_json: Value = res.json().await.map_err(|e| e.to_string())?;
    
    if let Some(content) = response_json["choices"][0]["message"]["content"].as_str() {
        Ok(clean_thought_tags(content))
    } else {
        Err(format!("Invalid response format: {}", response_json))
    }
}

#[derive(Serialize, Clone)]
pub struct StreamEvent {
    pub content: String,
    pub is_finished: bool,
    pub error: Option<String>,
}

pub async fn generate_plot_stream(
    api_base: &str, model_name: &str, api_key: &str, system_prompt: &str, 
    prompt: &str, temperature: f32, top_p: f32, repetition_penalty: f32, max_tokens: u32,
    on_event: tauri::ipc::Channel<StreamEvent>
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

    let mut stream = res.bytes_stream().eventsource();
    let mut full_text = String::new();
    let mut count = 0;

    while let Some(event) = stream.next().await {
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
                            });
                        }
                    }
                }
            }
            Err(e) => {
                let _ = on_event.send(StreamEvent {
                    content: clean_thought_tags(&full_text),
                    is_finished: true,
                    error: Some(e.to_string()),
                });
                return Ok(());
            }
        }
    }

    let _ = on_event.send(StreamEvent {
        content: clean_thought_tags(&full_text),
        is_finished: true,
        error: None,
    });
    
    Ok(())
}
