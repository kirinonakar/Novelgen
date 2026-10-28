//! Select and compact plot sections for the chapter being written.
use crate::plot_structure::{format_part_heading_label, PlotArcBoundary};
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

const FOCUSED_PLOT_CONTEXT_MIN_CHAPTERS: u32 = 13;

static RE_FOCUSED_PART_HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?im)(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:\*\*)?\[?\s*(?:(?:제\s*)?[0-9０-９]+\s*부|第\s*[0-9０-９一二三四五六七八九十百]+\s*部|part\s*(?:[0-9０-９]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))(?:\s*[:：\-–—].*)?\s*(?:\]|\*\*)?\s*$",
    )
    .unwrap()
});

fn format_plot_chapter_heading(language: &str, chapter: u32) -> String {
    match language {
        "Korean" => format!("제 {}장", chapter),
        "Japanese" => format!("第 {} 章", chapter),
        _ => format!("Chapter {}", chapter),
    }
}

fn plot_part_heading(boundary: &PlotArcBoundary, language: &str, ordinal: usize) -> String {
    let fallback = format_part_heading_label(language, ordinal as u32);
    let label = boundary
        .label
        .as_deref()
        .filter(|item| !item.trim().is_empty())
        .unwrap_or(&fallback);
    let name = boundary.name.trim();

    if name.is_empty() || name.eq_ignore_ascii_case(label.trim()) || name == "Part" {
        label.trim().to_string()
    } else {
        format!("{}: {}", label.trim(), name)
    }
}

fn compact_title_label(language: &str) -> &'static str {
    match language {
        "Korean" => "제목",
        "Japanese" => "タイトル",
        _ => "Title",
    }
}

fn compact_content_label(language: &str) -> &'static str {
    match language {
        "Korean" => "내용",
        "Japanese" => "内容",
        _ => "Content",
    }
}

fn clean_outline_line(line: &str) -> String {
    line.trim()
        .trim_start_matches(|ch: char| {
            matches!(
                ch,
                '#' | '-'
                    | '*'
                    | '+'
                    | '>'
                    | '['
                    | ']'
                    | ':'
                    | '：'
                    | '.'
                    | ')'
                    | '、'
                    | ' '
                    | '\t'
            )
        })
        .trim_end_matches(|ch: char| matches!(ch, '*' | ']' | ' ' | '\t'))
        .trim()
        .to_string()
}

fn strip_label_value<'a>(line: &'a str, labels: &[&str]) -> Option<&'a str> {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();

    labels.iter().find_map(|label| {
        let label_lower = label.to_ascii_lowercase();
        if lower.starts_with(&label_lower) {
            let value = trimmed[label.len()..]
                .trim_start_matches(|ch: char| matches!(ch, ':' | '：' | '-' | ' ' | '\t'))
                .trim();
            Some(value)
        } else {
            None
        }
    })
}

fn title_value_from_line(line: &str) -> Option<String> {
    strip_label_value(
        line,
        &[
            "제목",
            "장 제목",
            "타이틀",
            "タイトル",
            "章タイトル",
            "Title",
            "Chapter Title",
        ],
    )
    .map(clean_outline_line)
    .filter(|item| !item.is_empty())
}

fn content_value_from_line(line: &str) -> Option<String> {
    strip_label_value(line, &["내용", "本文", "Content", "Synopsis"])
        .map(str::trim)
        .map(str::to_string)
}

fn is_content_label(line: &str) -> bool {
    content_value_from_line(line).is_some()
}

fn is_compact_stop_label(line: &str) -> bool {
    let cleaned = clean_outline_line(line);
    let lower = cleaned.to_ascii_lowercase();

    cleaned.starts_with("핵심 포인트")
        || cleaned.starts_with("중요 포인트")
        || cleaned.starts_with("重要ポイント")
        || cleaned.starts_with("要点")
        || lower.starts_with("key points")
        || lower.starts_with("chapter_function")
        || lower.starts_with("primary_function")
        || lower.starts_with("secondary_function")
        || lower.starts_with("start_scene")
        || lower.starts_with("end_state")
        || lower.starts_with("end_hook")
        || lower.starts_with("must_include")
        || lower.starts_with("must_not_include")
        || lower.starts_with("not_this_chapter")
        || lower.starts_with("chapter_keywords")
        || lower.starts_with("reveal_or_knowledge_step")
        || lower.starts_with("external_threat")
        || lower.starts_with("relationship_drama")
        || lower.starts_with("mystery")
        || lower.starts_with("combat")
        || lower.starts_with("comedy")
        || lower.starts_with("intensity")
}

