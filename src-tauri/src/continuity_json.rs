use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::LazyLock;

static RE_JSON_TRAILING_COMMA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r",(\s*[}\]])").unwrap());

const KEYWORD_MIN_CHARS: usize = 2;
const KEYWORD_MAX_CHARS: usize = 24;
const KEYWORD_MAX_WORDS: usize = 3;

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct ContinuityUpdatePayload {
    pub story_state: Vec<String>,
    pub character_state: Vec<String>,
    pub current_arc: Vec<String>,
    pub current_arc_keywords: Vec<String>,
    pub close_current_arc: bool,
    pub closed_arc_summary: Vec<String>,
    pub closed_arc_keywords: Vec<String>,
}

#[derive(Clone, Copy)]
enum JsonContainerContext {
    Object { expecting_key: bool },
    Array,
}

pub fn parse_continuity_payload(text: &str) -> Option<ContinuityUpdatePayload> {
    parse_continuity_payload_inner(text, 0)
}

pub fn sanitize_keywords(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();

    for value in values {
        for part in value.split(|c: char| matches!(c, ',' | ';' | '/' | '|' | '\n' | '\r')) {
            let mut candidates = Vec::new();
            if let Some(keyword) = normalize_keyword_candidate(part) {
                candidates.push(keyword);
            } else {
                candidates.extend(
                    split_keyword_like_segments(part)
                        .into_iter()
                        .filter_map(|segment| normalize_keyword_candidate(&segment)),
                );
            }

            for candidate in candidates {
                let dedupe_key = keyword_normalized_key(&candidate);
                if dedupe_key.is_empty() || !seen.insert(dedupe_key) {
                    continue;
                }

                cleaned.push(candidate);
                if cleaned.len() >= 12 {
                    return cleaned;
                }
            }
        }
    }

    cleaned
}

pub fn char_bigrams(text: &str) -> HashSet<String> {
    let chars = normalized_char_stream(text);
    if chars.len() < 2 {
        return HashSet::new();
    }

    chars
        .windows(2)
        .map(|window| window.iter().collect::<String>())
        .collect()
}

fn normalize_memory_item(raw: &str) -> String {
    raw.trim()
        .trim_start_matches(|c: char| matches!(c, '-' | '*' | '•' | ' ' | '\t'))
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '`'))
        .trim()
        .to_string()
}

fn memory_lines_from_text(text: &str) -> Vec<String> {
    text.lines()
        .map(normalize_memory_item)
        .filter(|line| !line.is_empty())
        .collect()
}

fn is_hangul_char(ch: char) -> bool {
    ('\u{AC00}'..='\u{D7A3}').contains(&ch)
}

fn contains_hangul(text: &str) -> bool {
    text.chars().any(is_hangul_char)
}

