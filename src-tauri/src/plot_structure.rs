use crate::continuity_json::sanitize_keywords;
use regex::Regex;
use std::collections::HashMap;
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
        r"(?im)(?:^|\n)(?P<heading>\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:\*\*)?\[?\s*(?:(?:Chapter|Ch\.?)\s*(?P<en>[0-9０-９]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)|제?\s*(?P<ko>[0-9０-９]+)\s*장|第?\s*(?P<ja>[0-9０-９一二三四五六七八九十百]+)\s*章)(?:\s*(?:\]|\*\*))?)",
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

#[derive(Debug, Clone, Copy)]
struct ChapterEntryMatch {
    match_start: usize,
    content_start: usize,
    chapter: u32,
}

#[derive(Debug, Clone, Copy)]
struct PartPlanBoundary {
    part: u32,
    start_chapter: u32,
    end_chapter: u32,
}

fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    value.min(max).max(min)
}

fn planned_part_boundaries(total_chapters: u32) -> Vec<PartPlanBoundary> {
    let total = total_chapters.max(1);
    if total <= 5 {
        return vec![PartPlanBoundary {
            part: 1,
            start_chapter: 1,
            end_chapter: total,
        }];
    }

    let min_parts_for_max_size = total.div_ceil(8);
    let max_parts_for_min_size = total / 3;
    let preferred_parts = total.div_ceil(5);
    let part_count = clamp_u32(
        preferred_parts,
        min_parts_for_max_size,
        max_parts_for_min_size,
    )
    .max(1);
    let base_size = total / part_count;
    let mut remainder = total % part_count;
    let mut start = 1;

    (0..part_count)
        .map(|index| {
            let size = base_size + u32::from(remainder > 0);
            remainder = remainder.saturating_sub(1);
            let end = start + size - 1;
            let boundary = PartPlanBoundary {
                part: index + 1,
                start_chapter: start,
                end_chapter: end,
            };
            start = end + 1;
            boundary
        })
        .collect()
}

pub fn format_part_heading_label(language: &str, ordinal: u32) -> String {
    match language {
        "Korean" => format!("제 {}부", ordinal),
        "Japanese" => format!("第 {} 部", ordinal),
        _ => format!("Part {}", ordinal),
    }
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

        let label = cap
            .name("label")
            .map(|item| item.as_str().trim().to_string());

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
    } else {
        boundaries.sort_by_key(|boundary| (boundary.start_chapter, boundary.end_chapter));
        let chapters = split_section_chapters(plot_outline);
        let total_chapters = chapters
            .iter()
            .map(|(chapter, _)| *chapter)
            .max()
            .unwrap_or(0);
        if explicit_part_boundaries_need_repair(&boundaries, total_chapters) {
            let planned_boundaries =
                split_chapters_into_planned_part_boundaries(&chapters, total_chapters);
            if !planned_boundaries.is_empty() {
                boundaries = planned_boundaries;
            }
        }
    }

    boundaries.sort_by_key(|boundary| (boundary.start_chapter, boundary.end_chapter));
    boundaries
}

fn parse_chapter_summary(body: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut title = None;
    let mut function = None;
    let mut outcome = None;

    for line in body.lines() {
        let trimmed = line.trim();

        if title.is_none() {
            if let Some(idx) = trimmed.to_ascii_lowercase().find("title:") {
                let rest = trimmed[idx + 6..].trim();
                title = Some(rest.to_string());
                continue;
            }
        }

        if function.is_none() {
            if let Some(idx) = trimmed.to_ascii_lowercase().find("chapter_function:") {
                let rest = trimmed[idx + 17..].trim();
                function = Some(rest.to_string());
                continue;
            }
        }

        if outcome.is_none() {
            if let Some(idx) = trimmed.to_ascii_lowercase().find("outcome_state:") {
                let rest = trimmed[idx + 14..].trim();
                outcome = Some(rest.to_string());
                continue;
            }
        }
    }

    (title, function, outcome)
}

