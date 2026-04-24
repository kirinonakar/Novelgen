use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

const SUMMARY_INPUT_CHARS_PER_TARGET_TOKEN: usize = 4;
const SUMMARY_INPUT_MIN_CHARS: usize = 4000;
pub(crate) const SUMMARY_INPUT_MAX_CHARS: usize = 120_000;

static RE_CHAPTER_PLOT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:Chapter\s*(\d+)|제?\s*(\d+)\s*장|第?\s*(\d+)\s*章)").unwrap()
});
static RE_GEN_ERROR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\n\n\[Generation Stopped/Error\].*$").unwrap());
static RE_CH_KOREAN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|\n)[#\s*]*제?\s*(\d+)\s*[장]").unwrap());
static RE_CH_JAPANESE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|\n)[#\s*]*第?\s*(\d+)\s*[장章]").unwrap());
static RE_CH_ENGLISH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|\n)[#\s*]*Chapter\s*(\d+)").unwrap());
static RE_THOUGHT_FULL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<\|channel>thought.*?<channel\|>").unwrap());
static RE_THOUGHT_UNCLOSED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<\|channel>thought.*$").unwrap());
static RE_THOUGHT_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<thought>.*?</thought>").unwrap());
static RE_THOUGHT_OPEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<thought>.*$").unwrap());

pub fn split_plot_into_chapters(plot_text: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let matches: Vec<_> = RE_CHAPTER_PLOT.captures_iter(plot_text).collect();
    for i in 0..matches.len() {
        let cap = &matches[i];
        // Try to get number from any of the capture groups
        let num: u32 = cap
            .get(1)
            .or(cap.get(2))
            .or(cap.get(3))
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);

        let start = cap.get(0).unwrap().end();
        let end = if i + 1 < matches.len() {
            matches[i + 1].get(0).unwrap().start()
        } else {
            plot_text.len()
        };

        if num > 0 {
            map.insert(num, plot_text[start..end].trim().to_string());
        }
    }
    map
}

pub fn split_full_text_into_chapters(text: &str, lang: &str) -> HashMap<u32, String> {
    let mut chapters = HashMap::new();
    // Removed error messages before splitting
    let contents = RE_GEN_ERROR.replace_all(text, "");

    let pattern = match lang {
        "Korean" => &RE_CH_KOREAN,
        "Japanese" => &RE_CH_JAPANESE,
        _ => &RE_CH_ENGLISH,
    };

    let matches: Vec<_> = pattern.captures_iter(&contents).collect();
    for i in 0..matches.len() {
        let cap = &matches[i];
        if let Some(m) = cap.get(1) {
            if let Ok(num) = m.as_str().parse::<u32>() {
                let start = cap.get(0).unwrap().end();
                let end = if i + 1 < matches.len() {
                    matches[i + 1].get(0).unwrap().start()
                } else {
                    contents.len()
                };
                chapters.insert(num, contents[start..end].trim().to_string());
            }
        }
    }
    chapters
}

pub(crate) fn summary_input_char_budget(target_tokens: u32) -> usize {
    let token_budget = target_tokens.saturating_add(1000).max(1000) as usize;
    token_budget
        .saturating_mul(SUMMARY_INPUT_CHARS_PER_TARGET_TOKEN)
        .clamp(SUMMARY_INPUT_MIN_CHARS, SUMMARY_INPUT_MAX_CHARS)
}

pub(crate) fn split_text_by_char_budget(text: &str, max_chars: usize) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let max_chars = max_chars.max(1);
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= max_chars {
        return vec![trimmed.to_string()];
    }

    let mut chunks = Vec::new();
    let mut start = 0;

    while start < chars.len() {
        let mut end = (start + max_chars).min(chars.len());

        if end < chars.len() {
            let min_split = start + (max_chars / 2).max(1);
            let split_at_newline = (min_split..end)
                .rev()
                .find(|idx| matches!(chars[*idx], '\n' | '\r'));
            let split_at_sentence = (min_split..end).rev().find(|idx| {
                matches!(
                    chars[*idx],
                    '.' | '!' | '?' | ';' | '。' | '！' | '？' | '…'
                )
            });

            if let Some(boundary) = split_at_newline.or(split_at_sentence) {
                end = (boundary + 1).min(chars.len());
            }
        }

        let chunk: String = chars[start..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        if !chunk.is_empty() {
            chunks.push(chunk);
        }

        start = end;
        while start < chars.len() && chars[start].is_whitespace() {
            start += 1;
        }
    }

    chunks
}

fn paragraph_boundary_end(chars: &[char], idx: usize) -> Option<usize> {
    if chars.get(idx) == Some(&'\n') && chars.get(idx + 1) == Some(&'\n') {
        Some(idx + 2)
    } else if chars.get(idx) == Some(&'\r')
        && chars.get(idx + 1) == Some(&'\n')
        && chars.get(idx + 2) == Some(&'\r')
        && chars.get(idx + 3) == Some(&'\n')
    {
        Some(idx + 4)
    } else {
        None
    }
}

pub(crate) fn tail_with_paragraph_boundary(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= max_chars {
        return trimmed.to_string();
    }

    let target_start = chars.len().saturating_sub(max_chars);
    let lookback_start = target_start.saturating_sub(max_chars);
    let mut start = target_start;

    for idx in (lookback_start..target_start).rev() {
        if let Some(boundary_end) = paragraph_boundary_end(&chars, idx) {
            start = boundary_end;
            break;
        }
    }

    if start == target_start {
        let min_remaining = (max_chars / 2).max(1);
        for idx in target_start..chars.len().saturating_sub(1) {
            if let Some(boundary_end) = paragraph_boundary_end(&chars, idx) {
                if chars.len().saturating_sub(boundary_end) >= min_remaining {
                    start = boundary_end;
                    break;
                }
            }
        }
    }

    while start < chars.len() && chars[start].is_whitespace() {
        start += 1;
    }

    chars[start..].iter().collect::<String>().trim().to_string()
}

pub fn clean_thought_tags(text: &str) -> String {
    // Ported from app.py: Remove internal reasoning tags like <|channel>thought ... <channel|>
    // 1. Complete blocks
    let text = RE_THOUGHT_FULL.replace_all(text, "");

    // 2. Unclosed blocks at the end of a stream
    let text = RE_THOUGHT_UNCLOSED.replace_all(&text, "");

    // 3. Alternative <thought> tags
    let text = RE_THOUGHT_BLOCK.replace_all(&text, "");
    let text = RE_THOUGHT_OPEN.replace_all(&text, "");

    // 4. Individual leaked tokens
    text.replace("<|channel>thought", "")
        .replace("<channel|>", "")
        .replace("<|thought|>", "")
        .replace("<thought>", "")
        .replace("</thought>", "")
        .trim()
        .to_string()
}