fn keyword_normalized_key(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn strip_keyword_prefix(raw: &str) -> &str {
    strip_case_insensitive_prefix(raw, "FACT:")
        .or_else(|| strip_case_insensitive_prefix(raw, "OPEN:"))
        .or_else(|| strip_case_insensitive_prefix(raw, "ARC:"))
        .unwrap_or(raw)
}

fn strip_korean_keyword_particle(token: &str) -> String {
    if !contains_hangul(token) {
        return token.to_string();
    }

    let suffixes = [
        "으로부터", "에게서", "한테서", "께서는", "에서는", "으로", "에게", "한테", "께서", "에서",
        "부터", "까지", "처럼", "마저", "조차", "이나", "나", "은", "는", "이", "가", "을", "를",
        "의", "와", "과", "도", "로",
    ];

    for suffix in suffixes {
        if let Some(stripped) = token.strip_suffix(suffix) {
            if keyword_normalized_key(stripped).chars().count() >= KEYWORD_MIN_CHARS {
                return stripped.to_string();
            }
        }
    }

    token.to_string()
}

fn normalize_keyword_candidate(raw: &str) -> Option<String> {
    let normalized_item = normalize_memory_item(raw);
    let trimmed = strip_keyword_prefix(&normalized_item)
        .trim_matches(|c: char| matches!(c, '-' | '*' | '•' | '[' | ']' | '(' | ')' | '{' | '}' | '"' | '\'' | '`'))
        .trim();

    if trimmed.is_empty() || is_placeholder_text(trimmed) || is_placeholder_keyword(trimmed) {
        return None;
    }

    let words: Vec<String> = trimmed
        .split_whitespace()
        .map(strip_korean_keyword_particle)
        .map(|word| word.trim_matches(|c: char| matches!(c, '-' | '*' | '•' | '[' | ']' | '(' | ')' | '{' | '}' | '"' | '\'' | '`')).to_string())
        .filter(|word| !word.is_empty())
        .collect();

    let candidate = if words.is_empty() {
        strip_korean_keyword_particle(trimmed)
    } else {
        words.join(" ")
    };

    let normalized_key = keyword_normalized_key(&candidate);
    let non_ascii_alnum = candidate
        .chars()
        .any(|c| c.is_alphanumeric() && !c.is_ascii());

    if normalized_key.chars().count() < KEYWORD_MIN_CHARS && !non_ascii_alnum {
        return None;
    }

    if normalized_key.chars().count() > KEYWORD_MAX_CHARS {
        return None;
    }

    if candidate.split_whitespace().count() > KEYWORD_MAX_WORDS {
        return None;
    }

    if is_placeholder_keyword(&candidate) {
        return None;
    }

    let normalized = if candidate.chars().any(|c| c.is_ascii_alphabetic()) {
        candidate.to_lowercase()
    } else {
        candidate
    };

    Some(normalized)
}

fn split_keyword_like_segments(raw: &str) -> Vec<String> {
    let normalized_item = normalize_memory_item(raw);
    let trimmed = strip_keyword_prefix(&normalized_item).trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let words: Vec<String> = trimmed
        .split(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    ',' | ';' | '/' | '|' | '\n' | '\r' | ':' | '!' | '?' | '.' | '·' | '•' | '，'
                        | '、' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | '`'
                )
        })
        .map(strip_korean_keyword_particle)
        .map(|segment| {
            segment
                .trim_matches(|c: char| matches!(c, '-' | '*' | '•' | '[' | ']' | '(' | ')' | '{' | '}' | '"' | '\'' | '`'))
                .to_string()
        })
        .filter(|segment| !segment.is_empty())
        .collect();

    let mut segments = Vec::new();
    for word in &words {
        segments.push(word.clone());
    }

    if words.len() >= 2 {
        for window in words.windows(2) {
            segments.push(window.join(" "));
        }
    }

    segments
}

fn normalized_char_stream(text: &str) -> Vec<char> {
    text.chars()
        .flat_map(|c| c.to_lowercase())
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn strip_case_insensitive_prefix<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    if head.eq_ignore_ascii_case(prefix) {
        Some(text[prefix.len()..].trim())
    } else {
        None
    }
}

fn is_placeholder_text(text: &str) -> bool {
    let trimmed = text
        .trim()
        .trim_matches(|c: char| matches!(c, '.' | ',' | ':' | ';' | '-' | '*' | '"' | '\'' | '`' | ' ' | '\t'));
    if trimmed.is_empty() {
        return true;
    }

    let normalized: String = trimmed
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();

    matches!(
        normalized.as_str(),
        "" | "fact" | "open" | "arc" | "char" | "none" | "noneyet" | "null" | "na" | "tbd" | "todo"
    )
}

fn is_placeholder_keyword(keyword: &str) -> bool {
    let normalized: String = keyword
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();

    normalized.is_empty()
        || matches!(
            normalized.as_str(),
            "keyword" | "keyword1" | "keyword2" | "keyword3" | "none" | "null" | "na" | "tbd"
        )
}

fn normalize_story_state_items(items: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();

    for item in items {
        let cleaned = normalize_memory_item(&item);
        if cleaned.is_empty() {
            continue;
        }

        let canonical = if let Some(rest) = strip_case_insensitive_prefix(&cleaned, "FACT:") {
            if is_placeholder_text(rest) {
                continue;
            }
            format!("FACT: {}", rest)
        } else if let Some(rest) = strip_case_insensitive_prefix(&cleaned, "OPEN:") {
            if is_placeholder_text(rest) {
                continue;
            }
            format!("OPEN: {}", rest)
        } else {
            if is_placeholder_text(&cleaned) {
                continue;
            }
            format!("OPEN: {}", cleaned)
        };

        let dedupe_key: String = normalized_char_stream(&canonical).into_iter().collect();
        if seen.insert(dedupe_key) {
            normalized.push(canonical);
        }

        if normalized.len() >= 14 {
            break;
        }
    }

    normalized
}

