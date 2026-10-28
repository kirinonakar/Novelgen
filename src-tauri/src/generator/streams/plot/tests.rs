use super::*;

fn plot_sse(content: &str, reason: &str, reasoning: &str) -> String {
    format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({
            "choices": [{"delta": {"content": content, "reasoning": reasoning}, "finish_reason": reason}]
        })
    )
}

async fn mock_plot_stream(
    responses: Vec<(u16, String)>,
    stop_on_continuation: bool,
) -> (Vec<Value>, Vec<Value>) {
    mock_plot_stream_with_limit(responses, stop_on_continuation, 0, Some(65536)).await
}

async fn mock_plot_stream_with_limit(
    responses: Vec<(u16, String)>,
    stop_on_continuation: bool,
    requested_limit: u32,
    advertised_limit: Option<u32>,
) -> (Vec<Value>, Vec<Value>) {
    use std::sync::Mutex;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/api/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        // The catalog is fetched once; every continuation uses the cache.
        let (mut socket, _) = timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut headers = Vec::new();
        let mut buffer = [0; 1024];
        while !headers.windows(4).any(|part| part == b"\r\n\r\n") {
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            headers.extend_from_slice(&buffer[..count]);
        }
        let headers = String::from_utf8(headers).unwrap().to_ascii_lowercase();
        assert!(headers.starts_with("get /api/v1/models http/1.1\r\n"));
        assert!(headers.contains("authorization: bearer test-key"));
        let catalog = json!({"data": [{"id": "vendor/model", "context_length": 262144,
            "top_provider": {"max_completion_tokens": advertised_limit}}]})
        .to_string();
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", catalog.len(), catalog).as_bytes()).await.unwrap();
        drop(socket);
        let mut requests = Vec::new();
        for (status, body) in responses {
            let (mut socket, _) = timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            let (header_end, content_length) = loop {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                    assert!(headers.starts_with("post /api/v1/chat/completions http/1.1\r\n"));
                    assert!(headers.contains("authorization: bearer test-key"));
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    break (end + 4, length);
                }
            };
            while request.len() < header_end + content_length {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            requests.push(
                serde_json::from_slice::<Value>(&request[header_end..header_end + content_length])
                    .unwrap(),
            );
            let response = format!(
                "HTTP/1.1 {} Test\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status, body.len(), body,
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        requests
    });
    let events = Arc::new(Mutex::new(Vec::new()));
    let received = events.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_callback = stop.clone();
    let channel = Channel::new(move |body| {
        let InvokeResponseBody::Json(body) = body else {
            panic!("expected JSON event")
        };
        let event: Value = serde_json::from_str(&body).unwrap();
        if stop_on_continuation
            && event["status"]
                .as_str()
                .is_some_and(|status| status.contains("Continuing plot"))
        {
            stop_for_callback.store(true, Ordering::Relaxed);
        }
        received.lock().unwrap().push(event);
        Ok(())
    });
    timeout(
        Duration::from_secs(10),
        generate_plot_stream(
            &base,
            "OpenRouter",
            "vendor/model",
            "test-key",
            "system",
            "original plot request",
            0.7,
            0.9,
            1.0,
            requested_limit,
            "high",
            channel,
            stop,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let requests = timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    let events = events.lock().unwrap().clone();
    assert_eq!(
        events
            .iter()
            .filter(|event| event["is_finished"] == true)
            .count(),
        1
    );
    (requests, events)
}

#[tokio::test]
async fn plot_request_uses_auto_or_manual_output_budget_without_a_fixed_app_cap() {
    for (requested, advertised, expected) in [
        (0, Some(131072), Some(131072_u32)),
        (32768, Some(131072), Some(32768)),
        (131072, Some(32768), Some(32768)),
        (0, None, None),
        (48000, None, Some(48000)),
    ] {
        let (requests, _) = mock_plot_stream_with_limit(
            vec![(200, plot_sse("complete plot", "stop", ""))],
            false,
            requested,
            advertised,
        )
        .await;
        assert_eq!(
            requests[0].get("max_tokens").and_then(Value::as_u64),
            expected.map(u64::from)
        );
    }
}

#[tokio::test]
async fn plot_output_limit_continues_with_accumulated_context_and_preserves_word_boundaries() {
    let (requests, events) = mock_plot_stream(
        vec![
            (
                200,
                plot_sse("제 1장: 시작\n\n제 2장: 중", "length", "private plan"),
            ),
            (200, plot_sse("간 ", "length", "more private planning")),
            (200, plot_sse("완료", "stop", "")),
        ],
        false,
    )
    .await;
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0]["max_tokens"], 65536);
    assert_eq!(requests[1]["messages"][2]["role"], "assistant");
    assert_eq!(
        requests[1]["messages"][2]["content"],
        "제 1장: 시작\n\n제 2장: 중"
    );
    assert_eq!(
        requests[2]["messages"][2]["content"],
        "제 1장: 시작\n\n제 2장: 중간"
    );
    for request in requests {
        assert_eq!(request["model"], "vendor/model");
        assert_eq!(request["reasoning"], json!({"effort": "high"}));
        assert_eq!(request["messages"][0]["content"], "system");
        assert_eq!(request["messages"][1]["content"], "original plot request");
    }
    let final_event = events.last().unwrap();
    assert_eq!(final_event["content"], "제 1장: 시작\n\n제 2장: 중간 완료");
    assert!(final_event["error"].is_null());
    assert!(events.iter().any(|event| event["status"]
        .as_str()
        .is_some_and(|status| status.contains("Continuing plot"))));
}

