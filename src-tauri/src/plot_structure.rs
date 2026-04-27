use crate::continuity_json::sanitize_keywords;
use regex::Regex;
use std::sync::LazyLock;

static RE_TITLE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^\s*(?:\d+[.)]\s*)?(?:제목|작품명|title|novel\s+title|タイトル|題名|作品名)\s*[:：-]\s*(.+?)\s*$")
        .unwrap()
});
static RE_TITLE_SECTION_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^\s*(?:[#>*-]\s*)*(?:\*\*)?\s*(?:\d+[.)]\s*)?(?:제목|작품명|title|novel\s+title|タイトル|題名|作品名)\s*(?:[:：-]\s*)?(?:\*\*)?\s*$")
        .unwrap()
});
static RE_HEADING_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*#\s+(.+?)\s*$").unwrap());
static RE_PART_HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?im)^\s*(?:[-*]\s*)?(?:\*\*)?\s*\[?\s*(?P<label>(?:제\s*[0-9]+\s*부)|(?:第\s*[0-9一二三四五六七八九十百]+\s*部)|(?:part\s*(?:[0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)))\s*(?:[:：\-–—]\s*(?P<name>[^\]\n*]+?))?\s*\]?\s*(?:\*\*)?\s*$",
    )
    .unwrap()
});
static RE_CHAPTER_ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:Chapter|Ch\.?)\s*([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)|제?\s*([0-9]+)\s*장|第?\s*([0-9一二三四五六七八九十百]+)\s*章",
    )
    .unwrap()
});
const AUTO_ARC_MAX_CHAPTERS: usize = 8;

#[derive(Debug, Clone)]
pub struct PlotArcBoundary {
    pub name: String,
    pub start_chapter: u32,
    pub end_chapter: u32,
    pub summary_items: Vec<String>,
    pub keywords: Vec<String>,
    pub label: Option<String>,
    pub inferred: bool,
}

pub fn extract_novel_title(plot_outline: &str) -> Option<String> {
    for cap in RE_TITLE_LINE.captures_iter(plot_outline) {
        if let Some(title) = cap.get(1).and_then(|item| clean_title(item.as_str())) {
            return Some(title);
        }
    }

    let lines = plot_outline.lines().collect::<Vec<_>>();
    for (idx, line) in lines.iter().enumerate() {
        if !RE_TITLE_SECTION_LINE.is_match(line) {
            continue;
        }

        if let Some(title) = title_from_following_line(&lines, idx + 1) {
            return Some(title);
        }
    }

    for cap in RE_HEADING_LINE.captures_iter(plot_outline) {
        let Some(raw) = cap.get(1).map(|item| item.as_str()) else {
            continue;
        };
        let normalized = raw.trim();
        let lower = normalized.to_ascii_lowercase();
        if normalized.contains('장')
            || normalized.contains('章')
            || normalized.contains('部')
            || lower.starts_with("chapter")
            || lower.starts_with("ch.")
            || lower.starts_with("part")
        {
            continue;
        }
        if let Some(title) = clean_title(normalized) {
            return Some(title);
        }
    }

    None
}

fn title_from_following_line(lines: &[&str], start: usize) -> Option<String> {
    for line in lines.iter().skip(start) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if looks_like_non_title_outline_section(trimmed) {
            return None;
        }

        if let Some(title) = clean_title(trimmed) {
            return Some(title);
        }
    }

    None
}

fn looks_like_non_title_outline_section(line: &str) -> bool {
    let normalized = clean_inline_markup(line)
        .trim_start_matches(|c: char| matches!(c, '#' | '-' | '*' | '>' | ' ' | '\t'))
        .trim()
        .to_string();

    let Some((number, rest)) = split_numbered_heading(&normalized) else {
        return false;
    };

    if number <= 1 {
        return false;
    }

    let lower = rest.to_ascii_lowercase();
    rest.contains("핵심")
        || rest.contains("주제")
        || rest.contains("등장인물")
        || rest.contains("세계관")
        || rest.contains("각 장")
        || rest.contains("장 제목")
        || rest.contains("設定")
        || rest.contains("登場")
        || rest.contains("世界")
        || rest.contains("章")
        || lower.contains("theme")
        || lower.contains("style")
        || lower.contains("character")
        || lower.contains("world")
        || lower.contains("setting")
        || lower.contains("chapter")
}