fn normalize_arc_items(items: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();

    for item in items {
        let cleaned = normalize_memory_item(&item);
        if cleaned.is_empty() {
            continue;
        }

        let canonical = if let Some(rest) = strip_case_insensitive_prefix(&cleaned, "ARC:") {
            if is_placeholder_text(rest) {
                continue;
            }
            format!("ARC: {}", rest)
        } else {
            if is_placeholder_text(&cleaned) {
                continue;
            }
            format!("ARC: {}", cleaned)
        };

        let dedupe_key: String = normalized_char_stream(&canonical).into_iter().collect();
        if seen.insert(dedupe_key) {
            normalized.push(canonical);
        }

        if normalized.len() >= 8 {
            break;
        }
    }

    normalized
}

fn normalize_character_state_items(items: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();

    for item in items {
        let cleaned = normalize_memory_item(&item);
        if cleaned.is_empty() {
            continue;
        }

        let canonical = if let Some(rest) = strip_case_insensitive_prefix(&cleaned, "CHAR:") {
            if is_placeholder_text(rest) {
                continue;
            }
            format!("CHAR: {}", rest)
        } else {
            if is_placeholder_text(&cleaned) {
                continue;
            }
            format!("CHAR: {}", cleaned)
        };

        let dedupe_key: String = normalized_char_stream(&canonical).into_iter().collect();
        if seen.insert(dedupe_key) {
            normalized.push(canonical);
        }

        if normalized.len() >= 18 {
            break;
        }
    }

    normalized
}

fn normalize_keyword_items(items: Vec<String>) -> Vec<String> {
    sanitize_keywords(&items)
        .into_iter()
        .filter(|keyword| !is_placeholder_keyword(keyword))
        .take(8)
        .collect()
}

fn normalize_continuity_payload(payload: ContinuityUpdatePayload) -> Option<ContinuityUpdatePayload> {
    let story_state = normalize_story_state_items(payload.story_state);
    let character_state = normalize_character_state_items(payload.character_state);
    let current_arc = normalize_arc_items(payload.current_arc);
    let mut current_arc_keywords = normalize_keyword_items(payload.current_arc_keywords);
    let mut close_current_arc = payload.close_current_arc;
    let mut closed_arc_summary = normalize_arc_items(payload.closed_arc_summary);
    let mut closed_arc_keywords = normalize_keyword_items(payload.closed_arc_keywords);

    if current_arc_keywords.is_empty() {
        current_arc_keywords = normalize_keyword_items(current_arc.clone());
    }

    if !close_current_arc || closed_arc_summary.is_empty() {
        close_current_arc = false;
        closed_arc_summary.clear();
        closed_arc_keywords.clear();
    } else if closed_arc_keywords.is_empty() {
        closed_arc_keywords = normalize_keyword_items(closed_arc_summary.clone());
    }

    let has_signal = !story_state.is_empty()
        || !character_state.is_empty()
        || !current_arc.is_empty()
        || !current_arc_keywords.is_empty()
        || !closed_arc_summary.is_empty()
        || !closed_arc_keywords.is_empty();

    if !has_signal {
        return None;
    }

    Some(ContinuityUpdatePayload {
        story_state,
        character_state,
        current_arc,
        current_arc_keywords,
        close_current_arc,
        closed_arc_summary,
        closed_arc_keywords,
    })
}

fn sanitize_model_json(raw: &str) -> String {
    let normalized = raw
        .replace('\u{feff}', "")
        .replace('\u{201c}', "\"")
        .replace('\u{201d}', "\"")
        .replace('\u{2018}', "'")
        .replace('\u{2019}', "'");

    let without_fences = normalized
        .lines()
        .filter(|line| !line.trim_start().starts_with("```"))
        .collect::<Vec<_>>()
        .join("\n");

    without_fences.trim().trim_matches('`').trim().to_string()
}

fn extract_balanced_json_objects(text: &str) -> Vec<String> {
    let mut objects = Vec::new();
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = None;
    let mut escape = false;

    for (idx, ch) in text.char_indices() {
        if let Some(delimiter) = in_string {
            if escape {
                escape = false;
                continue;
            }
            if ch == '\\' {
                escape = true;
                continue;
            }
            if ch == delimiter {
                in_string = None;
            }
            continue;
        }

        if depth > 0 && (ch == '"' || ch == '\'') {
            in_string = Some(ch);
            continue;
        }

        match ch {
            '{' => {
                if depth == 0 {
                    start = Some(idx);
                }
                depth += 1;
            }
            '}' => {
                if depth == 0 {
                    continue;
                }
                depth -= 1;
                if depth == 0 {
                    if let Some(object_start) = start.take() {
                        objects.push(text[object_start..=idx].to_string());
                    }
                }
            }
            _ => {}
        }
    }

    objects
}