fn compact_title_from_content_text(text: &str) -> Option<String> {
    let cleaned = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch: char| {
            matches!(
                ch,
                '"' | '\'' | '“' | '”' | '‘' | '’' | '「' | '」' | '『' | '』' | ' ' | '\t'
            )
        })
        .trim()
        .to_string();

    if cleaned.is_empty() {
        return None;
    }

    let mut title = String::new();
    for ch in cleaned.chars() {
        if matches!(ch, '.' | '!' | '?' | '。' | '！' | '？' | '\n' | '\r') {
            break;
        }
        title.push(ch);
        if title.chars().count() >= 44 {
            break;
        }
    }

    let title = title.trim().to_string();
    if title.is_empty() {
        None
    } else if cleaned.chars().count() > title.chars().count() {
        Some(format!("{}...", title.trim_end()))
    } else {
        Some(title)
    }
}

fn infer_chapter_title(lines: &[String]) -> String {
    for line in lines {
        if let Some(title) = title_value_from_line(line) {
            return title;
        }
    }

    if let Some(title) = lines
        .iter()
        .map(|line| clean_outline_line(line))
        .find(|line| {
            !line.is_empty()
                && !is_content_label(line)
                && !is_compact_stop_label(line)
                && line.chars().count() <= 120
        })
    {
        return title;
    }

    for line in lines {
        if let Some(content) = content_value_from_line(line) {
            if let Some(title) = compact_title_from_content_text(&content) {
                return title;
            }
        }
    }

    "Untitled".to_string()
}

fn compact_chapter_plot(chapter_body: &str, language: &str) -> String {
    let lines = chapter_body
        .lines()
        .map(clean_outline_line)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let title = infer_chapter_title(&lines);
    let mut content_lines = Vec::new();

    if let Some(content_index) = lines.iter().position(|line| is_content_label(line)) {
        if let Some(value) = content_value_from_line(&lines[content_index]) {
            if !value.trim().is_empty() {
                content_lines.push(value.trim().to_string());
            }
        }
        for line in lines.iter().skip(content_index + 1) {
            if is_compact_stop_label(line) {
                break;
            }
            content_lines.push(line.to_string());
        }
    } else {
        for line in &lines {
            if is_compact_stop_label(line) {
                break;
            }
            if title_value_from_line(line).is_some() || clean_outline_line(line) == title {
                continue;
            }
            content_lines.push(line.to_string());
        }
    }

    let content = content_lines.join("\n").trim().to_string();
    format!(
        "{}: {}\n{}:\n{}",
        compact_title_label(language),
        title,
        compact_content_label(language),
        if content.is_empty() {
            chapter_body.trim()
        } else {
            content.as_str()
        }
    )
}

fn first_part_heading_start(plot_outline: &str) -> Option<usize> {
    RE_FOCUSED_PART_HEADING
        .find_iter(plot_outline)
        .map(|item| item.start())
        .next()
}

fn setup_sections_before_first_part(plot_outline: &str, boundaries: &[PlotArcBoundary]) -> String {
    let Some(first_boundary) = boundaries
        .iter()
        .min_by_key(|boundary| boundary.start_chapter)
    else {
        return plot_outline.trim().to_string();
    };

    first_part_heading_start(plot_outline)
        .map(|idx| plot_outline[..idx].trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| {
            let first_chapter = first_boundary.start_chapter;
            let marker = format_plot_chapter_heading("English", first_chapter);
            let localized_marker = format_plot_chapter_heading("Korean", first_chapter);
            let japanese_marker = format_plot_chapter_heading("Japanese", first_chapter);
            [marker, localized_marker, japanese_marker]
                .iter()
                .filter_map(|candidate| plot_outline.find(candidate))
                .min()
                .map(|idx| plot_outline[..idx].trim().to_string())
                .unwrap_or_default()
        })
}