fn format_omitted_timeline(
    chapter_map: &HashMap<u32, &str>,
    current_chapter: u32,
    language: &str,
) -> String {
    let omitted_start = 2;
    let omitted_end = current_chapter.saturating_sub(2);

    if omitted_start > omitted_end {
        return String::new();
    }

    let omit_msg = match language {
        "Korean" => format!("[... 제 {}장부터 제 {}장까지의 상세 계획은 생략되었습니다. 생략된 계획들의 연대기적 핵심 요약은 다음과 같습니다 ...]", omitted_start, omitted_end),
        "Japanese" => format!("[... 第 {} 章から第 {} 章までの詳細計画は省略されました。省略された計画の主要な出来事의まとめは以下の通りです ...]", omitted_start, omitted_end),
        _ => format!("[... Detailed plans for Chapter {} through Chapter {} are omitted for brevity. Below is the chronological summary of the omitted planned chapters ...]", omitted_start, omitted_end),
    };

    let mut summaries = Vec::new();
    summaries.push(omit_msg);

    for ch in omitted_start..=omitted_end {
        if let Some(body) = chapter_map.get(&ch) {
            let (title, function, outcome) = parse_chapter_summary(body);
            let ch_marker = match language {
                "Korean" => format!("제 {}장", ch),
                "Japanese" => format!("第 {} 章", ch),
                _ => format!("Chapter {}", ch),
            };

            let title_str = title.map(|t| format!(": {}", t)).unwrap_or_default();
            let mut summary_text = format!("* [{}{}]", ch_marker, title_str);

            let include_details = ch > omitted_end.saturating_sub(10);
            if include_details {
                let mut details = Vec::new();
                if let Some(func) = function {
                    let func_label = match language {
                        "Korean" => "핵심 기능",
                        "Japanese" => "主要機能",
                        _ => "Function",
                    };
                    details.push(format!("  - {}: {}", func_label, func));
                }
                if let Some(outc) = outcome {
                    let outcome_label = match language {
                        "Korean" => "결과 상태",
                        "Japanese" => "結果ステータス",
                        _ => "Outcome",
                    };
                    details.push(format!("  - {}: {}", outcome_label, outc));
                }

                if !details.is_empty() {
                    summary_text.push('\n');
                    summary_text.push_str(&details.join("\n"));
                }
            }
            summaries.push(summary_text);
        }
    }

    summaries.join("\n")
}

