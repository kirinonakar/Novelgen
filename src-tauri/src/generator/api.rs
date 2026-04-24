use super::text::clean_thought_tags;
use crate::prompt_templates::{render_template, PromptTemplates};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::LazyLock;
use std::time::Duration;

static CHAT_CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .expect("failed to build shared chat completion client")
});

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
