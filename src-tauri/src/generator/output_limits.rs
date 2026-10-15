use reqwest::Client;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Clone)]
struct ModelLimits {
    id: String,
    output_tokens: Option<u32>,
    context_length: Option<u32>,
}

fn positive_u32(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        .filter(|value| *value > 0)
}

fn reported_limit(value: &Value, paths: &[&str]) -> Option<u32> {
    paths
        .iter()
        .filter_map(|path| value.pointer(path).and_then(positive_u32))
        .min()
}

fn parse_model(value: &Value) -> Option<ModelLimits> {
    let id = value["id"].as_str().or_else(|| value["name"].as_str())?;
    Some(ModelLimits {
        id: id.to_string(),
        output_tokens: reported_limit(
            value,
            &[
                "/top_provider/max_completion_tokens",
                "/max_completion_tokens",
                "/max_output_tokens",
                "/outputTokenLimit",
                "/output_token_limit",
                "/limit/output",
                "/limits/max_output_tokens",
            ],
        ),
        context_length: reported_limit(
            value,
            &[
                "/top_provider/context_length",
                "/context_length",
                "/max_context_length",
                "/limit/context",
                "/limits/context_length",
            ],
        ),
    })
}

fn parse_catalog(value: &Value) -> Vec<ModelLimits> {
    value["data"]
        .as_array()
        .or_else(|| value["models"].as_array())
        .map(|items| items.iter().filter_map(parse_model).collect())
        .unwrap_or_default()
}

struct CachedCatalog {
    models: Vec<ModelLimits>,
    expires_at: Instant,
}

static CATALOGS: LazyLock<Mutex<HashMap<String, CachedCatalog>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("failed to build model limits client")
});

async fn model_limits(
    api_base: &str,
    provider: &str,
    api_key: &str,
    model: &str,
) -> Option<ModelLimits> {
    let base = api_base.trim_end_matches('/');
    // Google publishes outputTokenLimit on the native model endpoint rather
    // than on its OpenAI-compatible model list. Keep the configured origin and
    // version, including when a proxy is used, and never put API keys in URLs.
    let google_base = if provider.eq_ignore_ascii_case("Google") {
        base.strip_suffix("/openai")
    } else {
        None
    };
    let cache_key = if google_base.is_some() {
        format!("{}|{}|{}", provider, base, model)
    } else {
        format!("{}|{}", provider, base)
    };
    let matches_model = |item: &&ModelLimits| {
        item.id.trim_start_matches("models/") == model.trim_start_matches("models/")
    };
    {
        let cache = CATALOGS.lock().await;
        if let Some(catalog) = cache
            .get(&cache_key)
            .filter(|item| item.expires_at > Instant::now())
        {
            return catalog.models.iter().find(matches_model).cloned();
        }
    }

    let request = if let Some(native_base) = google_base {
        let mut url = reqwest::Url::parse(&format!("{}/models/", native_base)).ok()?;
        url.path_segments_mut()
            .ok()?
            .pop_if_empty()
            .push(model.trim_start_matches("models/"));
        CLIENT
            .get(url)
            .header("x-goog-api-key", super::api::bearer_token(api_key))
    } else {
        let mut request = super::api::attach_opencode_headers(
            CLIENT.get(format!("{}/models", base)),
            provider,
            base,
        );
        let bearer = super::api::bearer_token(api_key);
        if !bearer.is_empty() {
            request = request.bearer_auth(bearer);
        }
        request
    };
    // Reuse each provider's advertised metadata; an ID-only catalog is valid
    // and means the server should decide the output budget.
    let models = match request.send().await {
        Ok(response) if response.status().is_success() => {
            response.json::<Value>().await.ok().map(|value| {
                if google_base.is_some() {
                    parse_model(&value).into_iter().collect()
                } else {
                    parse_catalog(&value)
                }
            })
        }
        _ => None,
    };
    let ttl = if models.is_some() { 300 } else { 30 };
    let models: Vec<ModelLimits> = models.unwrap_or_default();
    let result = models.iter().find(matches_model).cloned();
    CATALOGS.lock().await.insert(
        cache_key,
        CachedCatalog {
            models,
            expires_at: Instant::now() + Duration::from_secs(ttl),
        },
    );
    result
}

fn output_limit(requested: u32, limits: Option<&ModelLimits>, messages: &Value) -> Option<u32> {
    let advertised = limits.and_then(|model| model.output_tokens);
    let chosen = if requested > 0 {
        Some(requested)
    } else {
        advertised
    }?;
    let chosen = advertised.map_or(chosen, |limit| chosen.min(limit));
    let context = limits.and_then(|model| model.context_length);
    if let (Some(context), Some(messages)) = (context, messages.as_array()) {
        // UTF-8 bytes plus chat overhead conservatively reserve space for
        // input, including Korean/Japanese text. This is not an exact tokenizer.
        let prompt_budget = messages.iter().fold(32_u64, |total, message| {
            total
                .saturating_add(
                    message["content"]
                        .as_str()
                        .map_or(0, |content| content.len() as u64),
                )
                .saturating_add(16)
        });
        // When a byte estimate cannot guarantee enough headroom, Auto defers
        // to the server's actual tokenizer/defaults instead of inventing a
        // much smaller cap for Korean/Japanese or a long continuation.
        if requested == 0 && prompt_budget.saturating_add(u64::from(chosen)) > u64::from(context) {
            return None;
        }
    }
    Some(chosen)
}