pub fn build_compressed_plot_context_for_chapter(
    plot_outline: &str,
    chapter: u32,
    total_chapters: u32,
    language: &str,
) -> Option<String> {
    let chapters = split_section_chapters(plot_outline);
    if chapters.is_empty() || !chapters.iter().any(|(item, _)| *item == chapter) {
        return None;
    }

    let chapter_map = chapters
        .iter()
        .map(|(number, body)| (*number, body.as_str()))
        .collect::<HashMap<_, _>>();
    let boundaries = split_plot_into_arc_boundaries(plot_outline);
    let current_boundary = boundaries
        .iter()
        .find(|item| item.start_chapter <= chapter && chapter <= item.end_chapter);
    let next_boundary = current_boundary.and_then(|boundary| {
        boundaries
            .iter()
            .find(|item| item.start_chapter == boundary.end_chapter.saturating_add(1))
    });

    let mut sections = Vec::new();
    sections.push(
        "[Compressed Plot Context]\nThe full plot outline is omitted because this novel has 13 or more chapters. Use this compressed context, the full Current Chapter Plot below, and established continuity memory instead of scanning the entire outline."
            .to_string(),
    );
    sections.push(format!(
        "[Global Story Bible]\n{}",
        extract_global_story_bible(plot_outline)
            .filter(|item| !item.trim().is_empty())
            .unwrap_or_else(|| "No separate global setup sections were detected.".to_string())
    ));

    let omitted_timeline = format_omitted_timeline(&chapter_map, chapter, language);
    if !omitted_timeline.trim().is_empty() {
        sections.push(format!(
            "[Chronological Summary of Omitted Planned Chapters]\n{}",
            omitted_timeline
        ));
    }

    sections.push(format_current_part_context(
        current_boundary,
        &chapter_map,
        chapter,
    ));
    sections.push(format_nearby_chapter_cards(
        &chapter_map,
        chapter,
        total_chapters,
    ));
    sections.push(format_future_boundary(
        next_boundary,
        boundaries.last(),
        &chapter_map,
        chapter,
        total_chapters,
    ));

    Some(sections.join("\n\n"))
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

fn split_chapters_into_planned_part_boundaries(
    chapters: &[(u32, String)],
    total_chapters: u32,
) -> Vec<PlotArcBoundary> {
    if chapters.is_empty() || total_chapters == 0 {
        return Vec::new();
    }

    planned_part_boundaries(total_chapters)
        .into_iter()
        .filter_map(|plan| {
            let planned_chapters = chapters
                .iter()
                .filter(|(chapter, _)| {
                    plan.start_chapter <= *chapter && *chapter <= plan.end_chapter
                })
                .cloned()
                .collect::<Vec<_>>();
            if planned_chapters.is_empty() {
                return None;
            }

            let name = format!("Part {}", plan.part);
            let summary_items = build_summary_items(
                &name,
                plan.start_chapter,
                plan.end_chapter,
                &planned_chapters,
            );
            let keyword_source = std::iter::once(name.clone())
                .chain(summary_items.clone())
                .collect::<Vec<_>>();
            let keywords = sanitize_keywords(&keyword_source)
                .into_iter()
                .take(8)
                .collect();

            Some(PlotArcBoundary {
                name,
                start_chapter: plan.start_chapter,
                end_chapter: plan.end_chapter,
                summary_items,
                keywords,
                label: Some(format!("Part {}", plan.part)),
                inferred: false,
            })
        })
        .collect()
}

fn has_sequential_part_ordinals(boundaries: &[PlotArcBoundary]) -> bool {
    boundaries.iter().enumerate().all(|(idx, boundary)| {
        boundary
            .label
            .as_deref()
            .and_then(parse_part_ordinal_from_label)
            == Some(idx as u32 + 1)
    })
}

fn explicit_part_boundaries_need_repair(
    boundaries: &[PlotArcBoundary],
    total_chapters: u32,
) -> bool {
    if !has_sequential_part_ordinals(boundaries) {
        return true;
    }

    if total_chapters > 0 && boundaries.len() != planned_part_boundaries(total_chapters).len() {
        return true;
    }

    boundaries.len() > 1
        && boundaries
            .iter()
            .any(|boundary| boundary.end_chapter.saturating_sub(boundary.start_chapter) + 1 < 3)
}

fn parse_part_ordinal_from_label(label: &str) -> Option<u32> {
    let normalized = clean_inline_markup(label);
    RE_PART_HEADING
        .captures(&normalized)
        .and_then(|cap| cap.name("label"))
        .and_then(|item| {
            let raw = item.as_str().trim();
            let token = if let Some(rest) = raw
                .strip_prefix('제')
                .and_then(|rest| rest.strip_suffix('부'))
            {
                rest.trim().to_string()
            } else if let Some(rest) = raw
                .strip_prefix('第')
                .and_then(|rest| rest.strip_suffix('部'))
            {
                rest.trim().to_string()
            } else {
                raw.to_ascii_lowercase()
                    .strip_prefix("part")
                    .map(str::trim)
                    .map(str::to_string)?
            };
            parse_number_token(&token)
        })
}

fn split_section_chapters(section: &str) -> Vec<(u32, String)> {
    let matches = chapter_entry_matches(section);
    let mut chapters = Vec::new();

    for idx in 0..matches.len() {
        let entry = matches[idx];
        let end = matches
            .get(idx + 1)
            .map(|next| next.match_start)
            .unwrap_or(section.len());
        let body = clean_outline_fragment(&section[entry.content_start..end]);
        chapters.push((entry.chapter, body));
    }

    chapters.sort_by_key(|(chapter, _)| *chapter);
    chapters
}

fn chapter_entry_matches(section: &str) -> Vec<ChapterEntryMatch> {
    RE_CHAPTER_ENTRY
        .captures_iter(section)
        .filter_map(|cap| {
            let heading = cap.name("heading")?;
            if !is_chapter_heading_boundary(section, heading.end()) {
                return None;
            }

            let chapter = cap
                .name("en")
                .or_else(|| cap.name("ko"))
                .or_else(|| cap.name("ja"))
                .and_then(|item| parse_number_token(item.as_str()))?;

            Some(ChapterEntryMatch {
                match_start: cap.get(0)?.start(),
                content_start: heading.end(),
                chapter,
            })
        })
        .collect()
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

fn extract_global_story_bible(plot_outline: &str) -> Option<String> {
    let first_chapter_start = chapter_entry_matches(plot_outline)
        .first()
        .map(|item| item.match_start)
        .unwrap_or(plot_outline.len());

    let prefix = plot_outline[..first_chapter_start]
        .lines()
        .filter(|line| !is_chapter_content_section_heading(line))
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = trim_middle_chars(prefix.trim(), 12_000);
    if trimmed.trim().is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn is_chapter_content_section_heading(line: &str) -> bool {
    let normalized = clean_inline_markup(line)
        .trim_start_matches(|c: char| matches!(c, '#' | '-' | '*' | '>' | ' ' | '\t'))
        .trim()
        .to_string();
    let lower = normalized.to_ascii_lowercase();

    if !normalized.starts_with('5') {
        return false;
    }

    normalized.contains("각 장")
        || normalized.contains("장 제목")
        || normalized.contains("各章")
        || lower.contains("chapter titles")
        || lower.contains("chapters")
}

fn format_current_part_context(
    boundary: Option<&PlotArcBoundary>,
    chapter_map: &HashMap<u32, &str>,
    chapter: u32,
) -> String {
    let Some(boundary) = boundary else {
        return "[Current Part / Arc Summary]\nNo explicit or inferred part boundary was detected. Use the Current Chapter Plot below as the local plan.".to_string();
    };

    let mut lines = Vec::new();
    let kind = if boundary.inferred {
        "Inferred memory arc"
    } else {
        "Planned part"
    };
    lines.push(format!(
        "{}: {} (Chapters {}-{})",
        kind, boundary.name, boundary.start_chapter, boundary.end_chapter
    ));

    if !boundary.keywords.is_empty() {
        lines.push(format!("Arc keywords: {}", boundary.keywords.join(", ")));
    }

    if let Some(start_card) = chapter_map.get(&boundary.start_chapter) {
        lines.push(format!(
            "Part opening anchor (Chapter {}): {}",
            boundary.start_chapter,
            trim_inline_for_context(start_card, 500)
        ));
    }

    if boundary.end_chapter != chapter {
        if let Some(end_card) = chapter_map.get(&boundary.end_chapter) {
            lines.push(format!(
                "Part target boundary (Chapter {}): {}",
                boundary.end_chapter,
                trim_inline_for_context(end_card, 700)
            ));
        }
    }

    lines.push("Full current chapter card is provided in [Current Chapter Plot] below; it has higher priority than part-level guidance.".to_string());

    format!("[Current Part / Arc Summary]\n{}", lines.join("\n"))
}

fn format_nearby_chapter_cards(
    chapter_map: &HashMap<u32, &str>,
    chapter: u32,
    total_chapters: u32,
) -> String {
    let mut blocks = Vec::new();
    if chapter > 1 {
        if let Some(previous) = chapter_map.get(&chapter.saturating_sub(1)) {
            blocks.push(format!(
                "Previous Chapter {} boundary:\n{}",
                chapter - 1,
                trim_middle_chars(previous, 1_200)
            ));
        }
    }

    for next_chapter in chapter.saturating_add(1)..=chapter.saturating_add(2).min(total_chapters) {
        if let Some(next) = chapter_map.get(&next_chapter) {
            blocks.push(format!(
                "Next Chapter {} boundary only:\n{}",
                next_chapter,
                trim_middle_chars(next, 1_200)
            ));
        }
    }

    if blocks.is_empty() {
        "[Nearby Chapter Cards]\nNo nearby chapter cards were detected.".to_string()
    } else {
        format!("[Nearby Chapter Cards]\n{}", blocks.join("\n\n"))
    }
}

fn format_future_boundary(
    next_boundary: Option<&PlotArcBoundary>,
    final_boundary: Option<&PlotArcBoundary>,
    chapter_map: &HashMap<u32, &str>,
    chapter: u32,
    total_chapters: u32,
) -> String {
    let mut lines = Vec::new();

    if chapter >= total_chapters {
        lines.push("This is the final planned chapter; resolve according to the Current Chapter Plot, established canon, and unresolved story state.".to_string());
    } else {
        if let Some(next) = next_boundary {
            lines.push(format!(
                "Next planned part begins at Chapter {}: {} (Chapters {}-{}). Use this only as a boundary, not as permission to pull future events forward.",
                next.start_chapter, next.name, next.start_chapter, next.end_chapter
            ));
        }

        if let Some(final_card) = chapter_map.get(&total_chapters) {
            lines.push(format!(
                "Final direction anchor (Chapter {}): {}",
                total_chapters,
                trim_inline_for_context(final_card, 900)
            ));
        } else if let Some(final_arc) = final_boundary {
            lines.push(format!(
                "Final planned part: {} (Chapters {}-{}).",
                final_arc.name, final_arc.start_chapter, final_arc.end_chapter
            ));
        }
    }

    if lines.is_empty() {
        "[Future Boundary]\nNo future boundary was detected.".to_string()
    } else {
        format!("[Future Boundary]\n{}", lines.join("\n"))
    }
}

fn trim_inline_for_context(text: &str, max_chars: usize) -> String {
    trim_middle_chars(text, max_chars)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" / ")
}

fn trim_middle_chars(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let chars = trimmed.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return trimmed.to_string();
    }

    let marker = "\n[...middle omitted...]\n";
    let marker_len = marker.chars().count();
    if max_chars <= marker_len + 2 {
        return chars.into_iter().take(max_chars).collect();
    }

    let side = (max_chars - marker_len) / 2;
    let head = chars.iter().take(side).collect::<String>();
    let tail = chars
        .iter()
        .skip(chars.len().saturating_sub(side))
        .collect::<String>();

    format!("{}{}{}", head.trim_end(), marker, tail.trim_start())
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
    let mut lines = Vec::new();
    for line in raw.lines() {
        let cleaned = line.replace("**", "").replace("__", "");
        lines.push(cleaned);
    }
    lines
        .join("\n")
        .trim_start_matches(|c: char| matches!(c, ':' | '：' | '-' | '–' | '—' | ' ' | '\t'))
        .trim()
        .to_string()
}

fn parse_number_token(raw: &str) -> Option<u32> {
    let normalized = raw
        .trim()
        .chars()
        .map(|ch| {
            if ('０'..='９').contains(&ch) {
                char::from_u32(ch as u32 - '０' as u32 + '0' as u32).unwrap_or(ch)
            } else {
                ch
            }
        })
        .collect::<String>();
    let token = normalized.trim();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn korean_chapter_outline(total: u32) -> String {
        (1..=total)
            .map(|chapter| format!("제 {}장\n내용: 테스트 {}", chapter, chapter))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn malformed_explicit_part_ordinals_fall_back_to_planned_ranges() {
        let plot = format!(
            "제 1부\n{}\n제 3부\n제 5장\n내용: 테스트 5\n제 2부\n{}",
            (1..=4)
                .map(|chapter| format!("제 {}장\n내용: 테스트 {}", chapter, chapter))
                .collect::<Vec<_>>()
                .join("\n"),
            (6..=10)
                .map(|chapter| format!("제 {}장\n내용: 테스트 {}", chapter, chapter))
                .collect::<Vec<_>>()
                .join("\n")
        );

        let boundaries = split_plot_into_arc_boundaries(&plot);
        let ranges = boundaries
            .iter()
            .map(|boundary| {
                (
                    boundary.start_chapter,
                    boundary.end_chapter,
                    boundary.inferred,
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(ranges, vec![(1, 5, false), (6, 10, false)]);
    }

    #[test]
    fn sequential_explicit_part_ordinals_keep_their_ranges() {
        let plot = format!(
            "제 1부\n{}\n제 2부\n{}",
            korean_chapter_outline(4),
            (5..=8)
                .map(|chapter| format!("제 {}장\n내용: 테스트 {}", chapter, chapter))
                .collect::<Vec<_>>()
                .join("\n")
        );

        let boundaries = split_plot_into_arc_boundaries(&plot);
        let starts = boundaries
            .iter()
            .map(|boundary| boundary.start_chapter)
            .collect::<Vec<_>>();

        assert_eq!(starts, vec![1, 5]);
    }

    #[test]
    fn sequential_but_too_small_part_falls_back_to_planned_ranges() {
        let plot = format!(
            "제 1부\n{}\n제 2부\n제 5장\n내용: 테스트 5\n제 3부\n{}",
            (1..=4)
                .map(|chapter| format!("제 {}장\n내용: 테스트 {}", chapter, chapter))
                .collect::<Vec<_>>()
                .join("\n"),
            (6..=15)
                .map(|chapter| format!("제 {}장\n내용: 테스트 {}", chapter, chapter))
                .collect::<Vec<_>>()
                .join("\n")
        );

        let boundaries = split_plot_into_arc_boundaries(&plot);
        let ranges = boundaries
            .iter()
            .map(|boundary| (boundary.start_chapter, boundary.end_chapter))
            .collect::<Vec<_>>();

        assert_eq!(ranges, vec![(1, 5), (6, 10), (11, 15)]);
    }

    #[test]
    fn section_chapter_split_ignores_inline_mentions_for_arc_boundaries() {
        let section = "\
제 1장: 시작
내용: 주인공은 제 2장의 문제를 아직 복선으로만 본다.

제 2장: 사건
내용: 실제 사건이 시작된다.";

        let chapters = split_section_chapters(section);

        assert_eq!(
            chapters
                .iter()
                .map(|(chapter, _)| *chapter)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(chapters[0].1.contains("제 2장의 문제"));
    }

    #[test]
    fn section_chapter_split_accepts_markdown_and_fullwidth_digits() {
        let section = "\
- **제 １장**: 첫 장
내용: 시작.

### Chapter ２: Second
Content: Middle.";

        let chapters = split_section_chapters(section);

        assert_eq!(
            chapters
                .iter()
                .map(|(chapter, _)| *chapter)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(chapters[0].1.contains("첫 장"));
        assert!(chapters[1].1.contains("Second"));
    }

    #[test]
    fn compressed_plot_context_uses_nearby_cards_without_full_outline() {
        let chapters = (1..=13)
            .map(|chapter| {
                format!(
                    "제 {}장: 장면 {}\n내용: UNIQUE_CHAPTER_{}_DETAIL\n핵심 포인트: 테스트 {}",
                    chapter, chapter, chapter, chapter
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let plot = format!(
            "1. 제목\n압축 테스트\n\n2. 핵심 주제의식과 소설 스타일\n긴 플롯 압축\n\n5. 각 장 제목과 내용\n{}",
            chapters
        );

        let context = build_compressed_plot_context_for_chapter(&plot, 2, 13, "English").unwrap();

        assert!(context.contains("[Compressed Plot Context]"));
        assert!(context.contains("[Global Story Bible]"));
        assert!(context.contains("UNIQUE_CHAPTER_1_DETAIL"));
        assert!(context.contains("UNIQUE_CHAPTER_3_DETAIL"));
        assert!(context.contains("UNIQUE_CHAPTER_4_DETAIL"));
        assert!(context.contains("UNIQUE_CHAPTER_13_DETAIL"));
        assert!(!context.contains("UNIQUE_CHAPTER_9_DETAIL"));
        assert!(!context.contains("5. 각 장 제목과 내용"));
    }

    #[test]
    fn compressed_plot_context_returns_none_when_current_chapter_is_missing() {
        let plot = "1. Title\nMissing chapter test\n\nChapter 1\nContent: only first.";

        assert!(build_compressed_plot_context_for_chapter(plot, 2, 13, "English").is_none());
    }

    #[test]
    fn part_heading_label_matches_generation_language() {
        assert_eq!(format_part_heading_label("Korean", 2), "제 2부");
        assert_eq!(format_part_heading_label("Japanese", 2), "第 2 部");
        assert_eq!(format_part_heading_label("English", 2), "Part 2");
    }
}