pub(super) fn focused_plot_outline_for_chapter(
    full_plot_outline: &str,
    chapter_plots: &HashMap<u32, String>,
    boundaries: &[PlotArcBoundary],
    chapter: u32,
    total_chapters: u32,
    language: &str,
) -> String {
    if total_chapters < FOCUSED_PLOT_CONTEXT_MIN_CHAPTERS || boundaries.is_empty() {
        return full_plot_outline.to_string();
    }

    let current_part_index = boundaries
        .iter()
        .position(|boundary| boundary.start_chapter <= chapter && chapter <= boundary.end_chapter)
        .unwrap_or(0);
    let setup_sections = setup_sections_before_first_part(full_plot_outline, boundaries);
    let mut sections = Vec::new();
    if !setup_sections.trim().is_empty() {
        sections.push(setup_sections);
    }

    sections.push(
        "[Focused Master Plot Outline]\nFor long outlines, the previous/current/next parts are shown in full. More distant chapters are reduced to title and content only."
            .to_string(),
    );

    for (idx, boundary) in boundaries.iter().enumerate() {
        let include_full_part = idx.abs_diff(current_part_index) <= 1;
        let mut part_lines = vec![plot_part_heading(boundary, language, idx + 1)];

        for chapter_number in boundary.start_chapter..=boundary.end_chapter {
            let Some(chapter_body) = chapter_plots.get(&chapter_number) else {
                continue;
            };

            part_lines.push(format_plot_chapter_heading(language, chapter_number));
            if include_full_part {
                part_lines.push(chapter_body.trim().to_string());
            } else {
                part_lines.push(compact_chapter_plot(chapter_body, language));
            }
        }

        sections.push(part_lines.join("\n"));
    }

    sections.join("\n\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::text::split_plot_into_chapters;
    use crate::plot_structure::split_plot_into_arc_boundaries;

    #[test]
    fn focused_plot_context_keeps_adjacent_parts_full_and_compacts_distant_parts() {
        let mut plot =
            String::from("1. 제목\n테스트 소설\n\n2. 핵심 주제의식과 소설 스타일\n테스트 주제\n세계관에는 제 1부라는 시험명이 있다.\n\n");
        for part in 1..=3 {
            plot.push_str(&format!("제 {}부: 테스트 파트 {}\n", part, part));
            let start = (part - 1) * 4 + 1;
            let end = if part == 3 { 13 } else { part * 4 };
            for chapter in start..=end {
                let function = match part {
                    1 => "setup",
                    2 => "reveal",
                    _ => "climax",
                };
                plot.push_str(&format!(
                    "제 {}장: {}장 제목\n내용: {}장 내용\n핵심 포인트: {}장 포인트\nchapter_function: {}\n",
                    chapter, chapter, chapter, chapter, function
                ));
            }
        }
        let chapters = split_plot_into_chapters(&plot);
        let boundaries = split_plot_into_arc_boundaries(&plot);
        assert_eq!(boundaries.len(), 3, "{boundaries:?}");

        let focused =
            focused_plot_outline_for_chapter(&plot, &chapters, &boundaries, 10, 13, "Korean");

        assert!(focused.contains("chapter_function: climax"));
        assert!(focused.contains("chapter_function: reveal"));
        assert!(!focused.contains("chapter_function: setup"));
        assert!(focused.contains("세계관에는 제 1부라는 시험명이 있다."));
        assert_eq!(focused.matches("제 2부: 테스트 파트 2").count(), 1);
        assert_eq!(focused.matches("제 3부: 테스트 파트 3").count(), 1);
        assert!(focused.contains("제목: 1장 제목"));
        assert!(focused.contains("내용:\n1장 내용"));
        assert!(!focused.contains("핵심 포인트: 1장 포인트"));
    }

    #[test]
    fn focused_plot_context_is_disabled_under_thirteen_chapters() {
        let plot = "제 1부\n제 1장\n내용: 전체 유지\nchapter_function: setup";
        let chapters = split_plot_into_chapters(plot);
        let boundaries = split_plot_into_arc_boundaries(plot);

        let focused =
            focused_plot_outline_for_chapter(plot, &chapters, &boundaries, 1, 12, "Korean");

        assert_eq!(focused, plot);
    }

    #[test]
    fn compact_chapter_plot_infers_missing_title_from_content_label() {
        let compact = compact_chapter_plot(
            "내용: 사춘기가 시작되자마자 모든 학생이 머리 위의 상태창을 확인한다.\n핵심 포인트: 운명과 결함의 좌절감\nchapter_function: setup",
            "Korean",
        );

        assert!(
            compact.contains("제목: 사춘기가 시작되자마자 모든 학생이 머리 위의 상태창을 확인한다")
        );
        assert!(compact
            .contains("내용:\n사춘기가 시작되자마자 모든 학생이 머리 위의 상태창을 확인한다."));
        assert!(!compact.contains("핵심 포인트"));
        assert!(!compact.contains("Untitled"));
    }
}
