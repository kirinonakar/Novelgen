use super::text::clean_thought_tags;
use crate::prompt_templates::{render_template, PromptTemplates};
use reqwest::{Client, RequestBuilder};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::LazyLock;
use std::time::Duration;
use uuid::Uuid;

const OPENCODE_GO_PROVIDER: &str = "OpenCode Go";
const OPENCODE_ZEN_PROVIDER: &str = "Zen";
const OPENCODE_SESSION_HEADER: &str = "x-opencode-session";
const OPENCODE_USER_AGENT: &str = concat!("NovelGen/", env!("CARGO_PKG_VERSION"));

// OpenCode uses these values to keep requests from one NovelGen run on the same
// provider for prompt-cache reuse. Process-scoped IDs match the lifetime of the
// app's current session and are regenerated when the app is restarted.
static OPENCODE_GO_SESSION_ID: LazyLock<String> =
    LazyLock::new(|| format!("novelgen-{}", Uuid::new_v4()));
static OPENCODE_ZEN_SESSION_ID: LazyLock<String> =
    LazyLock::new(|| format!("novelgen-{}", Uuid::new_v4()));

fn opencode_session_id(provider: &str, api_base: &str) -> Option<&'static str> {
    let normalized_base = api_base.to_ascii_lowercase();
    if provider.trim().eq_ignore_ascii_case(OPENCODE_GO_PROVIDER)
        || normalized_base.contains("opencode.ai/zen/go")
    {
        return Some(OPENCODE_GO_SESSION_ID.as_str());
    }

    if provider.trim().eq_ignore_ascii_case(OPENCODE_ZEN_PROVIDER)
        || normalized_base.contains("opencode.ai/zen")
    {
        return Some(OPENCODE_ZEN_SESSION_ID.as_str());
    }

    None
}

pub(crate) fn attach_opencode_headers(
    request: RequestBuilder,
    provider: &str,
    api_base: &str,
) -> RequestBuilder {
    let Some(session_id) = opencode_session_id(provider, api_base) else {
        return request;
    };

    request
        .header(OPENCODE_SESSION_HEADER, session_id)
        .header(reqwest::header::USER_AGENT, OPENCODE_USER_AGENT)
}

static CHAT_CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .expect("failed to build shared chat completion client")
});

fn finish_reason(response_json: &Value) -> Option<String> {
    response_json["choices"][0]["finish_reason"]
        .as_str()
        .or_else(|| response_json["choices"][0]["finishReason"].as_str())
        .map(|reason| reason.trim().to_string())
        .filter(|reason| !reason.is_empty())
}

fn is_successful_finish_reason(reason: &str) -> bool {
    matches!(
        reason.trim().to_ascii_lowercase().as_str(),
        "stop" | "end_turn"
    )
}

fn finish_reason_error(context: &str, response_json: &Value) -> Option<String> {
    let reason = finish_reason(response_json)?;
    if is_successful_finish_reason(&reason) {
        return None;
    }

    let normalized = reason.to_ascii_lowercase();
    if normalized.contains("length") || normalized.contains("max_tokens") {
        return Some(format!(
            "{} reached an output or context limit (finish_reason: {}). Check the request token budget and the model/provider limits before retrying.",
            context, reason
        ));
    }

    Some(format!(
        "{} stopped before completion (finish_reason: {}). Retry before continuing.",
        context, reason
    ))
}

#[derive(Deserialize)]
pub struct ModelList {
    pub data: Vec<ModelData>,
}

#[derive(Deserialize, Clone)]
pub struct ModelData {
    pub id: String,
    pub architecture: Option<ModelArchitecture>,
}

#[derive(Deserialize, Clone)]
pub struct ModelArchitecture {
    pub output_modalities: Option<Vec<String>>,
}

impl ModelList {
    fn model_names(self, provider: &str) -> Vec<String> {
        let mut models: Vec<String> = self
            .data
            .into_iter()
            .filter(|model| {
                !provider.trim().eq_ignore_ascii_case("OpenRouter")
                    || model
                        .architecture
                        .as_ref()
                        .and_then(|architecture| architecture.output_modalities.as_ref())
                        .map_or(true, |modalities| {
                            modalities.iter().any(|mode| mode == "text")
                        })
            })
            .map(|model| model.id)
            .collect();
        models.sort();
        models.dedup();
        models
    }
}