fn split_numbered_heading(text: &str) -> Option<(u32, &str)> {
    let trimmed = text.trim();
    let marker_idx = trimmed.find(|ch: char| matches!(ch, '.' | ')'))?;
    let number = trimmed[..marker_idx].trim().parse::<u32>().ok()?;
    let rest = trimmed[marker_idx + 1..].trim();
    Some((number, rest))
}

pub fn split_plot_into_arc_boundaries(plot_outline: &str) -> Vec<PlotArcBoundary> {
    let matches = RE_PART_HEADING
        .captures_iter(plot_outline)
        .collect::<Vec<_>>();
    let mut boundaries = Vec::new();

    for (idx, cap) in matches.iter().enumerate() {
        let name = cap
            .name("name")
            .map(|item| clean_inline_markup(item.as_str()))
            .filter(|item| !item.is_empty())
            .or_else(|| {
                cap.name("label")
                    .map(|item| clean_inline_markup(item.as_str()))
            })
            .unwrap_or_else(|| "Part".to_string());
        let section_start = cap.get(0).map(|item| item.end()).unwrap_or(0);
        let section_end = matches
            .get(idx + 1)
            .and_then(|next| next.get(0))
            .map(|item| item.start())
            .unwrap_or(plot_outline.len());
        let section = &plot_outline[section_start..section_end];
        let chapters = split_section_chapters(section);
        if chapters.is_empty() {
            continue;
        }

        let start_chapter = chapters
            .iter()
            .map(|(chapter, _)| *chapter)
            .min()
            .unwrap_or(1);
        let end_chapter = chapters
            .iter()
            .map(|(chapter, _)| *chapter)
            .max()
            .unwrap_or(start_chapter);
        let summary_items = build_summary_items(&name, start_chapter, end_chapter, &chapters);
        let keyword_source = std::iter::once(name.clone())
            .chain(summary_items.clone())
            .collect::<Vec<_>>();
        let keywords = sanitize_keywords(&keyword_source)
            .into_iter()
            .take(8)
            .collect();

        let label = cap.name("label").map(|item| item.as_str().trim().to_string());

        boundaries.push(PlotArcBoundary {
            name,
            start_chapter,
            end_chapter,
            summary_items,
            keywords,
            label,
            inferred: false,
        });
    }

    if boundaries.is_empty() {
        boundaries = split_chapter_only_outline_into_auto_arc_boundaries(plot_outline);
    }

    boundaries.sort_by_key(|boundary| (boundary.start_chapter, boundary.end_chapter));
    boundaries
}

pub fn planned_arc_guidance_for_chapter(
    boundaries: &[PlotArcBoundary],
    current_arc_start_chapter: u32,
    latest_chapter: u32,
    total_chapters: u32,
) -> String {
    let Some(boundary) = boundaries
        .iter()
        .find(|item| item.start_chapter <= latest_chapter && latest_chapter <= item.end_chapter)
    else {
        return "No explicit planned part boundary was detected for this chapter.".to_string();
    };

    let next_boundary = boundaries
        .iter()
        .find(|item| item.start_chapter == boundary.end_chapter.saturating_add(1));
    let mut lines = if boundary.inferred {
        vec![
            "No explicit planned part heading was detected, so chapters were grouped into automatic memory arcs to prevent continuity compression loss.".to_string(),
            format!(
                "Inferred memory arc: {} (Chapters {}-{}). Current memory arc started at Chapter {}.",
                boundary.name, boundary.start_chapter, boundary.end_chapter, current_arc_start_chapter
            ),
        ]
    } else {
        vec![format!(
            "Planned part: {} (Chapters {}-{}). Current memory arc started at Chapter {}.",
            boundary.name, boundary.start_chapter, boundary.end_chapter, current_arc_start_chapter
        )]
    };

    if latest_chapter >= boundary.end_chapter && latest_chapter < total_chapters {
        lines.push(format!(
            "Chapter {} is the planned end of this part. If its main short-term objective has reached a stopping point, close the current arc and summarize it.",
            boundary.end_chapter
        ));
    } else {
        lines.push(format!(
            "Keep this part open unless the latest chapter truly resolves its active short-term objective before Chapter {}.",
            boundary.end_chapter
        ));
    }

    if let Some(next) = next_boundary {
        lines.push(format!(
            "Next planned part: {} (starts at Chapter {}).",
            next.name, next.start_chapter
        ));
    }

    lines.join("\n")
}

