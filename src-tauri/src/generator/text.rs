use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

const SUMMARY_INPUT_CHARS_PER_TARGET_TOKEN: usize = 4;
const SUMMARY_INPUT_MIN_CHARS: usize = 4000;
pub(crate) const SUMMARY_INPUT_MAX_CHARS: usize = 120_000;

static RE_CHAPTER_PLOT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?im)(?:^|\n)(?P<heading>\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:\*\*)?\[?\s*(?:Chapter\s*(?P<en>[0-9０-９]+)|제?\s*(?P<ko>[0-9０-９]+)\s*장|第?\s*(?P<ja>[0-9０-９]+)\s*章)(?:\s*(?:\]|\*\*))?)",
    )
    .unwrap()
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
    let matches = RE_CHAPTER_PLOT
        .captures_iter(plot_text)
        .filter_map(|cap| {
            let heading = cap.name("heading")?;
            if !is_chapter_heading_boundary(plot_text, heading.end()) {
                return None;
            }

            let num = cap
                .name("en")
                .or_else(|| cap.name("ko"))
                .or_else(|| cap.name("ja"))
                .and_then(|m| parse_chapter_number_token(m.as_str()))?;

            Some((cap.get(0)?.start(), heading.end(), num))
        })
        .collect::<Vec<_>>();

    for (idx, (_, content_start, num)) in matches.iter().enumerate() {
        let end = matches
            .get(idx + 1)
            .map(|(next_match_start, _, _)| *next_match_start)
            .unwrap_or(plot_text.len());

        map.insert(*num, plot_text[*content_start..end].trim().to_string());
    }
    map
}

fn is_chapter_heading_boundary(text: &str, pos: usize) -> bool {
    match text[pos..].chars().next() {
        None => true,
        Some(ch) => {
            ch.is_whitespace()
                || matches!(
                    ch,
                    ':' | '：' | '.' | ')' | '、' | ']' | '-' | '–' | '—' | '*'
                )
        }
    }
}

fn parse_chapter_number_token(raw: &str) -> Option<u32> {
    let normalized = raw
        .chars()
        .map(|ch| {
            if ('０'..='９').contains(&ch) {
                char::from_u32(ch as u32 - '０' as u32 + '0' as u32).unwrap_or(ch)
            } else {
                ch
            }
        })
        .collect::<String>();

    normalized.parse::<u32>().ok()
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

#[cfg(test)]
mod tests {
    use super::split_plot_into_chapters;

    #[test]
    fn split_plot_into_chapters_ignores_inline_chapter_mentions() {
        let plot = "\
1. 제목

5. 각 장 제목과 내용
제 1장: 시작
내용: 주인공은 제 2장의 사건을 예감하지만 아직 움직이지 않는다.
핵심 포인트: 복선만 남긴다.

제 2장: 사건
내용: 실제 사건이 시작된다.";

        let chapters = split_plot_into_chapters(plot);

        assert_eq!(chapters.len(), 2);
        assert!(chapters[&1].contains("제 2장의 사건을 예감"));
        assert!(chapters[&2].contains("실제 사건이 시작된다"));
    }

    #[test]
    fn split_plot_into_chapters_accepts_markdown_and_fullwidth_digits() {
        let plot = "\
## Part 1

### Chapter １: Opening
Content: The first chapter.

- **제 ２장**: 전환
내용: 두 번째 장.

第 ３ 章：終盤
内容: 三番目の章。";

        let chapters = split_plot_into_chapters(plot);

        assert_eq!(chapters.len(), 3);
        assert!(chapters[&1].contains("Opening"));
        assert!(chapters[&2].contains("두 번째 장"));
        assert!(chapters[&3].contains("三番目の章"));
    }

    #[test]
    fn split_plot_into_chapters_rejects_words_that_only_start_like_headings() {
        let plot = "\
제 1장면은 아직 장 제목이 아니다.

제 1장
내용: 진짜 첫 장.

Chapter 2b is not a chapter heading.

Chapter 2
Content: The real second chapter.";

        let chapters = split_plot_into_chapters(plot);

        assert_eq!(chapters.len(), 2);
        assert!(chapters[&1].contains("진짜 첫 장"));
        assert!(chapters[&2].contains("The real second chapter"));
    }
}
