//! Plot streaming and bounded output-limit continuations.
use super::super::api::{apply_thinking_level, attach_opencode_headers, bearer_token};
use super::super::output_limits::apply_generation_output_limit;
use super::super::text::clean_thought_tags;
use super::super::types::StreamEvent;
use super::protocol::{
    append_stream_delta, is_output_limit_finish_reason, stream_api_error, stream_completion_error,
    stream_finish_reason, STREAM_READ_TIMEOUT_SECS,
};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;

const MAX_PLOT_CONTINUATIONS: usize = 4;
const PLOT_CONTINUATION_PROMPT: &str = "The previous response stopped at its output token limit. Continue exactly where that response ended, including any unfinished word, sentence, or chapter entry. Output only the missing continuation of the originally requested plot or revision. Do not repeat existing text, restart the outline, add a continuation heading, summarize, or include commentary. Keep the same language and formatting, cover all remaining requested sections and chapters, and stop when the original request is complete.";

pub async fn generate_plot_stream(
    api_base: &str,
    provider: &str,
    model_name: &str,
    api_key: &str,
    system_prompt: &str,
    prompt: &str,
    temperature: f32,
    top_p: f32,
    repetition_penalty: f32,
    max_tokens: u32,
    thinking_level: &str,
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
    let mut temp = temperature;
    if model_name.to_ascii_lowercase().contains("kimi") {
        temp = 1.0;
    }
    body_map.insert("temperature".to_string(), json!(temp));
    body_map.insert("top_p".to_string(), json!(top_p));

    body_map.insert("stream".to_string(), json!(true));

    if !api_base.contains("googleapis.com")
        && !api_base.contains("opencode.ai")
        && !api_base.contains("cerebras.ai")
    {
        body_map.insert("repetition_penalty".to_string(), json!(repetition_penalty));
    }

    apply_thinking_level(&mut body_map, provider, thinking_level);

    let mut full_text = String::new();
    let mut continuation_count = 0;
    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        let previous_visible_text = clean_thought_tags(&full_text);
        apply_generation_output_limit(&mut body_map, api_base, provider, api_key, max_tokens).await;
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        let request_body = Value::Object(body_map.clone());

        let mut request =
            attach_opencode_headers(client.post(&url).json(&request_body), provider, api_base);
        let bearer = bearer_token(api_key);
        if !bearer.is_empty() {
            request = request.bearer_auth(&bearer);
        }
        let res = request.send().await.map_err(|e| e.to_string())?;

        let status = res.status();
        if !status.is_success() {
            let err_json: Value = res.json().await.unwrap_or(json!({}));
            let err_msg = err_json["error"]["message"]
                .as_str()
                .or(err_json["message"].as_str())
                .unwrap_or("Unknown API error");
            let _ = on_event.send(StreamEvent::full(
                clean_thought_tags(&full_text),
                true,
                Some(format!("API Error ({}): {}", status, err_msg)),
                None,
            ));
            return Ok(());
        }

        let mut stream = res.bytes_stream().eventsource();
        let mut in_thinking = false;
        let mut reasoning_content_active = false;
        let mut thinking_tokens: u32 = 0;
        let mut count = 0;
        let read_timeout_duration = Duration::from_secs(STREAM_READ_TIMEOUT_SECS);
        let mut saw_done_marker = false;
        let mut terminal_finish_reason: Option<String> = None;

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            match timeout(read_timeout_duration, stream.next()).await {
                Ok(Some(Ok(evt))) => {
                    let data = evt.data;
                    if data.trim() == "[DONE]" {
                        saw_done_marker = true;
                        break;
                    }

                    if let Ok(json) = serde_json::from_str::<Value>(&data) {
                        if let Some(error_msg) = stream_api_error(&json) {
                            let _ = on_event.send(StreamEvent::full(
                                clean_thought_tags(&full_text),
                                true,
                                Some(error_msg),
                                None,
                            ));
                            return Ok(());
                        }
                        if let Some(reason) = stream_finish_reason(&json) {
                            terminal_finish_reason = Some(reason);
                        }
                        let delta = &json["choices"][0]["delta"];
                        let flags = append_stream_delta(
                            &mut full_text,
                            &mut in_thinking,
                            &mut reasoning_content_active,
                            delta,
                        );

                        if flags.has_reasoning {
                            thinking_tokens += 1;
                            count += 1;
                            if count % 5 == 0 {
                                let _ = on_event.send(StreamEvent::full(
                                    clean_thought_tags(&full_text),
                                    false,
                                    None,
                                    Some(format!("💭 Thinking...({} tokens)", thinking_tokens)),
                                ));
                            }
                        }

                        if flags.has_content {
                            count += 1;
                            if flags.thinking_finished {
                                // Notify immediately when field-based or inline
                                // thinking gives way to content.
                                let _ = on_event.send(StreamEvent::full(
                                    clean_thought_tags(&full_text),
                                    false,
                                    None,
                                    Some("⏳ Generating...".to_string()),
                                ));
                            }
                            if in_thinking {
                                thinking_tokens += 1;
                                if count % 5 == 0 {
                                    let _ = on_event.send(StreamEvent::full(
                                        clean_thought_tags(&full_text),
                                        false,
                                        None,
                                        Some(format!("💭 Thinking...({} tokens)", thinking_tokens)),
                                    ));
                                }
                            } else if count % 5 == 0 {
                                let _ = on_event.send(StreamEvent::full(
                                    clean_thought_tags(&full_text),
                                    false,
                                    None,
                                    Some("⏳ Generating...".to_string()),
                                ));
                            }
                        }
                    } else if !data.trim().is_empty() && evt.event != "ping" {
                        // A lost content event can leave an earlier, punctuated
                        // sentence looking complete. Never silently skip it and
                        // then report the truncated manuscript as successful.
                        let _ = on_event.send(StreamEvent::full(
                            clean_thought_tags(&full_text),
                            true,
                            Some("Invalid JSON in generation stream. The response may be incomplete; the partial output has been preserved.".to_string()),
                            None,
                        ));
                        return Ok(());
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
                        Some(format!("Read Timeout: Server did not respond for {} minutes during plot generation.", STREAM_READ_TIMEOUT_SECS / 60)),
                        None,
                    ));
                    return Ok(());
                }
            }
        }

        if in_thinking {
            full_text.push_str("\n</think>\n");
        }

        if !stop_flag.load(Ordering::Relaxed) {
            let reached_output_limit = terminal_finish_reason
                .as_deref()
                .is_some_and(is_output_limit_finish_reason);
            if reached_output_limit {
                let visible_text = clean_thought_tags(&full_text);
                let error = if visible_text == previous_visible_text {
                    Some("Plot generation hit the output limit without producing new visible text. Lower Thinking Level or use a model with a larger output limit, then retry.".to_string())
                } else if continuation_count >= MAX_PLOT_CONTINUATIONS {
                    Some(format!("Plot generation still hit the output limit after {} automatic continuations. The partial output has been preserved. Reduce the plot chunk size or use a model with a larger output limit.", MAX_PLOT_CONTINUATIONS))
                } else {
                    None
                };
                if let Some(error) = error {
                    let _ = on_event.send(StreamEvent::full(visible_text, true, Some(error), None));
                    return Ok(());
                }
                continuation_count += 1;
                body_map.insert(
                    "messages".to_string(),
                    json!([
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": prompt},
                        {"role": "assistant", "content": visible_text},
                        {"role": "user", "content": PLOT_CONTINUATION_PROMPT}
                    ]),
                );
                let _ =
                    on_event.send(StreamEvent::full(
                        visible_text,
                        false,
                        None,
                        Some(format!(
                        "⏳ Output limit reached (request ceiling: {}). Continuing plot ({}/{})...",
                        body_map.get("max_tokens").and_then(Value::as_u64)
                            .map(|tokens| format!("{} tokens", tokens))
                            .unwrap_or_else(|| "provider default".to_string()),
                        continuation_count, MAX_PLOT_CONTINUATIONS
                    )),
                    ));
                continue;
            }
            if let Some(error_msg) = stream_completion_error(
                "Plot generation",
                saw_done_marker,
                terminal_finish_reason.as_deref(),
            ) {
                let _ = on_event.send(StreamEvent::full(
                    clean_thought_tags(&full_text),
                    true,
                    Some(error_msg),
                    None,
                ));
                return Ok(());
            }
            if clean_thought_tags(&full_text) == previous_visible_text {
                let _ = on_event.send(StreamEvent::full(
                    previous_visible_text, true,
                    Some("Plot generation ended without producing new visible text. Lower Thinking Level or try another model.".to_string()), None,
                ));
                return Ok(());
            }
        }

        break;
    }

    let _ = on_event.send(StreamEvent::full(
        clean_thought_tags(&full_text),
        true,
        None,
        None,
    ));

    Ok(())
}

#[cfg(test)]
mod tests;