pub const LM_STUDIO_MODELS: &[&str] = &[
    "unsloth/gemma-4-31b-it",
    "unsloth/gemma-4-26b-a4b-it",
    "qwen/qwen3.5-35b-a3b",
    "qwen3.5-27b",
];

pub const GOOGLE_MODELS: &[&str] = &[
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-pro-latest",
    "gemma-4-26b-a4b-it",
    "gemma-4-31b-it",
];

pub const OPENCODE_GO_MODELS: &[&str] = &[
    "glm-5.2",
    "glm-5.1",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "minimax-m3",
    "minimax-m2.7",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
];

pub const ZEN_MODELS: &[&str] = &[
    "glm-5.2",
    "glm-5.1",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "minimax-m3",
    "minimax-m2.7",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
];

pub const CEREBRAS_MODELS: &[&str] = &["gemma-4-31b", "gpt-oss-120b", "zai-glm-4.7"];

pub(crate) fn apply_thinking_level(
    body_map: &mut serde_json::Map<String, Value>,
    provider: &str,
    thinking_level: &str,
) {
    let level = thinking_level.trim().to_ascii_lowercase();
    if provider.trim().eq_ignore_ascii_case("OpenRouter") {
        match level.as_str() {
            "disable" | "disabled" => {
                body_map.insert("reasoning".to_string(), json!({ "enabled": false }));
            }
            "low" | "medium" | "high" | "xhigh" | "max" => {
                body_map.insert("reasoning".to_string(), json!({ "effort": level }));
            }
            _ => {}
        }
        return;
    }
    match level.as_str() {
        "disable" | "disabled" => {
            if provider.trim().eq_ignore_ascii_case("Unsloth Desktop") {
                body_map.insert("enable_thinking".to_string(), json!(false));
            } else {
                body_map.insert("thinking".to_string(), json!({ "type": "disabled" }));
            }
        }
        "low" | "medium" | "high" | "xhigh" | "max" => {
            body_map.insert("reasoning_effort".to_string(), json!(level));
        }
        _ => {}
    }
}

/// Returns the Bearer token to attach to outgoing requests.
///
/// Empty keys and the local-provider placeholder "lm-studio" produce "" so the
/// request is sent without an Authorization header; this keeps keyless
/// endpoints such as OpenCode Zen working without an API key.
pub(crate) fn bearer_token(api_key: &str) -> String {
    let key = api_key.trim();
    if key.is_empty() || key.eq_ignore_ascii_case("lm-studio") {
        String::new()
    } else {
        key.to_string()
    }
}

