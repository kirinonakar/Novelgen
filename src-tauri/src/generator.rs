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

pub fn clean_thought_tags(text: &str) -> String {
    // Basic regex wrapper to clean tags, analogous to python's clean_thought_tags
    let re_full = Regex::new(r"(?s)<\|channel>thought.*?<channel\|>").unwrap();
    let re_unclosed = Regex::new(r"(?s)<\|channel>thought.*$").unwrap();
    let t1 = re_full.replace_all(text, "");
    let t2 = re_unclosed.replace_all(&t1, "");
    t2.replace("<|channel>thought", "").replace("<channel|>", "").trim().to_string()
}

pub async fn fetch_models_impl(api_base: &str) -> Result<Vec<String>, String> {
    let client = Client::builder().timeout(Duration::from_secs(5)).build().unwrap();
    let url = if api_base.ends_with('/') {
        format!("{}models", api_base)
    } else {
        format!("{}/models", api_base)
    };
    
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let model_list: ModelList = res.json().await.map_err(|e| e.to_string())?;
    
    let mut models: Vec<String> = model_list.data.into_iter().map(|m| m.id).collect();
    models.sort();
    Ok(models)
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
    temperature: f32, top_p: f32, max_tokens: u32
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
        "max_tokens": max_tokens
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
    prompt: &str, temperature: f32, top_p: f32,
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
        "max_tokens": 8192,
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
                        if count % 5 == 0 {
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
