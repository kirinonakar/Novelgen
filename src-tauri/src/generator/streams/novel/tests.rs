use super::*;
use crate::generator::types::ChapterMemory;
use crate::paths::{novel_metadata_filename, output_dir, output_json_dir};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;

const SAVED_TEXT: &str = "Chapter 1\nSaved first chapter 😀 한글.\n";

struct TestNovel(String);

impl Drop for TestNovel {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(output_dir().join(&self.0));
        let _ = std::fs::remove_file(output_json_dir().join(novel_metadata_filename(&self.0)));
        for suffix in [".json", ".previous.json"] {
            let _ = std::fs::remove_file(
                output_dir()
                    .join(".checkpoints")
                    .join(format!("{}{}", self.0, suffix)),
            );
        }
    }
}

fn completion(content: &str, reason: &str) -> String {
    format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({
            "choices": [{"delta": {"content": content}, "finish_reason": reason}]
        })
    )
}

// Exercise the public coordinator with a real local HTTP/SSE response and saved checkpoint.
async fn run_last_chapter(
    status: u16,
    body: String,
    stop_on_preview: bool,
) -> (NovelGenerationResult, Vec<Value>, String, Value) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            let (header_end, length) = loop {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .map_or(0, |value| value.parse::<usize>().unwrap());
                    break (end + 4, length);
                }
            };
            while bytes.len() < header_end + length {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            let catalog = bytes.starts_with(b"GET /v1/models ");
            if !catalog {
                assert!(bytes.starts_with(b"POST /v1/chat/completions "));
            }
            let (response_status, response_body) = if catalog {
                (200, "{\"data\":[]}")
            } else {
                (status, body.as_str())
            };
            socket.write_all(format!(
                "HTTP/1.1 {} Test\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_status, response_body.len(), response_body
            ).as_bytes()).await.unwrap();
            if !catalog {
                break serde_json::from_slice::<Value>(&bytes[header_end..header_end + length])
                    .unwrap();
            }
        }
    });
    let novel = TestNovel(format!("novel_stream_test_{}.txt", uuid::Uuid::new_v4()));
    let mut meta = NovelMetadata::new("English", 2, "seed");
    meta.current_chapter = 1;
    meta.target_tokens = 1000;
    meta.story_state = "OPEN: preserved first chapter".into();
    meta.recent_chapters.push_back(ChapterMemory {
        chapter: 1,
        summary: "Saved summary".into(),
    });
    let mut value = serde_json::to_value(meta).unwrap();
    value.as_object_mut().unwrap().extend(
        json!({
            "api_base": base, "provider": "LM Studio", "model_name": "test-model",
            "api_key": "lm-studio", "system_prompt": "Write a novel", "initial_text": SAVED_TEXT,
        "start_chapter": 2, "total_chapters": 2,
        "temperature": 1.0, "top_p": 0.95, "repetition_penalty": 1.0,
            "novel_filename": novel.0
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let events = Arc::new(Mutex::new(Vec::new()));
    let received = events.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let callback_stop = stop.clone();
    let channel = Channel::new(move |body| {
        let InvokeResponseBody::Json(body) = body else {
            panic!("expected JSON event")
        };
        let event: Value = serde_json::from_str(&body).unwrap();
        if stop_on_preview && event["is_chapter_preview"] == true {
            callback_stop.store(true, Ordering::Relaxed);
        }
        received.lock().unwrap().push(event);
        Ok(())
    });
    let result = timeout(
        Duration::from_secs(10),
        generate_novel_stream(serde_json::from_value(value).unwrap(), channel, stop),
    )
    .await
    .unwrap()
    .unwrap();
    let request = server.await.unwrap();
    let (saved_text, _) = crate::novel_store::load(&novel.0).unwrap();
    let events = events.lock().unwrap().clone();
    assert_eq!(
        events
            .iter()
            .filter(|event| event["is_finished"] == true)
            .count(),
        1
    );
    assert_eq!(
        events.last().unwrap()["replace_from"],
        SAVED_TEXT.encode_utf16().count()
    );
    (result, events, saved_text, request)
}

#[tokio::test]
async fn chapter_api_error_rolls_back_before_sending_the_terminal_event() {
    let (result, events, saved, _) = run_last_chapter(
        503,
        json!({"error": {"message": "provider unavailable"}}).to_string(),
        false,
    )
    .await;
    assert_eq!(result.full_text, SAVED_TEXT);
    assert_eq!(saved, SAVED_TEXT);
    assert_eq!(result.metadata.current_chapter, 1);
    assert!(result.error.unwrap().contains("provider unavailable"));
    assert_eq!(events.last().unwrap()["content"], "");
    assert!(events.last().unwrap()["error"]
        .as_str()
        .unwrap()
        .contains("Chapter 2"));
}

#[tokio::test]
async fn incomplete_chapter_is_neither_committed_nor_reported_as_completed() {
    let (result, events, saved, _) =
        run_last_chapter(200, completion("Partial sentence", "length"), false).await;
    assert_eq!(result.full_text, SAVED_TEXT);
    assert_eq!(saved, SAVED_TEXT);
    assert_eq!(result.metadata.current_chapter, 1);
    assert!(result.error.unwrap().contains("finish_reason: length"));
    assert_eq!(events.last().unwrap()["content"], "");
}

#[tokio::test]
async fn stopping_from_a_chapter_preview_restores_the_saved_manuscript() {
    let body = (0..5)
        .map(|_| {
            format!(
                "data: {}\n\n",
                json!({
                    "choices": [{"delta": {"content": "partial "}}]
                })
            )
        })
        .collect::<String>();
    let (result, events, saved, _) = run_last_chapter(200, body, true).await;
    assert_eq!(result.full_text, SAVED_TEXT);
    assert_eq!(saved, SAVED_TEXT);
    assert_eq!(result.metadata.current_chapter, 1);
    assert!(result.error.is_none());
    assert!(events
        .iter()
        .any(|event| event["is_chapter_preview"] == true));
    assert_eq!(events.last().unwrap()["content"], "");
    assert!(events.last().unwrap()["error"].is_null());
}

#[tokio::test]
async fn completed_chapter_commits_the_full_tail_and_preserves_prompt_continuity() {
    let (result, events, saved, request) =
        run_last_chapter(200, completion("Complete second chapter.", "stop"), false).await;
    assert!(result.error.is_none());
    assert_eq!(result.metadata.current_chapter, 2);
    assert_eq!(
        result.full_text,
        format!(
            "{}\n\n### Chapter 2\n\nComplete second chapter.\n",
            SAVED_TEXT
        )
    );
    assert_eq!(saved, result.full_text);
    assert_eq!(
        events.last().unwrap()["content"],
        result.full_text[SAVED_TEXT.len()..]
    );
    let prompt = request["messages"][1]["content"].as_str().unwrap();
    assert!(prompt.contains("Saved summary"));
    assert!(prompt.contains("OPEN: preserved first chapter"));
    assert!(prompt.contains("Saved first chapter 😀 한글."));
}
