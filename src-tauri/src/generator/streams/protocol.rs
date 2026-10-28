//! Provider delta decoding, reasoning boundaries, and completion validation.
use serde_json::Value;

pub(super) const STREAM_READ_TIMEOUT_SECS: u64 = 300;

pub(super) fn stream_finish_reason(json: &Value) -> Option<String> {
    json["choices"][0]["finish_reason"]
        .as_str()
        .or_else(|| json["choices"][0]["finishReason"].as_str())
        .map(|reason| reason.trim().to_string())
        .filter(|reason| !reason.is_empty())
}

pub(super) fn stream_api_error(json: &Value) -> Option<String> {
    let error = json.get("error").filter(|error| !error.is_null())?;
    let message = error["message"]
        .as_str()
        .or_else(|| error.as_str())
        .unwrap_or("Unknown streaming API error");
    Some(format!("API stream error: {}", message))
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct StreamDeltaFlags {
    pub(super) has_reasoning: bool,
    pub(super) has_content: bool,
    pub(super) thinking_finished: bool,
}

/// Appends one OpenAI-compatible streaming delta while keeping provider-level
/// `reasoning_content` separate from the visible `content`.
///
/// DeepSeek sends reasoning and the final answer in separate fields. The
/// answer normally arrives after the last reasoning chunk, so the synthetic
/// `<think>` block must be closed when `content` starts. Some gateways can
/// include both fields in one delta, therefore they are intentionally handled
/// independently instead of using `else if`.
pub(super) fn append_stream_delta(
    output: &mut String,
    in_thinking: &mut bool,
    reasoning_content_active: &mut bool,
    delta: &Value,
) -> StreamDeltaFlags {
    let mut flags = StreamDeltaFlags::default();

    if let Some(reasoning) = delta["reasoning_content"]
        .as_str()
        .or_else(|| delta["reasoning"].as_str())
    {
        if !reasoning.is_empty() {
            if !*in_thinking {
                output.push_str("<think>\n");
                *in_thinking = true;
            }
            *reasoning_content_active = true;
            output.push_str(reasoning);
            flags.has_reasoning = true;
        }
    }

    if let Some(content) = delta["content"].as_str() {
        if !content.is_empty() {
            flags.has_content = true;

            // A normal content field marks the end of field-based reasoning.
            // Without this transition, clean_thought_tags treats the answer
            // as part of an unclosed <think> block and removes it entirely.
            if *reasoning_content_active {
                output.push_str("\n</think>");
                *in_thinking = false;
                *reasoning_content_active = false;
                flags.thinking_finished = true;
            }

            // Also support providers that put <think> markers inside content.
            if content.contains("<think>") && !*in_thinking {
                *in_thinking = true;
            }
            if *in_thinking && content.contains("</think>") {
                *in_thinking = false;
                flags.thinking_finished = true;
            }

            output.push_str(content);
        }
    }

    flags
}

pub(super) fn is_output_limit_finish_reason(reason: &str) -> bool {
    let normalized = reason.trim().to_ascii_lowercase();
    normalized.contains("length") || normalized.contains("max_tokens")
}

pub(super) fn is_successful_finish_reason(reason: &str) -> bool {
    matches!(
        reason.trim().to_ascii_lowercase().as_str(),
        "stop" | "end_turn"
    )
}

pub(super) fn stream_completion_error(
    context: &str,
    saw_done_marker: bool,
    finish_reason: Option<&str>,
) -> Option<String> {
    if let Some(reason) = finish_reason {
        if is_successful_finish_reason(reason) {
            return None;
        }

        if is_output_limit_finish_reason(reason) {
            return Some(format!(
                "{} reached an output or context limit (finish_reason: {}). Check the model/provider limits, or reduce the chunk size before retrying.",
                context, reason
            ));
        }

        return Some(format!(
            "{} stopped before completion (finish_reason: {}). Retry before continuing.",
            context, reason
        ));
    }

    if !saw_done_marker {
        return Some(format!(
            "{} stream ended before the completion marker ([DONE]). The response may be incomplete; retry before continuing.",
            context
        ));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::super::super::text::clean_thought_tags;
    use super::*;
    use serde_json::json;

    #[test]
    fn openrouter_reasoning_transition_keeps_answer_visible() {
        let mut output = String::new();
        let mut in_thinking = false;
        let mut reasoning_active = false;
        let thinking = append_stream_delta(
            &mut output,
            &mut in_thinking,
            &mut reasoning_active,
            &json!({"reasoning": "internal plan"}),
        );
        assert!(thinking.has_reasoning);
        let answer = append_stream_delta(
            &mut output,
            &mut in_thinking,
            &mut reasoning_active,
            &json!({"content": "visible answer"}),
        );
        assert!(answer.thinking_finished);
        assert_eq!(clean_thought_tags(&output), "visible answer");
        assert_eq!(
            stream_api_error(&json!({"error": {"message": "Provider disconnected"}})),
            Some("API stream error: Provider disconnected".to_string())
        );
        assert!(stream_api_error(&json!({"choices": []})).is_none());
    }

    #[test]
    fn reasoning_content_transition_keeps_following_answer_visible() {
        let mut output = String::new();
        let mut in_thinking = false;
        let mut reasoning_content_active = false;

        let reasoning_flags = append_stream_delta(
            &mut output,
            &mut in_thinking,
            &mut reasoning_content_active,
            &json!({ "reasoning_content": "internal plan" }),
        );
        let content_flags = append_stream_delta(
            &mut output,
            &mut in_thinking,
            &mut reasoning_content_active,
            &json!({ "content": "visible answer" }),
        );

        assert!(reasoning_flags.has_reasoning);
        assert!(content_flags.has_content);
        assert!(content_flags.thinking_finished);
        assert!(!in_thinking);
        assert_eq!(clean_thought_tags(&output), "visible answer");
    }

    #[test]
    fn reasoning_and_content_in_one_delta_are_both_processed() {
        let mut output = String::new();
        let mut in_thinking = false;
        let mut reasoning_content_active = false;

        let flags = append_stream_delta(
            &mut output,
            &mut in_thinking,
            &mut reasoning_content_active,
            &json!({
                "reasoning_content": "internal plan",
                "content": "visible answer"
            }),
        );

        assert!(flags.has_reasoning);
        assert!(flags.has_content);
        assert!(flags.thinking_finished);
        assert_eq!(clean_thought_tags(&output), "visible answer");
    }
}