fn collect_json_candidates(text: &str) -> Vec<String> {
    let sanitized = sanitize_model_json(text);
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();

    for candidate in std::iter::once(sanitized.clone()).chain(extract_balanced_json_objects(&sanitized).into_iter()) {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            continue;
        }
        let owned = trimmed.to_string();
        if seen.insert(owned.clone()) {
            candidates.push(owned);
        }
    }

    candidates
}

fn repair_json_like(input: &str) -> String {
    let chars: Vec<char> = sanitize_model_json(input).chars().collect();
    let mut repaired = String::with_capacity(input.len() + 32);
    let mut stack = Vec::new();
    let mut in_string = None;
    let mut escape = false;
    let mut line_comment = false;
    let mut block_comment = false;
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];

        if line_comment {
            if ch == '\n' {
                line_comment = false;
                repaired.push(ch);
            }
            i += 1;
            continue;
        }

        if block_comment {
            if ch == '*' && chars.get(i + 1) == Some(&'/') {
                block_comment = false;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }

        if let Some(delimiter) = in_string {
            if escape {
                if delimiter == '\'' && ch == '\'' {
                    repaired.push('\'');
                } else if delimiter == '\'' && ch == '"' {
                    repaired.push('\\');
                    repaired.push('"');
                } else {
                    repaired.push('\\');
                    repaired.push(ch);
                }
                escape = false;
                i += 1;
                continue;
            }

            if ch == '\\' {
                escape = true;
                i += 1;
                continue;
            }

            if delimiter == '\'' {
                match ch {
                    '\'' => {
                        repaired.push('"');
                        in_string = None;
                    }
                    '"' => {
                        repaired.push('\\');
                        repaired.push('"');
                    }
                    '\n' => repaired.push_str("\\n"),
                    '\r' => repaired.push_str("\\r"),
                    '\t' => repaired.push_str("\\t"),
                    _ => repaired.push(ch),
                }
            } else {
                repaired.push(ch);
                if ch == delimiter {
                    in_string = None;
                }
            }

            i += 1;
            continue;
        }

        if ch == '/' && chars.get(i + 1) == Some(&'/') {
            line_comment = true;
            i += 2;
            continue;
        }
        if ch == '/' && chars.get(i + 1) == Some(&'*') {
            block_comment = true;
            i += 2;
            continue;
        }
        if ch == '#' {
            line_comment = true;
            i += 1;
            continue;
        }

        match ch {
            '"' => {
                repaired.push('"');
                in_string = Some('"');
                i += 1;
            }
            '\'' => {
                repaired.push('"');
                in_string = Some('\'');
                i += 1;
            }
            '{' => {
                repaired.push('{');
                stack.push(JsonContainerContext::Object { expecting_key: true });
                i += 1;
            }
            '[' => {
                repaired.push('[');
                stack.push(JsonContainerContext::Array);
                i += 1;
            }
            '}' => {
                repaired.push('}');
                stack.pop();
                i += 1;
            }
            ']' => {
                repaired.push(']');
                stack.pop();
                i += 1;
            }
            ':' => {
                repaired.push(':');
                if let Some(JsonContainerContext::Object { expecting_key }) = stack.last_mut() {
                    *expecting_key = false;
                }
                i += 1;
            }
            ',' => {
                repaired.push(',');
                if let Some(JsonContainerContext::Object { expecting_key }) = stack.last_mut() {
                    *expecting_key = true;
                }
                i += 1;
            }
            '`' => {
                i += 1;
            }
            _ if ch.is_whitespace() => {
                repaired.push(ch);
                i += 1;
            }
            _ => {
                let expecting_key = matches!(
                    stack.last(),
                    Some(JsonContainerContext::Object { expecting_key: true })
                );

                if expecting_key && (ch.is_ascii_alphabetic() || ch == '_') {
                    let mut end = i + 1;
                    while let Some(next) = chars.get(end) {
                        if next.is_ascii_alphanumeric() || matches!(next, '_' | '-') {
                            end += 1;
                        } else {
                            break;
                        }
                    }

                    let token: String = chars[i..end].iter().collect();
                    let mut lookahead = end;
                    while let Some(next) = chars.get(lookahead) {
                        if next.is_whitespace() {
                            lookahead += 1;
                        } else {
                            break;
                        }
                    }

                    if chars.get(lookahead) == Some(&':') {
                        repaired.push('"');
                        repaired.push_str(&token);
                        repaired.push('"');
                        i = end;
                        continue;
                    }
                }

                if ch.is_ascii_alphabetic() {
                    let mut end = i + 1;
                    while let Some(next) = chars.get(end) {
                        if next.is_ascii_alphabetic() {
                            end += 1;
                        } else {
                            break;
                        }
                    }

                    let token: String = chars[i..end].iter().collect();
                    let lowered = token.to_ascii_lowercase();
                    match lowered.as_str() {
                        "true" | "yes" => repaired.push_str("true"),
                        "false" | "no" => repaired.push_str("false"),
                        "null" | "none" => repaired.push_str("null"),
                        _ => repaired.push_str(&token),
                    }
                    i = end;
                    continue;
                }

                repaired.push(ch);
                i += 1;
            }
        }
    }

    let mut cleaned = repaired;
    loop {
        let next = RE_JSON_TRAILING_COMMA.replace_all(&cleaned, "$1").to_string();
        if next == cleaned {
            return next;
        }
        cleaned = next;
    }
}

