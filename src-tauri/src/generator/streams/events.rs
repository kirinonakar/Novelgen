//! Chapter-scoped IPC updates and UTF-16 manuscript offsets.
use super::super::types::StreamEvent;

pub(super) struct NovelEventSender {
    channel: tauri::ipc::Channel<StreamEvent>,
    base_byte: usize,
    base_utf16: usize,
}

impl NovelEventSender {
    pub(super) fn new(channel: tauri::ipc::Channel<StreamEvent>, initial_text: &str) -> Self {
        Self {
            channel,
            base_byte: initial_text.len(),
            base_utf16: initial_text.encode_utf16().count(),
        }
    }

    pub(super) fn begin_chapter(&mut self, text: &str) {
        self.base_utf16 += text[self.base_byte..].encode_utf16().count();
        self.base_byte = text.len();
    }

    pub(super) fn full(
        &self,
        text: &str,
        finished: bool,
        error: Option<String>,
        status: Option<String>,
    ) -> Result<(), tauri::Error> {
        let mut event =
            StreamEvent::full(text[self.base_byte..].to_string(), finished, error, status);
        event.replace_from = Some(self.base_utf16);
        self.channel.send(event)
    }

    pub(super) fn preview(&self, content: String, status: String) -> Result<(), tauri::Error> {
        self.channel
            .send(StreamEvent::chapter_preview(content, status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::Arc;

    #[test]
    fn novel_events_send_only_current_chapter_with_utf16_offsets_and_rollback() {
        use std::sync::Mutex;
        use tauri::ipc::{Channel, InvokeResponseBody};

        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        let channel = Channel::new(move |body| {
            let InvokeResponseBody::Json(body) = body else {
                panic!("expected JSON event")
            };
            received
                .lock()
                .unwrap()
                .push(serde_json::from_str::<Value>(&body).unwrap());
            Ok(())
        });
        let prefix = "이전 장 😀\n".repeat(100_000);
        let mut sender = NovelEventSender::new(channel, &prefix);
        sender
            .full(&prefix, false, None, Some("Reconstructing context".into()))
            .unwrap();
        sender.begin_chapter(&prefix);
        let second = format!("{}\nChapter 101\n새 본문.\n", prefix);
        sender.full(&second, false, None, None).unwrap();
        sender.begin_chapter(&second);
        sender
            .full(&format!("{}\nChapter 102\n", second), false, None, None)
            .unwrap();
        sender
            .full(&second, true, Some("Stopped".into()), None)
            .unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events[0]["content"], "");
        assert_eq!(events[1]["replace_from"], prefix.encode_utf16().count());
        assert_eq!(events[1]["content"], "\nChapter 101\n새 본문.\n");
        assert_eq!(events[2]["replace_from"], second.encode_utf16().count());
        assert_eq!(events[3]["content"], "");
        assert_eq!(events[3]["replace_from"], second.encode_utf16().count());
        assert!(serde_json::to_string(&*events).unwrap().len() < 1000);
    }
}
