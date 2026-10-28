//! Perform one chapter request and decode its streamed response; never mutate saved prose.
use super::super::super::api::{apply_thinking_level, attach_opencode_headers, bearer_token};
use super::super::super::output_limits::apply_generation_output_limit;
use super::super::super::text::clean_thought_tags;
use super::super::protocol::{
    append_stream_delta, stream_api_error, stream_completion_error, stream_finish_reason,
    STREAM_READ_TIMEOUT_SECS,
};
use super::NovelSession;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::time::timeout;

impl NovelSession {
    /// `None` means cancellation; the caller rolls back the current chapter.
    pub(super) async fn stream_chapter(
        &self,
        ch: u32,
        prompt: String,
    ) -> Result<Option<String>, String> {
        let mut body_map = serde_json::Map::new();
        body_map.insert("model".to_string(), json!(self.params.model_name));
        body_map.insert(
            "messages".to_string(),
            json!([
                {"role": "system", "content": self.params.system_prompt},
                {"role": "user", "content": prompt}
            ]),
        );
        let mut temp = self.params.temperature;
        if self.params.model_name.to_ascii_lowercase().contains("kimi") {
            temp = 1.0;
        }
        body_map.insert("temperature".to_string(), json!(temp));
        body_map.insert("top_p".to_string(), json!(self.params.top_p));

        apply_generation_output_limit(
            &mut body_map,
            &self.params.api_base,
            &self.params.provider,
            &self.params.api_key,
            0,
        )
        .await;
        if self.stop_flag.load(Ordering::Relaxed) {
            return Ok(None);
        }
        body_map.insert("stream".to_string(), json!(true));

        if !self.params.api_base.contains("googleapis.com")
            && !self.params.api_base.contains("opencode.ai")
            && !self.params.api_base.contains("cerebras.ai")
        {
            body_map.insert(
                "repetition_penalty".to_string(),
                json!(self.params.repetition_penalty),
            );
        }

        apply_thinking_level(
            &mut body_map,
            &self.params.provider,
            &self.params.thinking_level,
        );

        let request_body = Value::Object(body_map);

        let mut request = attach_opencode_headers(
            self.client.post(&self.url).json(&request_body),
            &self.params.provider,
            &self.params.api_base,
        );
        let bearer = bearer_token(&self.params.api_key);
        if !bearer.is_empty() {
            request = request.bearer_auth(&bearer);
        }

        let response = request.send().await.map_err(|error| {
            let mut message = error.to_string();
            if message.contains("Failed to parse input at pos 0") {
                message.push_str("\n\n💡 [Hint] Model mismatch detected. Ensure LM Studio chat template is correctly set for models like Gemma 4.");
            }
            format!("API error in Chapter {}: {}", ch, message)
        })?;
        let status = response.status();
        if !status.is_success() {
            let err_json: Value = response.json().await.unwrap_or(json!({}));
            let err_msg = err_json["error"]["message"]
                .as_str()
                .or(err_json["message"].as_str())
                .unwrap_or("Unknown API error (Check API key or parameters)");
            return Err(format!(
                "API Error in Chapter {} ({}): {}",
                ch, status, err_msg
            ));
        }
        let mut stream = response.bytes_stream().eventsource();
        let mut chapter_text = String::new();
        let mut in_thinking = false;
        let mut reasoning_content_active = false;
        let mut thinking_tokens: u32 = 0;
        let mut count = 0;
        let read_timeout_duration = Duration::from_secs(STREAM_READ_TIMEOUT_SECS);
        let mut saw_done_marker = false;
        let mut terminal_finish_reason: Option<String> = None;

        loop {
            if self.stop_flag.load(Ordering::Relaxed) {
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
                            return Err(error_msg);
                        }
                        if let Some(reason) = stream_finish_reason(&json) {
                            terminal_finish_reason = Some(reason);
                        }
                        let delta = &json["choices"][0]["delta"];
                        let flags = append_stream_delta(
                            &mut chapter_text,
                            &mut in_thinking,
                            &mut reasoning_content_active,
                            delta,
                        );

                        if flags.has_reasoning {
                            thinking_tokens += 1;
                            count += 1;
                            if count % 5 == 0 {
                                let _ = self.events.preview(
                                    clean_thought_tags(&chapter_text),
                                    format!(
                                        "💭 Thinking...({} tokens) Writing...({}/{})",
                                        thinking_tokens, ch, self.params.total_chapters
                                    ),
                                );
                            }
                        }

                        if flags.has_content {
                            count += 1;
                            if flags.thinking_finished {
                                // Notify immediately when field-based or
                                // inline thinking gives way to content.
                                let _ = self.events.preview(
                                    clean_thought_tags(&chapter_text),
                                    format!("✍️ Writing...({}/{})", ch, self.params.total_chapters),
                                );
                            }
                            if in_thinking {
                                thinking_tokens += 1;
                                if count % 5 == 0 {
                                    let _ = self.events.preview(
                                        clean_thought_tags(&chapter_text),
                                        format!(
                                            "💭 Thinking...({} tokens) Writing...({}/{})",
                                            thinking_tokens, ch, self.params.total_chapters
                                        ),
                                    );
                                }
                            } else if count % 5 == 0 {
                                let _ = self.events.preview(
                                    clean_thought_tags(&chapter_text),
                                    format!("✍️ Writing...({}/{})", ch, self.params.total_chapters),
                                );
                            }
                        }
                    }
                }
                Ok(None) => break,
                Ok(Some(Err(e))) => {
                    let error_msg = format!("Stream error in Chapter {}: {}", ch, e);
                    return Err(error_msg);
                }
                Err(_) => {
                    let error_msg = format!(
                        "Read Timeout: Server did not respond for {} minutes during Chapter {}.",
                        STREAM_READ_TIMEOUT_SECS / 60,
                        ch
                    );
                    return Err(error_msg);
                }
            }
        }

        if in_thinking {
            chapter_text.push_str("\n</think>\n");
        }

        // The coordinator restores the pre-chapter checkpoint on cancellation.
        if self.stop_flag.load(Ordering::Relaxed) {
            return Ok(None);
        }

        if let Some(error_msg) = stream_completion_error(
            &format!("Chapter {}", ch),
            saw_done_marker,
            terminal_finish_reason.as_deref(),
        ) {
            return Err(error_msg);
        }

        let cleaned_chapter = clean_thought_tags(&chapter_text);

        // Detect empty response (often happens with Google/Gemini due to safety blocks)
        if cleaned_chapter.trim().is_empty() && !self.stop_flag.load(Ordering::Relaxed) {
            let error_msg = format!(
                "Empty response in Chapter {}. The model may have blocked the content due to safety filters or a connection issue.",
                ch
            );
            return Err(error_msg);
        }

        Ok(Some(cleaned_chapter))
    }
}