fn object_looks_like_continuity_payload(map: &serde_json::Map<String, Value>) -> bool {
    [
        "story_state",
        "character_state",
        "current_arc",
        "current_arc_keywords",
        "close_current_arc",
        "closed_arc_summary",
        "closed_arc_keywords",
    ]
    .iter()
    .any(|key| map.contains_key(*key))
}

fn coerce_string_list(value: Option<&Value>) -> Vec<String> {
    fn push_value(items: &mut Vec<String>, value: &Value) {
        match value {
            Value::Array(values) => {
                for entry in values {
                    push_value(items, entry);
                }
            }
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    return;
                }

                if trimmed.starts_with('[') || trimmed.starts_with('{') {
                    if let Ok(inner) = serde_json::from_str::<Value>(trimmed) {
                        push_value(items, &inner);
                        return;
                    }
                }

                let lines = memory_lines_from_text(trimmed);
                if lines.len() > 1 {
                    items.extend(lines);
                } else {
                    items.push(trimmed.to_string());
                }
            }
            Value::Number(number) => items.push(number.to_string()),
            Value::Bool(flag) => items.push(flag.to_string()),
            _ => {}
        }
    }

    let mut items = Vec::new();
    if let Some(value) = value {
        push_value(&mut items, value);
    }
    items
}

fn coerce_bool(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64().map(|value| value != 0).unwrap_or(false),
        Some(Value::String(text)) => matches!(
            text.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "y"
        ),
        _ => false,
    }
}

fn coerce_payload_from_object(map: &serde_json::Map<String, Value>) -> Option<ContinuityUpdatePayload> {
    if !object_looks_like_continuity_payload(map) {
        return None;
    }

    normalize_continuity_payload(ContinuityUpdatePayload {
        story_state: coerce_string_list(map.get("story_state")),
        character_state: coerce_string_list(map.get("character_state")),
        current_arc: coerce_string_list(map.get("current_arc")),
        current_arc_keywords: coerce_string_list(map.get("current_arc_keywords")),
        close_current_arc: coerce_bool(map.get("close_current_arc")),
        closed_arc_summary: coerce_string_list(map.get("closed_arc_summary")),
        closed_arc_keywords: coerce_string_list(map.get("closed_arc_keywords")),
    })
}

fn extract_payload_from_value(value: &Value, depth: usize) -> Option<ContinuityUpdatePayload> {
    match value {
        Value::Object(map) => {
            coerce_payload_from_object(map)
                .or_else(|| map.values().find_map(|entry| extract_payload_from_value(entry, depth)))
        }
        Value::Array(values) => values.iter().find_map(|entry| extract_payload_from_value(entry, depth)),
        Value::String(text) if depth < 2 => parse_continuity_payload_inner(text, depth + 1),
        _ => None,
    }
}

fn parse_continuity_candidate(candidate: &str, depth: usize) -> Option<ContinuityUpdatePayload> {
    let parsed = serde_json::from_str::<Value>(candidate).ok()?;
    extract_payload_from_value(&parsed, depth)
}

fn parse_continuity_payload_inner(text: &str, depth: usize) -> Option<ContinuityUpdatePayload> {
    for candidate in collect_json_candidates(text) {
        if let Some(payload) = parse_continuity_candidate(&candidate, depth) {
            return Some(payload);
        }

        let repaired = repair_json_like(&candidate);
        if repaired != candidate {
            if let Some(payload) = parse_continuity_candidate(&repaired, depth) {
                return Some(payload);
            }
        }
    }

    None
}
