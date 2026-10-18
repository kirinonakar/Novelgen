use super::streams::generate_novel_stream;
use super::types::{ChapterMemory, NovelGenerationParams, NovelMetadata};
use crate::paths::{novel_metadata_filename, output_dir, output_json_dir};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;

struct TestNovel(String);

impl Drop for TestNovel {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(output_dir().join(&self.0));
        let _ = std::fs::remove_file(output_json_dir().join(novel_metadata_filename(&self.0)));
    }
}

fn completion(content: &str, stream: bool) -> String {
    if stream {
        format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({
                "choices": [{"delta": {"content": content}, "finish_reason": "stop"}]
            })
        )
    } else {
        json!({"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}).to_string()
    }
}

fn params(base: &str, filename: &str, text: &str, meta: &NovelMetadata) -> NovelGenerationParams {
    let mut value = serde_json::to_value(meta).unwrap();
    value.as_object_mut().unwrap().extend(
        json!({
            "api_base": base, "provider": "LM Studio", "model_name": "test-model",
            "api_key": "lm-studio", "system_prompt": "Write a novel", "initial_text": text,
            "start_chapter": meta.current_chapter + 1, "total_chapters": 10,
            "temperature": 1.0, "top_p": 0.95, "repetition_penalty": 1.0,
            "novel_filename": filename
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn failed_summary_retries_only_previous_chapter_and_preserves_saved_context() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let continuity = json!({
        "story_state": ["OPEN: rescued the prisoner"],
        "character_state": ["Hero: healthy"], "relationship_state": [],
        "current_arc": ["ARC: escape"], "current_arc_keywords": ["escape"],
        "recent_scene_patterns": [], "close_current_arc": false,
        "closed_arc_summary": [], "closed_arc_keywords": []
    })
    .to_string();
    let mut responses = vec![(200, completion("Ninth chapter: rescue.", true))];
    // Both the original summary and its first recovery attempt fail.
    responses.extend((0..8).map(|_| {
        (
            503,
            json!({"error": {"message": "test summary failure"}}).to_string(),
        )
    }));
    // The next recovery succeeds on its third retry after an empty response,
    // an API failure, and malformed JSON.
    responses.extend([
        (200, completion("   ", false)),
        (
            503,
            json!({"error": {"message": "temporary summary failure"}}).to_string(),
        ),
        (200, "invalid JSON".to_string()),
        (200, completion("Recovered ninth summary", false)),
        (200, completion(&continuity, false)),
        (200, completion("Tenth chapter: escape.", true)),
    ]);
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        let mut responses = responses.into_iter();
        while let Some(response) = responses.next() {
            let mut pending = Some(response);
            while let Some((status, body)) = pending.take() {
                let (mut socket, _) = timeout(Duration::from_secs(15), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                let (header_end, length) = loop {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .map_or(0, |value| value.parse::<usize>().unwrap());
                        break (end + 4, length);
                    }
                };
                while request.len() < header_end + length {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                let (status, body) = if request.starts_with(b"GET /v1/models ") {
                    pending = Some((status, body));
                    (200, json!({"data": []}).to_string())
                } else {
                    assert!(request.starts_with(b"POST /v1/chat/completions "));
                    requests.push(
                        serde_json::from_slice::<Value>(&request[header_end..header_end + length])
                            .unwrap(),
                    );
                    (status, body)
                };
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            status,
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        }
        requests
    });
    let novel = TestNovel(format!("novel_recovery_test_{}.txt", uuid::Uuid::new_v4()));
    let mut meta = NovelMetadata::new("English", 10, "seed");
    meta.current_chapter = 8;
    meta.target_tokens = 1000;
    meta.story_state = "OPEN: trusted saved state through eight".into();
    meta.recent_chapters.push_back(ChapterMemory {
        chapter: 8,
        summary: "Eighth summary".into(),
    });
    // Earlier chapters are deliberately absent: recovery must not read or summarize them.
    let mut text = "Chapter 8\nSaved eighth chapter.\n".to_string();
    for attempt in 0..3 {
        let result = timeout(
            Duration::from_secs(15),
            generate_novel_stream(
                params(&base, &novel.0, &text, &meta),
                tauri::ipc::Channel::new(|_| Ok(())),
                Arc::new(AtomicBool::new(false)),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        if attempt < 2 {
            assert!(result
                .error
                .as_ref()
                .unwrap()
                .to_ascii_lowercase()
                .contains("summary"));
            assert!(result
                .error
                .as_ref()
                .unwrap()
                .contains("3 retries (4 attempts)"));
            assert_eq!(result.metadata.current_chapter, 9);
            assert_eq!(result.metadata.memory_rebuild_from_chapter, Some(9));
            assert_eq!(result.metadata.story_state, meta.story_state);
            assert_eq!(result.metadata.recent_chapters.len(), 1);
        } else {
            assert!(result.error.is_none(), "{:?}", result.error);
            assert_eq!(result.metadata.current_chapter, 10);
            assert_eq!(result.metadata.memory_rebuild_from_chapter, None);
            assert!(!result.metadata.needs_memory_rebuild);
            assert_eq!(result.metadata.recent_chapters.len(), 2);
            assert_eq!(
                result.metadata.recent_chapters.back().unwrap().summary,
                "Recovered ninth summary"
            );
        }
        text = result.full_text;
        // Reload metadata from disk, as both single and batch resumes do.
        meta = serde_json::from_str(
            &std::fs::read_to_string(output_json_dir().join(novel_metadata_filename(&novel.0)))
                .unwrap(),
        )
        .unwrap();
    }
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 15);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["stream"] == true)
            .count(),
        2
    );
    for request in &requests[1..13] {
        let prompt = request["messages"][1]["content"].as_str().unwrap();
        assert!(prompt.contains("Ninth chapter: rescue."));
        assert!(!prompt.contains("Saved eighth chapter."));
    }
    assert!(requests[13]["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("trusted saved state through eight"));
    assert!(requests[14]["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("Recovered ninth summary"));
}