pub async fn fetch_models_impl(
    api_base: &str,
    provider: &str,
    api_key: &str,
) -> Result<Vec<String>, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let url = if api_base.ends_with('/') {
        format!("{}models", api_base)
    } else {
        format!("{}/models", api_base)
    };

    let fallback_models = if provider.trim().eq_ignore_ascii_case("OpenRouter")
        || api_base.contains("openrouter.ai")
    {
        vec!["openrouter/auto".to_string()]
    } else if api_base.contains("googleapis.com") {
        GOOGLE_MODELS.iter().map(|&s| s.to_string()).collect()
    } else if api_base.contains("opencode.ai/zen/go") {
        OPENCODE_GO_MODELS.iter().map(|&s| s.to_string()).collect()
    } else if api_base.contains("opencode.ai/zen") {
        ZEN_MODELS.iter().map(|&s| s.to_string()).collect()
    } else if api_base.contains("cerebras.ai") {
        CEREBRAS_MODELS.iter().map(|&s| s.to_string()).collect()
    } else {
        LM_STUDIO_MODELS.iter().map(|&s| s.to_string()).collect()
    };

    let mut request = attach_opencode_headers(client.get(&url), provider, api_base);
    let bearer = bearer_token(api_key);
    if !bearer.is_empty() {
        request = request.bearer_auth(&bearer);
    }

    match request.send().await {
        Ok(res) => {
            if res.status().is_success() {
                if let Ok(model_list) = res.json::<ModelList>().await {
                    let models = model_list.model_names(provider);
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
    provider: &str,
    model_name: &str,
    api_key: &str,
    system_prompt: &str,
    language: &str,
    temperature: f32,
    top_p: f32,
    input_seed: &str,
    thinking_level: &str,
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

    let mut temp = temperature;
    if model_name.to_ascii_lowercase().contains("kimi") {
        temp = 1.0;
    }

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
    body_map.insert("temperature".to_string(), json!(temp));
    body_map.insert("top_p".to_string(), json!(top_p));
    body_map.insert("max_tokens".to_string(), json!(2000));

    apply_thinking_level(&mut body_map, provider, thinking_level);

    let request_body = Value::Object(body_map);

    let mut request =
        attach_opencode_headers(client.post(&url).json(&request_body), provider, api_base);
    let bearer = bearer_token(api_key);
    if !bearer.is_empty() {
        request = request.bearer_auth(&bearer);
    }
    let res = request.send().await.map_err(|e| e.to_string())?;

    let status = res.status();
    let response_json: Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if status.is_success() {
        if let Some(error_msg) = finish_reason_error("Seed generation", &response_json) {
            return Err(error_msg);
        }
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
    provider: &str,
    model_name: &str,
    api_key: &str,
    system_prompt: &str,
    prompt: &str,
    temperature: f32,
    top_p: f32,
    max_tokens: u32,
    repetition_penalty: f32,
    thinking_level: &str,
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
    let mut temp = temperature;
    if model_name.to_ascii_lowercase().contains("kimi") {
        temp = 1.0;
    }
    body_map.insert("temperature".to_string(), json!(temp));
    body_map.insert("top_p".to_string(), json!(top_p));

    // Summary/instruction callers supply task-specific budgets. Honor them
    // without the old 16K floor or Google-only 8K ceiling.
    super::output_limits::apply_generation_output_limit(
        &mut body_map,
        api_base,
        provider,
        api_key,
        max_tokens,
    )
    .await;

    if !api_base.contains("googleapis.com")
        && !api_base.contains("opencode.ai")
        && !api_base.contains("cerebras.ai")
    {
        body_map.insert("repetition_penalty".to_string(), json!(repetition_penalty));
    }

    apply_thinking_level(&mut body_map, provider, thinking_level);

    let request_body = Value::Object(body_map);

    let mut request =
        attach_opencode_headers(client.post(&url).json(&request_body), provider, api_base);
    let bearer = bearer_token(api_key);
    if !bearer.is_empty() {
        request = request.bearer_auth(&bearer);
    }
    let res = request.send().await.map_err(|e| e.to_string())?;

    let status = res.status();
    let response_json: Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if status.is_success() {
        if let Some(error_msg) = finish_reason_error("Chat completion", &response_json) {
            return Err(error_msg);
        }
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

#[cfg(test)]
mod tests {
    use super::{apply_thinking_level, attach_opencode_headers, ModelList, OPENCODE_USER_AGENT};
    use reqwest::Client;
    use serde_json::Value;

    #[test]
    fn opencode_requests_have_stable_session_and_identifying_user_agent() {
        let client = Client::new();
        let first = attach_opencode_headers(
            client.post("https://opencode.ai/zen/go/v1/chat/completions"),
            "OpenCode Go",
            "https://opencode.ai/zen/go/v1",
        )
        .build()
        .unwrap();
        let second = attach_opencode_headers(
            client.post("https://opencode.ai/zen/go/v1/chat/completions"),
            "OpenCode Go",
            "https://opencode.ai/zen/go/v1",
        )
        .build()
        .unwrap();

        assert_eq!(
            first.headers().get("x-opencode-session"),
            second.headers().get("x-opencode-session")
        );
        assert!(first.headers().get("x-opencode-session").is_some());
        assert_eq!(
            first
                .headers()
                .get(reqwest::header::USER_AGENT)
                .and_then(|value| value.to_str().ok()),
            Some(OPENCODE_USER_AGENT)
        );
    }

    #[test]
    fn zen_requests_have_the_same_header_behavior() {
        let request = attach_opencode_headers(
            Client::new().post("https://opencode.ai/zen/v1/chat/completions"),
            "Zen",
            "https://opencode.ai/zen/v1",
        )
        .build()
        .unwrap();

        assert!(request.headers().get("x-opencode-session").is_some());
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::USER_AGENT)
                .and_then(|value| value.to_str().ok()),
            Some(OPENCODE_USER_AGENT)
        );
    }

    #[test]
    fn non_opencode_requests_do_not_get_opencode_headers() {
        let request = attach_opencode_headers(
            Client::new().post("http://localhost:1234/v1/chat/completions"),
            "LM Studio",
            "http://localhost:1234/v1",
        )
        .build()
        .unwrap();

        assert!(request.headers().get("x-opencode-session").is_none());
        assert!(request.headers().get(reqwest::header::USER_AGENT).is_none());
    }

    #[test]
    fn default_thinking_level_omits_thinking_parameters() {
        let mut body = serde_json::Map::new();

        apply_thinking_level(&mut body, "LM Studio", "default");

        assert!(!body.contains_key("thinking"));
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn disable_thinking_level_uses_disabled_thinking_object() {
        let mut body = serde_json::Map::new();

        apply_thinking_level(&mut body, "LM Studio", "disable");

        assert_eq!(
            body.get("thinking"),
            Some(&serde_json::json!({ "type": "disabled" }))
        );
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn unsloth_disable_uses_enable_thinking_false() {
        let mut body = serde_json::Map::new();

        apply_thinking_level(&mut body, "Unsloth Desktop", "disable");

        assert_eq!(body.get("enable_thinking"), Some(&Value::Bool(false)));
        assert!(!body.contains_key("thinking"));
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn named_thinking_levels_use_reasoning_effort() {
        for level in ["low", "medium", "high", "xhigh", "max"] {
            let mut body = serde_json::Map::new();

            apply_thinking_level(&mut body, "LM Studio", level);

            assert_eq!(
                body.get("reasoning_effort"),
                Some(&Value::String(level.to_string()))
            );
            assert!(!body.contains_key("thinking"));
        }
    }

    #[test]
    fn openrouter_thinking_uses_unified_reasoning_parameters() {
        for (level, expected) in [
            ("disable", serde_json::json!({ "enabled": false })),
            ("low", serde_json::json!({ "effort": "low" })),
            ("medium", serde_json::json!({ "effort": "medium" })),
            ("high", serde_json::json!({ "effort": "high" })),
            ("xhigh", serde_json::json!({ "effort": "xhigh" })),
            ("max", serde_json::json!({ "effort": "max" })),
        ] {
            let mut body = serde_json::Map::new();
            apply_thinking_level(&mut body, "OpenRouter", level);
            assert_eq!(
                body,
                serde_json::Map::from_iter([("reasoning".to_string(), expected)])
            );
        }
        let mut body = serde_json::Map::new();
        apply_thinking_level(&mut body, "OpenRouter", "default");
        assert!(body.is_empty());
    }

    #[test]
    fn openrouter_models_exclude_non_text_outputs() {
        let response = serde_json::json!({"data": [
            {"id": "vendor/text", "architecture": {"output_modalities": ["text"]}},
            {"id": "vendor/image", "architecture": {"output_modalities": ["image"]}},
            {"id": "vendor/mixed", "architecture": {"output_modalities": ["text", "image"]}},
            {"id": "vendor/legacy"}
        ]});
        let models: ModelList = serde_json::from_value(response.clone()).unwrap();
        assert_eq!(
            models.model_names("OpenRouter"),
            vec!["vendor/legacy", "vendor/mixed", "vendor/text"]
        );
        let models: ModelList = serde_json::from_value(response).unwrap();
        assert_eq!(models.model_names("LM Studio").len(), 4);
    }

    #[tokio::test]
    async fn openrouter_model_fetch_authenticates_and_falls_back_without_local_models() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        for (status, body, expected) in [
            (
                "200 OK",
                r#"{"data":[{"id":"vendor/text","architecture":{"output_modalities":["text"]}},{"id":"vendor/image","architecture":{"output_modalities":["image"]}}]}"#,
                vec!["vendor/text"],
            ),
            (
                "503 Service Unavailable",
                r#"{"error":{"message":"Unavailable"}}"#,
                vec!["openrouter/auto"],
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/api/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0 && request.len() < 8192);
                    request.extend_from_slice(&buffer[..count]);
                }
                let response = format!(
                    "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status, body.len(), body,
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                String::from_utf8(request).unwrap()
            });
            let models = super::fetch_models_impl(&base, "OpenRouter", "test-openrouter-key")
                .await
                .unwrap();
            assert_eq!(models, expected);
            let request = tokio::time::timeout(std::time::Duration::from_secs(10), server)
                .await
                .unwrap()
                .unwrap()
                .to_ascii_lowercase();
            assert!(request.starts_with("get /api/v1/models http/1.1\r\n"));
            assert!(request.contains("authorization: bearer test-openrouter-key\r\n"));
            assert!(!request.contains("x-opencode-session"));
        }
    }
}