/// Zero means automatic, not an API limit of zero. Unknown limits are omitted
/// so local and cloud providers can apply their own defaults.
pub(crate) async fn apply_generation_output_limit(
    body: &mut Map<String, Value>,
    api_base: &str,
    provider: &str,
    api_key: &str,
    requested: u32,
) {
    let limits = model_limits(
        api_base,
        provider,
        api_key,
        body["model"].as_str().unwrap_or_default(),
    )
    .await;
    body.remove("max_tokens");
    if let Some(limit) = output_limit(requested, limits.as_ref(), &body["messages"]) {
        body.insert("max_tokens".to_string(), json!(limit));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn mock_catalog(status: u16, body: String) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            socket.write_all(format!("HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body).as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap().to_ascii_lowercase()
        });
        (base, server)
    }

    #[tokio::test]
    async fn every_provider_auto_uses_advertised_limits_or_defers_to_server_and_caches_metadata() {
        for provider in [
            "Google",
            "LM Studio",
            "Unsloth Desktop",
            "Ollama",
            "Ollama Cloud",
            "Cerebras",
            "OpenCode Go",
            "Zen",
            "OpenRouter",
        ] {
            for advertised in [Some(65536), None] {
                let is_google = provider == "Google";
                let metadata = if is_google {
                    json!({"name": "models/model", "outputTokenLimit": advertised})
                } else {
                    json!({"data": [{"id": "model", "max_output_tokens": advertised}]})
                };
                let (origin, server) = mock_catalog(200, metadata.to_string()).await;
                let base = format!(
                    "{}{}",
                    origin,
                    if is_google { "/v1beta/openai" } else { "/v1" }
                );
                let mut body = Map::from_iter([
                    ("model".to_string(), json!("model")),
                    ("messages".to_string(), json!([])),
                    ("max_tokens".to_string(), json!(8192)),
                ]);
                apply_generation_output_limit(&mut body, &base, provider, "test-key", 0).await;
                assert_eq!(
                    body.get("max_tokens").and_then(Value::as_u64),
                    advertised.map(|limit| limit as u64),
                    "{}",
                    provider
                );
                let request = server.await.unwrap();
                assert!(request.starts_with(if is_google {
                    "get /v1beta/models/model http/1.1\r\n"
                } else {
                    "get /v1/models http/1.1\r\n"
                }));
                assert!(request.contains(if is_google {
                    "x-goog-api-key: test-key"
                } else {
                    "authorization: bearer test-key"
                }));
                assert!(!request.contains("?key="));
                // A second request must use the cached catalog, even after
                // the mock server has closed, and still honor manual values.
                apply_generation_output_limit(&mut body, &base, provider, "test-key", 200000).await;
                assert_eq!(body["max_tokens"], advertised.unwrap_or(200000));
            }
        }
    }

    #[tokio::test]
    async fn unavailable_or_invalid_metadata_preserves_auto_and_manual_modes() {
        for (status, response) in [(503, "unavailable"), (200, "invalid json")] {
            let (origin, server) = mock_catalog(status, response.to_string()).await;
            let base = format!("{}/v1", origin);
            let mut body = Map::from_iter([
                ("model".to_string(), json!("model")),
                ("messages".to_string(), json!([])),
            ]);
            apply_generation_output_limit(&mut body, &base, "Cerebras", "", 0).await;
            assert!(!body.contains_key("max_tokens"));
            server.await.unwrap();
            apply_generation_output_limit(&mut body, &base, "Cerebras", "", 48000).await;
            assert_eq!(body["max_tokens"], 48000);
        }
    }

    #[test]
    fn metadata_formats_are_tolerant_and_context_is_not_mistaken_for_output_limit() {
        for metadata in [
            json!({"id":"model", "name":"display name", "top_provider":{"max_completion_tokens":65536}}),
            json!({"id":"model", "max_completion_tokens":65536}),
            json!({"id":"model", "max_output_tokens":"65536"}),
            json!({"name":"models/model", "outputTokenLimit":65536, "inputTokenLimit":1048576}),
            json!({"id":"model", "limit":{"output":65536,"context":131072}}),
        ] {
            assert_eq!(parse_model(&metadata).unwrap().output_tokens, Some(65536));
        }
        let catalog = parse_catalog(
            &json!({"data":[null, {"id":"model","max_context_length":131072}, {"id":"invalid","max_output_tokens":-1}]}),
        );
        assert_eq!(catalog.len(), 2);
        assert!(catalog.iter().all(|model| model.output_tokens.is_none()));
    }

    #[test]
    fn advertised_limit_replaces_the_old_app_cap_and_manual_limits_remain_effective() {
        let model: ModelLimits = parse_model(&json!({
            "id": "vendor/model", "context_length": 262144,
            "top_provider": {"max_completion_tokens": 131072, "context_length": 262144}
        }))
        .unwrap();
        let messages = json!([{"role": "user", "content": "Write a plot"}]);
        assert_eq!(output_limit(0, Some(&model), &messages), Some(131072));
        assert_eq!(output_limit(32768, Some(&model), &messages), Some(32768));
        assert_eq!(output_limit(200000, Some(&model), &messages), Some(131072));
        assert_eq!(output_limit(4096, None, &messages), Some(4096));
        assert_eq!(output_limit(0, None, &messages), None);
    }

    #[test]
    fn context_reservation_accounts_for_growing_continuations_and_unicode() {
        let model: ModelLimits = parse_model(&json!({
            "id": "vendor/model", "context_length": 32768,
            "top_provider": {"max_completion_tokens": 32000}
        }))
        .unwrap();
        let first = json!([{"role": "user", "content": "한글"}]);
        assert_eq!(output_limit(0, Some(&model), &first), Some(32000));
        let continued = json!([
            {"role": "user", "content": "한글"},
            {"role": "assistant", "content": "a".repeat(1000)}
        ]);
        assert_eq!(output_limit(0, Some(&model), &continued), None);
        let long = json!([{"role": "user", "content": "a".repeat(40000)}]);
        assert_eq!(output_limit(0, Some(&model), &long), None);
    }
}