#[tokio::test]
async fn final_stream_snapshot_keeps_last_deltas_below_the_preview_interval() {
    let chunks = [
        "첫",
        " 문장",
        ".",
        " 다음",
        " 문장.",
        " 마지막",
        " 문장",
        "까지",
        " 도착했다.",
    ];
    let mut body = String::new();
    for content in chunks {
        body.push_str(&format!(
            "data: {}\n\n",
            json!({
                "choices": [{"delta": {"content": content}}]
            })
        ));
    }
    body.push_str(&plot_sse("", "stop", ""));
    let (_, events) = mock_plot_stream(vec![(200, body)], false).await;
    let final_event = events.last().unwrap();
    assert!(final_event["error"].is_null());
    assert_eq!(final_event["content"], chunks.concat());
    assert!(events
        .iter()
        .any(|event| event["is_finished"] == false && event["content"] == "첫 문장. 다음 문장."));
}

#[tokio::test]
async fn malformed_final_content_is_an_error_instead_of_a_successful_shortened_manuscript() {
    let body = format!(
        "data: {}\n\ndata: {{\"choices\":[{{\"delta\":{{\"content\":\"lost final sentence\"\n\ndata: [DONE]\n\n",
        json!({"choices": [{"delta": {"content": "Earlier complete sentence."}}]})
    );
    let (_, events) = mock_plot_stream(vec![(200, body)], false).await;
    let final_event = events.last().unwrap();
    assert_eq!(final_event["content"], "Earlier complete sentence.");
    assert!(final_event["error"]
        .as_str()
        .unwrap()
        .contains("Invalid JSON"));
}

#[tokio::test]
async fn plot_continuation_stops_at_limit_and_preserves_partial_output() {
    let responses = (0..=MAX_PLOT_CONTINUATIONS)
        .map(|_| (200, plot_sse("more ", "length", "")))
        .collect();
    let (requests, events) = mock_plot_stream(responses, false).await;
    assert_eq!(requests.len(), MAX_PLOT_CONTINUATIONS + 1);
    let final_event = events.last().unwrap();
    assert!(final_event["error"]
        .as_str()
        .unwrap()
        .contains("after 4 automatic continuations"));
    assert_eq!(
        final_event["content"],
        "more ".repeat(MAX_PLOT_CONTINUATIONS + 1).trim()
    );
}

#[tokio::test]
async fn plot_reasoning_only_and_non_length_failures_do_not_continue() {
    for (body, expected_error) in [
        (
            plot_sse("", "length", "reasoning consumed the budget"),
            "without producing new visible text",
        ),
        (
            plot_sse("partial", "content_filter", ""),
            "finish_reason: content_filter",
        ),
        (
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n".to_string(),
            "before the completion marker",
        ),
        (
            plot_sse("", "stop", ""),
            "without producing new visible text",
        ),
    ] {
        let (requests, events) = mock_plot_stream(vec![(200, body)], false).await;
        assert_eq!(requests.len(), 1);
        assert!(events.last().unwrap()["error"]
            .as_str()
            .unwrap()
            .contains(expected_error));
    }
}

#[tokio::test]
async fn plot_continuation_http_error_preserves_partial_output() {
    let (_, events) = mock_plot_stream(
        vec![
            (200, plot_sse("existing partial plot", "length", "")),
            (
                402,
                json!({"error": {"message": "Insufficient credits"}}).to_string(),
            ),
        ],
        false,
    )
    .await;
    let final_event = events.last().unwrap();
    assert_eq!(final_event["content"], "existing partial plot");
    assert!(final_event["error"]
        .as_str()
        .unwrap()
        .contains("Insufficient credits"));
}

#[tokio::test]
async fn stopping_before_continuation_prevents_another_request() {
    let (requests, events) =
        mock_plot_stream(vec![(200, plot_sse("partial plot", "length", ""))], true).await;
    assert_eq!(requests.len(), 1);
    assert_eq!(events.last().unwrap()["content"], "partial plot");
    assert!(events.last().unwrap()["error"].is_null());
}
