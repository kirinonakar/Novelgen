//! Resume chapter detection and local manuscript filename allocation.
use super::super::text::split_full_text_into_chapters;
use crate::paths::get_base_dir;
use std::fs;

pub fn suggest_next_chapter(text: &str, lang: &str, last_completed_ch: Option<u32>) -> u32 {
    let chapters = split_full_text_into_chapters(text, lang);
    let detected_completed_ch = chapters.keys().max().cloned().unwrap_or(0);
    let completed_ch = last_completed_ch.unwrap_or(0).max(detected_completed_ch);
    completed_ch + 1
}

pub fn get_next_novel_filename() -> String {
    let base = get_base_dir();
    let mut dir = base.clone();
    dir.push("output");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }

    let now = chrono::Local::now();
    let date_str = now.format("%Y%m%d").to_string();
    let prefix = format!("novel_{}_", date_str);

    let mut max_num = 0;
    let checkpoints = dir.join(".checkpoints");
    for scan_dir in [&dir, &checkpoints] {
        if let Ok(entries) = fs::read_dir(scan_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    let name = if scan_dir == &checkpoints {
                        name.strip_suffix(".json").unwrap_or(name)
                    } else {
                        name
                    };
                    if name.starts_with(&prefix) && name.ends_with(".txt") {
                        let seq_part = &name[prefix.len()..name.len() - 4];
                        if let Ok(num) = seq_part.parse::<u32>() {
                            max_num = max_num.max(num);
                        }
                    }
                }
            }
        }
    }
    format!("{}{:04}.txt", prefix, max_num + 1)
}
