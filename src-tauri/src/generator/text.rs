use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

const SUMMARY_INPUT_CHARS_PER_TARGET_TOKEN: usize = 4;
const SUMMARY_INPUT_MIN_CHARS: usize = 4000;
pub(crate) const SUMMARY_INPUT_MAX_CHARS: usize = 120_000;

static RE_CHAPTER_PLOT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?im)(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:\*\*)?\[?\s*(?:(?:Chapter|Ch\.?)\s*([0-9０-９]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)|제?\s*([0-9０-９]+)\s*장|第?\s*([0-9０-９一二三四五六七八九十百]+)\s*章)",
    )
    .unwrap()
});
static RE_PLOT_PART_HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?im)(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:\*\*)?\[?\s*(?:(?:제\s*)?[0-9０-９]+\s*부|第\s*[0-9０-９一二三四五六七八九十百]+\s*部|part\s*(?:[0-9０-９]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))(?:\s*[:：\-–—].*)?\s*(?:\]|\*\*)?\s*$",
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
static RE_THINK_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<think>.*?</think>").unwrap());

fn normalize_number_token(raw: &str) -> String {
    raw.trim()
        .chars()
        .map(|ch| {
            if ('０'..='９').contains(&ch) {
                char::from_u32(ch as u32 - 0xfee0).unwrap_or(ch)
            } else {
                ch
            }
        })
        .collect::<String>()
}

fn parse_plot_number_token(raw: &str) -> Option<u32> {
    let token = normalize_number_token(raw);
    if token.is_empty() {
        return None;
    }

    token
        .parse::<u32>()
        .ok()
        .or_else(|| parse_english_number(&token))
        .or_else(|| parse_roman_number(&token))
        .or_else(|| parse_japanese_number(&token))
}

fn parse_english_number(raw: &str) -> Option<u32> {
    match raw.trim().to_ascii_lowercase().replace('-', " ").as_str() {
        "one" => Some(1),
        "two" => Some(2),
        "three" => Some(3),
        "four" => Some(4),
        "five" => Some(5),
        "six" => Some(6),
        "seven" => Some(7),
        "eight" => Some(8),
        "nine" => Some(9),
        "ten" => Some(10),
        "eleven" => Some(11),
        "twelve" => Some(12),
        "thirteen" => Some(13),
        "fourteen" => Some(14),
        "fifteen" => Some(15),
        "sixteen" => Some(16),
        "seventeen" => Some(17),
        "eighteen" => Some(18),
        "nineteen" => Some(19),
        "twenty" => Some(20),
        "thirty" => Some(30),
        "forty" => Some(40),
        "fifty" => Some(50),
        _ => None,
    }
}

fn parse_roman_number(raw: &str) -> Option<u32> {
    let mut total = 0i32;
    let mut previous = 0i32;
    let mut saw_roman = false;

    for ch in raw.trim().to_ascii_uppercase().chars().rev() {
        let value = match ch {
            'I' => 1,
            'V' => 5,
            'X' => 10,
            'L' => 50,
            'C' => 100,
            'D' => 500,
            'M' => 1000,
            _ => return None,
        };
        saw_roman = true;
        if value < previous {
            total -= value;
        } else {
            total += value;
            previous = value;
        }
    }

    if saw_roman && total > 0 {
        Some(total as u32)
    } else {
        None
    }
}

fn parse_japanese_number(raw: &str) -> Option<u32> {
    let mut total = 0u32;
    let mut current = 0u32;
    let mut saw_number = false;

    for ch in raw.trim().chars() {
        match ch {
            '零' | '〇' => {
                saw_number = true;
            }
            '一' => {
                current = 1;
                saw_number = true;
            }
            '二' => {
                current = 2;
                saw_number = true;
            }
            '三' => {
                current = 3;
                saw_number = true;
            }
            '四' => {
                current = 4;
                saw_number = true;
            }
            '五' => {
                current = 5;
                saw_number = true;
            }
            '六' => {
                current = 6;
                saw_number = true;
            }
            '七' => {
                current = 7;
                saw_number = true;
            }
            '八' => {
                current = 8;
                saw_number = true;
            }
            '九' => {
                current = 9;
                saw_number = true;
            }
            '十' => {
                total += if current == 0 { 10 } else { current * 10 };
                current = 0;
                saw_number = true;
            }
            '百' => {
                total += if current == 0 { 100 } else { current * 100 };
                current = 0;
                saw_number = true;
            }
            _ => return None,
        }
    }

    let value = total + current;
    if saw_number && value > 0 {
        Some(value)
    } else {
        None
    }
}

fn next_part_heading_start_after(plot_text: &str, start: usize) -> Option<usize> {
    RE_PLOT_PART_HEADING
        .find_iter(plot_text)
        .map(|item| item.start())
        .find(|part_start| *part_start > start)
}

pub fn split_plot_into_chapters(plot_text: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let matches: Vec<_> = RE_CHAPTER_PLOT.captures_iter(plot_text).collect();
    for i in 0..matches.len() {
        let cap = &matches[i];
        let num = cap
            .get(1)
            .or(cap.get(2))
            .or(cap.get(3))
            .and_then(|m| parse_plot_number_token(m.as_str()))
            .unwrap_or(0);

        let start = cap.get(0).unwrap().end();
        let next_chapter_start = if i + 1 < matches.len() {
            matches[i + 1].get(0).unwrap().start()
        } else {
            plot_text.len()
        };
        let end = next_part_heading_start_after(plot_text, start)
            .filter(|part_start| *part_start < next_chapter_start)
            .unwrap_or(next_chapter_start);

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_plot_into_chapters_stops_before_next_part_heading() {
        let plot = "제 1부\n제 1장\n내용: 첫 장\n제 2부: 전환\n제 2장\n내용: 둘째 장";
        let chapters = split_plot_into_chapters(plot);

        assert_eq!(chapters.get(&1).map(String::as_str), Some("내용: 첫 장"));
        assert_eq!(chapters.get(&2).map(String::as_str), Some("내용: 둘째 장"));
    }

    #[test]
    fn split_plot_into_chapters_accepts_word_and_kanji_numbers() {
        let plot = "Part One\nChapter One\nContent: first\nPart Two\n第 二 章\n内容: second";
        let chapters = split_plot_into_chapters(plot);

        assert_eq!(chapters.get(&1).map(String::as_str), Some("Content: first"));
        assert_eq!(chapters.get(&2).map(String::as_str), Some("内容: second"));
    }
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

    // 3b. Alternative <think> tags
    let text = RE_THINK_BLOCK.replace_all(&text, "");

    // 4. Individual leaked tokens
    text.replace("<|channel>thought", "")
        .replace("<channel|>", "")
        .replace("<|thought|>", "")
        .replace("<thought>", "")
        .replace("</thought>", "")
        .replace("<think>", "")
        .replace("</think>", "")
        .trim()
        .to_string()
}