fn split_chapter_only_outline_into_auto_arc_boundaries(plot_outline: &str) -> Vec<PlotArcBoundary> {
    let chapters = split_section_chapters(plot_outline);
    if chapters.is_empty() {
        return Vec::new();
    }

    chapters
        .chunks(AUTO_ARC_MAX_CHAPTERS)
        .enumerate()
        .filter_map(|(idx, chunk)| {
            let start_chapter = chunk.iter().map(|(chapter, _)| *chapter).min()?;
            let end_chapter = chunk.iter().map(|(chapter, _)| *chapter).max()?;
            let name = format!("Auto Memory Arc {}", idx + 1);
            let summary_items = build_summary_items(&name, start_chapter, end_chapter, chunk);
            let keyword_source = std::iter::once(name.clone())
                .chain(summary_items.clone())
                .collect::<Vec<_>>();
            let keywords = sanitize_keywords(&keyword_source)
                .into_iter()
                .take(8)
                .collect();

            Some(PlotArcBoundary {
                name,
                start_chapter,
                end_chapter,
                summary_items,
                keywords,
                label: None,
                inferred: true,
            })
        })
        .collect()
}

fn split_section_chapters(section: &str) -> Vec<(u32, String)> {
    let matches = RE_CHAPTER_ENTRY.captures_iter(section).collect::<Vec<_>>();
    let mut chapters = Vec::new();

    for idx in 0..matches.len() {
        let cap = &matches[idx];
        let chapter = cap
            .get(1)
            .or_else(|| cap.get(2))
            .or_else(|| cap.get(3))
            .and_then(|item| parse_number_token(item.as_str()))
            .unwrap_or(0);
        if chapter == 0 {
            continue;
        }

        let start = cap.get(0).map(|item| item.end()).unwrap_or(0);
        let end = matches
            .get(idx + 1)
            .and_then(|next| next.get(0))
            .map(|item| item.start())
            .unwrap_or(section.len());
        let body = clean_outline_fragment(&section[start..end]);
        chapters.push((chapter, body));
    }

    chapters.sort_by_key(|(chapter, _)| *chapter);
    chapters
}

fn build_summary_items(
    name: &str,
    start_chapter: u32,
    end_chapter: u32,
    chapters: &[(u32, String)],
) -> Vec<String> {
    let mut items = vec![format!(
        "ARC: {} covered Chapters {}-{}.",
        name, start_chapter, end_chapter
    )];

    for (chapter, body) in chapters {
        if body.is_empty() {
            continue;
        }
        items.push(format!(
            "ARC: Chapter {} - {}",
            chapter,
            truncate_chars(body, 140)
        ));
        if items.len() >= 8 {
            break;
        }
    }

    items
}

fn clean_title(raw: &str) -> Option<String> {
    let title = clean_inline_markup(raw)
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '[' | ']'))
        .trim()
        .to_string();

    if title.is_empty()
        || title.eq_ignore_ascii_case("novel")
        || title.eq_ignore_ascii_case("untitled")
    {
        None
    } else {
        Some(title)
    }
}

fn clean_outline_fragment(raw: &str) -> String {
    clean_inline_markup(raw)
        .trim_start_matches(|c: char| matches!(c, ':' | '：' | '-' | '–' | '—' | ' ' | '\t'))
        .trim()
        .to_string()
}

fn parse_number_token(raw: &str) -> Option<u32> {
    let token = raw.trim();
    if token.is_empty() {
        return None;
    }

    if let Ok(value) = token.parse::<u32>() {
        return Some(value);
    }

    parse_english_number(token)
        .or_else(|| parse_roman_number(token))
        .or_else(|| parse_japanese_number(token))
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

fn clean_inline_markup(raw: &str) -> String {
    raw.replace("**", "")
        .replace("__", "")
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut truncated = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        truncated.push_str("...");
    }
    truncated
}
