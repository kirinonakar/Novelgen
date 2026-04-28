use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::LazyLock;

static RE_JSON_TRAILING_COMMA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r",(\s*[}\]])").unwrap());
static RE_QUOTED_KEYWORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"["'“”‘’「『](?P<term>[^"'“”‘’「」『』]{2,48})["'“”‘’」』]"#).unwrap()
});
static RE_JAPANESE_KEYWORD_PHRASE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?P<term>[\p{Han}\p{Hiragana}\p{Katakana}ーA-Za-z0-9]{0,12}(?:都市|の核|核|結晶|ギルド|騎士団|四天王|魔王|迷宮|ダンジョン|深淵|影|人形|怪物|軍団|亀裂|裂け目|遺物|王国|帝国|神殿|首都|村|傭兵|魔物|エーテル|魔力|魔法|儀式|空白|空洞|ペンダント|首飾り|血筋|血統|殺人|事件|追跡|追撃|剣|皇室|封印|呪い))",
    )
    .unwrap()
});
static RE_KOREAN_KEYWORD_PHRASE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?P<term>[가-힣A-Za-z0-9]{0,12}(?:기사단|신전|성소|수도|도시|마을|왕국|제국|황실|용병단|용병|마물|마수|에테르|마력|마법|의식|공백|펜던트|목걸이|유물|문장|혈통|살인|사건|추격전|추격|성문|봉인|저주|균열|파편|핵|결정체|그림자|던전|미로|심연))",
    )
    .unwrap()
});

const KEYWORD_MIN_CHARS: usize = 2;
const KEYWORD_MAX_CHARS: usize = 24;
const KEYWORD_MAX_WORDS: usize = 3;
const KOREAN_KEYWORD_ANCHORS: &[&str] = &[
    "심연",
    "마왕",
    "사천왕",
    "던전",
    "길드",
    "기사단",
    "기사",
    "황실",
    "신전",
    "성소",
    "수도",
    "도시",
    "마을",
    "핵",
    "결정체",
    "그림자",
    "인형",
    "괴물",
    "군단",
    "용병단",
    "용병",
    "마물",
    "마수",
    "하수도",
    "지하",
    "미로",
    "영역",
    "균열",
    "파편",
    "기둥",
    "집행관",
    "시련",
    "전쟁",
    "성문",
    "왕국",
    "제국",
    "대륙",
    "마법",
    "마력",
    "에테르",
    "의식",
    "공백",
    "유물",
    "펜던트",
    "목걸이",
    "문장",
    "혈통",
    "살인",
    "사건",
    "추격전",
    "추격",
    "검",
    "부활",
    "설계",
    "오염",
    "파도",
    "경계선",
    "봉인",
    "저주",
];
const JAPANESE_KEYWORD_ANCHORS: &[&str] = &[
    "深淵",
    "魔王",
    "四天王",
    "都市",
    "核",
    "結晶",
    "ギルド",
    "騎士団",
    "神殿",
    "首都",
    "村",
    "傭兵",
    "魔物",
    "エーテル",
    "魔力",
    "魔法",
    "儀式",
    "空白",
    "空洞",
    "ペンダント",
    "首飾り",
    "血筋",
    "血統",
    "殺人",
    "事件",
    "追跡",
    "追撃",
    "剣",
    "皇室",
    "迷宮",
    "ダンジョン",
    "影",
    "人形",
    "怪物",
    "軍団",
    "亀裂",
    "裂け目",
    "遺物",
    "王国",
    "帝国",
    "封印",
    "呪い",
];
const ENGLISH_KEYWORD_ANCHORS: &[&str] = &[
    "abyss",
    "demon",
    "king",
    "lord",
    "city",
    "core",
    "crystal",
    "guild",
    "knight",
    "knights",
    "order",
    "temple",
    "capital",
    "village",
    "mercenary",
    "beast",
    "ether",
    "aether",
    "mana",
    "magic",
    "ritual",
    "void",
    "vacuum",
    "pendant",
    "necklace",
    "bloodline",
    "murder",
    "pursuit",
    "imperial",
    "sword",
    "dungeon",
    "labyrinth",
    "shadow",
    "puppet",
    "monster",
    "rift",
    "realm",
    "artifact",
    "relic",
    "seal",
    "curse",
    "kingdom",
    "empire",
    "tower",
    "trial",
];
const LOW_SIGNAL_KEYWORDS: &[&str] = &[
    "arc",
    "act",
    "part",
    "chapter",
    "chapters",
    "ch",
    "section",
    "summary",
    "keyword",
    "keywords",
    "plot",
    "story",
    "state",
    "current",
    "previous",
    "latest",
    "recent",
    "covered",
    "development",
    "setup",
    "opening",
    "middle",
    "ending",
    "beginning",
    "transition",
    "turn",
    "twist",
    "blood",
    "stained",
    "bloodstained",
    "bloodstainedroad",
    "road",
    "influence",
    "confirmation",
    "response",
    "attack",
    "injury",
    "appearance",
    "target",
    "life",
    "daily",
    "routine",
    "sharp",
    "dusty",
    "show",
    "shows",
    "showing",
    "shown",
    "reveal",
    "reveals",
    "revealing",
    "revealed",
    "realize",
    "realizes",
    "realizing",
    "realized",
    "realization",
    "simple",
    "unknown",
    "mysterious",
    "hypothesis",
    "join",
    "joins",
    "joined",
    "natural",
    "artificial",
    "intense",
    "excitement",
    "발단",
    "전개",
    "위기",
    "절정",
    "결말",
    "서장",
    "종장",
    "초반",
    "중반",
    "후반",
    "초반부",
    "중반부",
    "후반부",
    "제목",
    "장",
    "부",
    "화",
    "챕터",
    "파트",
    "요약",
    "키워드",
    "현재",
    "이전",
    "다음",
    "최신",
    "이번",
    "지난",
    "시작",
    "마지막",
    "피로",
    "물든",
    "피로물든",
    "물든길",
    "길전개",
    "피로물든길",
    "도시",
    "자원",
    "상업",
    "광기",
    "영향력",
    "확인",
    "소동",
    "대응",
    "돌파",
    "공격",
    "반동",
    "중상",
    "등장",
    "봉쇄",
    "규정",
    "대상",
    "내부",
    "신분",
    "생존",
    "위협",
    "일상",
    "감각",
    "날카로운",
    "보여줌",
    "보여준",
    "보여주는",
    "보여주며",
    "살아",
    "살아가는",
    "살아감",
    "먼지투성",
    "먼지투성이",
    "변두리",
    "단순한",
    "깨닫는",
    "깨달음",
    "정체불명",
    "정체불명의",
    "강렬하게",
    "고양감",
    "가설",
    "제시",
    "파악",
    "실체",
    "합류",
    "유혹하",
    "유혹하는",
    "담긴",
    "현상",
    "자연적인",
    "인위적인",
    "序章",
    "終章",
    "章",
    "部",
    "編",
    "展開",
    "現在",
    "前回",
    "今回",
    "次回",
    "要約",
    "キーワード",
    "確認",
    "対応",
    "攻撃",
    "登場",
    "影響",
    "道",
    "日常",
    "鋭い",
    "示す",
    "見せる",
    "明らか",
    "仮説",
    "合流",
    "自然",
    "人工的",
    "正体不明",
    "埃まみれ",
];

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct ContinuityUpdatePayload {
    pub story_state: Vec<String>,
    pub character_state: Vec<String>,
    pub relationship_state: Vec<String>,
    pub current_arc: Vec<String>,
    pub current_arc_keywords: Vec<String>,
    pub recent_scene_patterns: Vec<String>,
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
    let mut collected = Vec::new();
    let mut order = 0usize;

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

                collected.push((candidate, order));
                order += 1;
            }
        }
    }

    collected.sort_by(|(left, left_order), (right, right_order)| {
        keyword_quality_score(right)
            .cmp(&keyword_quality_score(left))
            .then_with(|| left_order.cmp(right_order))
    });

    collected
        .into_iter()
        .map(|(keyword, _)| keyword)
        .take(12)
        .collect()
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

fn is_kana_char(ch: char) -> bool {
    ('\u{3040}'..='\u{30ff}').contains(&ch)
}

fn contains_japanese(text: &str) -> bool {
    text.chars().any(is_kana_char)
}

fn contains_ascii_alphabetic(text: &str) -> bool {
    text.chars().any(|ch| ch.is_ascii_alphabetic())
}

fn keyword_normalized_key(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn trim_keyword_punctuation(raw: &str) -> &str {
    raw.trim_matches(|c: char| {
        matches!(
            c,
            '-' | '–'
                | '—'
                | '*'
                | '•'
                | '['
                | ']'
                | '('
                | ')'
                | '{'
                | '}'
                | '"'
                | '\''
                | '`'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '「'
                | '」'
                | '『'
                | '』'
                | '（'
                | '）'
                | '【'
                | '】'
                | ':'
                | '：'
                | '.'
                | '。'
                | ','
                | '，'
                | '、'
        )
    })
    .trim()
}

fn strip_keyword_prefix(raw: &str) -> &str {
    strip_case_insensitive_prefix(raw, "FACT:")
        .or_else(|| strip_case_insensitive_prefix(raw, "OPEN:"))
        .or_else(|| strip_case_insensitive_prefix(raw, "ARC:"))
        .unwrap_or(raw)
}

fn strip_korean_keyword_particle_inner(token: &str, preserve_genitive: bool) -> String {
    if !contains_hangul(token) {
        return token.to_string();
    }

    let narrative_endings = ["이었음", "였음", "었음", "았음", "했음", "되었음", "됨"];

    for suffix in narrative_endings {
        if let Some(stripped) = token.strip_suffix(suffix) {
            if keyword_normalized_key(stripped).chars().count() >= KEYWORD_MIN_CHARS {
                return stripped.to_string();
            }
        }
    }

    if KOREAN_KEYWORD_ANCHORS.iter().any(|anchor| token == *anchor) {
        return token.to_string();
    }

    let suffixes = [
        "으로부터",
        "에게서",
        "한테서",
        "께서는",
        "에서는",
        "으로",
        "에게",
        "한테",
        "께서",
        "에서",
        "부터",
        "까지",
        "처럼",
        "마저",
        "조차",
        "이나",
        "나",
        "은",
        "는",
        "이",
        "가",
        "을",
        "를",
        "의",
        "와",
        "과",
        "도",
        "로",
    ];

    for suffix in suffixes {
        if preserve_genitive && suffix == "의" {
            continue;
        }
        if let Some(stripped) = token.strip_suffix(suffix) {
            if keyword_normalized_key(stripped).chars().count() >= KEYWORD_MIN_CHARS {
                return stripped.to_string();
            }
        }
    }

    token.to_string()
}

fn strip_japanese_keyword_particle(token: &str) -> String {
    if !contains_japanese(token) {
        return token.to_string();
    }

    let suffixes = [
        "から", "まで", "には", "では", "とは", "へ", "が", "を", "に", "で", "と", "の", "は",
        "も",
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

fn strip_keyword_particle(token: &str, preserve_korean_genitive: bool) -> String {
    let stripped = strip_korean_keyword_particle_inner(token, preserve_korean_genitive);
    strip_japanese_keyword_particle(&stripped)
}

fn normalize_keyword_words(raw_words: &[String]) -> Vec<String> {
    raw_words
        .iter()
        .enumerate()
        .map(|(idx, word)| strip_keyword_particle(word, idx + 1 < raw_words.len()))
        .map(|word| trim_keyword_punctuation(&word).to_string())
        .filter(|word| !word.is_empty())
        .collect()
}

fn trim_english_function_words(words: Vec<String>) -> Vec<String> {
    let leading = [
        "a", "an", "the", "in", "at", "on", "under", "beneath", "below", "above", "near", "inside",
        "outside", "from", "to", "of", "for", "with", "by",
    ];
    let trailing = ["of", "in", "at", "on", "under", "beneath", "with", "by"];

    let mut start = 0;
    let mut end = words.len();

    while start < end
        && leading
            .iter()
            .any(|word| words[start].eq_ignore_ascii_case(word))
    {
        start += 1;
    }

    while end > start
        && trailing
            .iter()
            .any(|word| words[end - 1].eq_ignore_ascii_case(word))
    {
        end -= 1;
    }

    words[start..end].to_vec()
}

fn trim_low_signal_edge_words(words: Vec<String>) -> Vec<String> {
    let mut start = 0;
    let mut end = words.len();

    while start < end && is_keyword_edge_noise(&words[start]) {
        start += 1;
    }

    while end > start && is_keyword_edge_noise(&words[end - 1]) {
        end -= 1;
    }

    words[start..end].to_vec()
}

fn is_keyword_edge_noise(keyword: &str) -> bool {
    let normalized_key = keyword_normalized_key(keyword).to_lowercase();
    matches!(
        normalized_key.as_str(),
        "arc"
            | "act"
            | "part"
            | "chapter"
            | "chapters"
            | "section"
            | "summary"
            | "keyword"
            | "keywords"
            | "plot"
            | "story"
            | "state"
            | "current"
            | "previous"
            | "latest"
            | "recent"
            | "covered"
            | "development"
            | "setup"
            | "opening"
            | "middle"
            | "ending"
            | "beginning"
            | "transition"
            | "turn"
            | "twist"
            | "발단"
            | "전개"
            | "위기"
            | "절정"
            | "결말"
            | "서장"
            | "종장"
            | "초반"
            | "중반"
            | "후반"
            | "초반부"
            | "중반부"
            | "후반부"
            | "챕터"
            | "파트"
            | "요약"
            | "키워드"
            | "序章"
            | "終章"
            | "章"
            | "部"
            | "編"
            | "展開"
            | "現在"
            | "前回"
            | "今回"
            | "次回"
            | "要約"
            | "キーワード"
    )
}

fn is_likely_chapter_reference_keyword(keyword: &str, normalized_key: &str) -> bool {
    if normalized_key.chars().all(|ch| ch.is_ascii_digit()) {
        return true;
    }

    let lower = keyword.to_ascii_lowercase();
    let compact = normalized_key.to_ascii_lowercase();
    if lower
        .split_whitespace()
        .next()
        .is_some_and(|word| matches!(word, "chapter" | "chapters" | "ch." | "ch"))
    {
        return true;
    }

    compact.starts_with("chapter")
        || compact.starts_with("chapters")
        || compact.starts_with("제") && compact.ends_with("장")
        || compact.starts_with("第") && (compact.ends_with("章") || compact.ends_with("部"))
}

fn is_low_signal_keyword(keyword: &str) -> bool {
    let normalized_key = keyword_normalized_key(keyword);
    if normalized_key.is_empty() {
        return true;
    }

    if keyword.chars().any(|ch| ch.is_ascii_digit())
        && !keyword.chars().any(|ch| ch.is_alphabetic())
    {
        return true;
    }

    is_likely_chapter_reference_keyword(keyword, &normalized_key)
        || LOW_SIGNAL_KEYWORDS
            .iter()
            .any(|item| normalized_key == item.to_lowercase())
}

fn is_keyword_anchor(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    KOREAN_KEYWORD_ANCHORS
        .iter()
        .any(|anchor| text.contains(*anchor))
        || JAPANESE_KEYWORD_ANCHORS
            .iter()
            .any(|anchor| text.contains(*anchor))
        || ENGLISH_KEYWORD_ANCHORS
            .iter()
            .any(|anchor| lower.contains(*anchor))
}

fn keyword_anchor_count(text: &str) -> usize {
    let lower = text.to_ascii_lowercase();
    KOREAN_KEYWORD_ANCHORS
        .iter()
        .filter(|anchor| text.contains(*anchor))
        .count()
        + JAPANESE_KEYWORD_ANCHORS
            .iter()
            .filter(|anchor| text.contains(*anchor))
            .count()
        + ENGLISH_KEYWORD_ANCHORS
            .iter()
            .filter(|anchor| lower.contains(*anchor))
            .count()
}

fn keyword_quality_score(keyword: &str) -> i32 {
    let word_count = keyword.split_whitespace().count();
    let normalized_len = keyword_normalized_key(keyword).chars().count() as i32;
    let anchor_count = keyword_anchor_count(keyword) as i32;
    let mut score = anchor_count * 30 + normalized_len.min(12);

    if word_count > 1 {
        score += 70 + (word_count as i32).min(KEYWORD_MAX_WORDS as i32) * 5;
    } else {
        score += 15;
    }

    if contains_hangul(keyword)
        && keyword
            .split_whitespace()
            .any(looks_like_korean_name_fragment)
    {
        score += 70;
    }

    if contains_japanese(keyword)
        && keyword
            .chars()
            .any(|ch| ('\u{30a0}'..='\u{30ff}').contains(&ch))
    {
        score += 25;
    }

    if contains_ascii_alphabetic(keyword)
        && keyword.split_whitespace().any(|word| {
            word.chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_uppercase())
        })
    {
        score += 20;
    }

    if word_count == 1 && anchor_count == 0 {
        score -= 10;
    }

    score
}

fn is_likely_korean_inflected_fragment(token: &str) -> bool {
    if !contains_hangul(token) || token.split_whitespace().count() > 1 {
        return false;
    }

    let normalized_key = keyword_normalized_key(token);
    if LOW_SIGNAL_KEYWORDS
        .iter()
        .any(|item| normalized_key == item.to_lowercase())
    {
        return true;
    }

    [
        "하기",
        "하며",
        "하고",
        "하는",
        "했다",
        "했음",
        "했던",
        "되는",
        "되어",
        "되었음",
        "이었음",
        "였음",
        "었음",
        "았음",
        "됨",
        "받은",
        "잃은",
        "찾은",
        "쫓는",
        "담긴",
        "물든",
        "투성",
        "투성이",
        "로운",
        "스러운",
        "스럽게",
        "하게",
        "무너지는",
        "깨어나는",
        "뒤틀린",
        "남겨진",
        "고립된",
        "금기된",
        "숨겨진",
        "드러난",
        "밝혀진",
        "이어진",
        "깨진",
        "짧은",
        "미묘한",
        "풍부한",
        "의심스러운",
    ]
    .iter()
    .any(|suffix| token.ends_with(suffix))
}

fn looks_like_korean_name_fragment(token: &str) -> bool {
    if !contains_hangul(token) {
        return false;
    }

    let len = keyword_normalized_key(token).chars().count();
    if len < 3 || is_likely_korean_inflected_fragment(token) {
        return false;
    }

    let starts_like_transliterated_name = token.chars().next().is_some_and(|ch| {
        matches!(
            ch,
            '아' | '에'
                | '카'
                | '라'
                | '리'
                | '루'
                | '레'
                | '로'
                | '벨'
                | '베'
                | '세'
                | '엘'
                | '오'
                | '유'
        )
    });
    let contains_name_hint = token
        .chars()
        .any(|ch| matches!(ch, '스' | '엘' | '데' | '르' | '안' | '모'));
    if !starts_like_transliterated_name && !contains_name_hint {
        return false;
    }

    !matches!(
        token.chars().last(),
        Some(
            '력' | '감'
                | '성'
                | '중'
                | '후'
                | '전'
                | '들'
                | '것'
                | '수'
                | '함'
                | '됨'
                | '기'
                | '화'
                | '적'
        )
    )
}

fn is_high_signal_standalone_keyword(token: &str) -> bool {
    let normalized_key = keyword_normalized_key(token);
    let len = normalized_key.chars().count();
    if len < KEYWORD_MIN_CHARS || is_low_signal_keyword(token) {
        return false;
    }

    if contains_hangul(token) {
        let strong_short_anchor = matches!(
            keyword_normalized_key(token).as_str(),
            "심연" | "마왕" | "균열" | "봉인" | "저주"
        );
        return strong_short_anchor
            || is_keyword_anchor(token) && len >= 2
            || looks_like_korean_name_fragment(token);
    }

    if contains_japanese(token) {
        return is_keyword_anchor(token)
            || !is_likely_japanese_inflected_fragment(token) && len >= 4;
    }

    if token.chars().any(|ch| ch.is_ascii_alphabetic()) {
        let starts_like_name = token
            .chars()
            .find(|ch| ch.is_ascii_alphabetic())
            .is_some_and(|ch| ch.is_ascii_uppercase());
        let all_caps = token
            .chars()
            .filter(|ch| ch.is_ascii_alphabetic())
            .all(|ch| ch.is_ascii_uppercase());
        return all_caps && len >= 2 || starts_like_name && len >= 6;
    }

    false
}

fn is_likely_japanese_inflected_fragment(token: &str) -> bool {
    if !contains_japanese(token) {
        return false;
    }

    let normalized_key = keyword_normalized_key(token);
    if LOW_SIGNAL_KEYWORDS
        .iter()
        .any(|item| normalized_key == item.to_lowercase())
    {
        return true;
    }

    [
        "する",
        "した",
        "して",
        "された",
        "される",
        "なる",
        "なった",
        "いる",
        "いた",
        "生きる",
        "きる",
        "見せる",
        "示す",
        "まみれ",
    ]
    .iter()
    .any(|suffix| token.ends_with(suffix))
}

fn is_likely_english_action_or_descriptor(token: &str) -> bool {
    if !token.chars().all(|ch| ch.is_ascii_alphabetic()) {
        return false;
    }

    let lower = token.to_ascii_lowercase();
    if LOW_SIGNAL_KEYWORDS.iter().any(|item| lower == *item) {
        return true;
    }

    let starts_like_name = token
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_uppercase());
    !starts_like_name
        && (lower.ends_with("ing")
            || lower.ends_with("ed")
            || lower.ends_with("ly")
            || lower.ends_with("ive")
            || lower.ends_with("ous"))
}

fn is_low_quality_standalone_keyword(candidate: &str) -> bool {
    if candidate.split_whitespace().count() != 1 {
        return false;
    }

    if contains_hangul(candidate) {
        return is_likely_korean_inflected_fragment(candidate);
    }

    if contains_japanese(candidate) {
        return !is_keyword_anchor(candidate) && is_likely_japanese_inflected_fragment(candidate);
    }

    if contains_ascii_alphabetic(candidate) {
        return !is_keyword_anchor(candidate) && is_likely_english_action_or_descriptor(candidate);
    }

    false
}

fn is_meaningful_keyword_phrase(phrase: &str) -> bool {
    let normalized_key = keyword_normalized_key(phrase);
    if normalized_key.chars().count() < KEYWORD_MIN_CHARS || is_low_signal_keyword(phrase) {
        return false;
    }

    let anchor_count = keyword_anchor_count(phrase);
    if anchor_count == 0 {
        return false;
    }
    if anchor_count >= 2 {
        return true;
    }

    phrase.split_whitespace().any(|word| {
        keyword_normalized_key(word).chars().count() >= KEYWORD_MIN_CHARS
            && !is_low_signal_keyword(word)
            && !is_keyword_anchor(word)
    })
}

fn normalize_keyword_candidate(raw: &str) -> Option<String> {
    let normalized_item = normalize_memory_item(raw);
    let trimmed = strip_keyword_prefix(&normalized_item).trim();
    let trimmed = trim_keyword_punctuation(trimmed);

    if trimmed.is_empty() || is_placeholder_text(trimmed) || is_placeholder_keyword(trimmed) {
        return None;
    }

    let raw_words: Vec<String> = trimmed
        .split_whitespace()
        .map(|word| {
            trim_keyword_punctuation(word)
                .trim_end_matches("'s")
                .trim_end_matches("’s")
                .to_string()
        })
        .filter(|word| !word.is_empty())
        .collect();
    let words = trim_low_signal_edge_words(trim_english_function_words(normalize_keyword_words(
        &raw_words,
    )));

    let candidate = if words.is_empty() {
        strip_keyword_particle(trimmed, false)
    } else {
        words.join(" ")
    };

    let normalized_key = keyword_normalized_key(&candidate);

    if normalized_key.chars().count() < KEYWORD_MIN_CHARS {
        return None;
    }

    if normalized_key.chars().count() > KEYWORD_MAX_CHARS {
        return None;
    }

    if candidate.split_whitespace().count() > KEYWORD_MAX_WORDS {
        return None;
    }

    if is_placeholder_keyword(&candidate)
        || is_low_signal_keyword(&candidate)
        || is_low_quality_standalone_keyword(&candidate)
    {
        return None;
    }

    let normalized = if contains_ascii_alphabetic(&candidate) {
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

    let mut segments = Vec::new();

    for capture in RE_QUOTED_KEYWORD.captures_iter(trimmed) {
        if let Some(term) = capture.name("term") {
            let candidate = term.as_str().trim();
            if !candidate.is_empty() {
                segments.push(candidate.to_string());
            }
        }
    }

    for capture in RE_JAPANESE_KEYWORD_PHRASE.captures_iter(trimmed) {
        if let Some(term) = capture.name("term") {
            let candidate = term.as_str().trim();
            if !candidate.is_empty() {
                segments.push(candidate.to_string());
            }
        }
    }

    let raw_words: Vec<String> = trimmed
        .split(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    ',' | ';'
                        | '/'
                        | '|'
                        | '\n'
                        | '\r'
                        | ':'
                        | '!'
                        | '?'
                        | '.'
                        | '·'
                        | '•'
                        | '-'
                        | '–'
                        | '—'
                        | '，'
                        | '、'
                        | '。'
                        | '！'
                        | '？'
                        | '：'
                        | '('
                        | ')'
                        | '（'
                        | '）'
                        | '['
                        | ']'
                        | '【'
                        | '】'
                        | '{'
                        | '}'
                        | '"'
                        | '\''
                        | '“'
                        | '”'
                        | '‘'
                        | '’'
                        | '「'
                        | '」'
                        | '『'
                        | '』'
                        | '`'
                )
        })
        .map(|segment| {
            trim_keyword_punctuation(segment)
                .trim_end_matches("'s")
                .trim_end_matches("’s")
                .to_string()
        })
        .filter(|segment| !segment.is_empty())
        .collect();
    let words = normalize_keyword_words(&raw_words);

    if words.len() >= 2 {
        for window in words.windows(2) {
            let phrase = window.join(" ");
            if is_meaningful_keyword_phrase(&phrase) {
                segments.push(phrase);
            }
        }
    }

    for capture in RE_KOREAN_KEYWORD_PHRASE.captures_iter(trimmed) {
        if let Some(term) = capture.name("term") {
            let candidate = term.as_str().trim();
            if !candidate.is_empty() {
                segments.push(candidate.to_string());
            }
        }
    }

    let standalone_words: Vec<String> = raw_words
        .iter()
        .map(|word| strip_keyword_particle(word, false))
        .map(|word| trim_keyword_punctuation(&word).to_string())
        .filter(|word| !word.is_empty())
        .collect();
    for word in &standalone_words {
        if is_high_signal_standalone_keyword(word) {
            segments.push(word.clone());
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
    let trimmed = text.trim().trim_matches(|c: char| {
        matches!(
            c,
            '.' | ',' | ':' | ';' | '-' | '*' | '"' | '\'' | '`' | ' ' | '\t'
        )
    });
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

fn normalize_relationship_state_items(items: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();

    for item in items {
        let cleaned = normalize_memory_item(&item);
        if cleaned.is_empty() {
            continue;
        }

        let canonical = if let Some(rest) = strip_case_insensitive_prefix(&cleaned, "REL:") {
            if is_placeholder_text(rest) {
                continue;
            }
            format!("REL: {}", rest)
        } else {
            if is_placeholder_text(&cleaned) {
                continue;
            }
            format!("REL: {}", cleaned)
        };

        let dedupe_key: String = normalized_char_stream(&canonical).into_iter().collect();
        if seen.insert(dedupe_key) {
            normalized.push(canonical);
        }

        if normalized.len() >= 12 {
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

fn normalize_scene_pattern_items(items: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();

    for item in items {
        let cleaned = normalize_memory_item(&item);
        if cleaned.is_empty() {
            continue;
        }

        let canonical = if let Some(rest) = strip_case_insensitive_prefix(&cleaned, "SCENE:") {
            if is_placeholder_text(rest) {
                continue;
            }
            format!("SCENE: {}", rest)
        } else {
            if is_placeholder_text(&cleaned) {
                continue;
            }
            format!("SCENE: {}", cleaned)
        };

        let dedupe_key: String = normalized_char_stream(&canonical).into_iter().collect();
        if seen.insert(dedupe_key) {
            normalized.push(canonical);
        }

        if normalized.len() >= 12 {
            break;
        }
    }

    normalized
}

fn normalize_continuity_payload(
    payload: ContinuityUpdatePayload,
) -> Option<ContinuityUpdatePayload> {
    let story_state = normalize_story_state_items(payload.story_state);
    let character_state = normalize_character_state_items(payload.character_state);
    let relationship_state = normalize_relationship_state_items(payload.relationship_state);
    let current_arc = normalize_arc_items(payload.current_arc);
    let mut current_arc_keywords = normalize_keyword_items(payload.current_arc_keywords);
    let recent_scene_patterns = normalize_scene_pattern_items(payload.recent_scene_patterns);
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
        || !relationship_state.is_empty()
        || !current_arc.is_empty()
        || !current_arc_keywords.is_empty()
        || !recent_scene_patterns.is_empty()
        || !closed_arc_summary.is_empty()
        || !closed_arc_keywords.is_empty();

    if !has_signal {
        return None;
    }

    Some(ContinuityUpdatePayload {
        story_state,
        character_state,
        relationship_state,
        current_arc,
        current_arc_keywords,
        recent_scene_patterns,
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

    for candidate in std::iter::once(sanitized.clone())
        .chain(extract_balanced_json_objects(&sanitized).into_iter())
    {
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
                stack.push(JsonContainerContext::Object {
                    expecting_key: true,
                });
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
                    Some(JsonContainerContext::Object {
                        expecting_key: true
                    })
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
        let next = RE_JSON_TRAILING_COMMA
            .replace_all(&cleaned, "$1")
            .to_string();
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
        "relationship_state",
        "current_arc",
        "current_arc_keywords",
        "recent_scene_patterns",
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

fn coerce_payload_from_object(
    map: &serde_json::Map<String, Value>,
) -> Option<ContinuityUpdatePayload> {
    if !object_looks_like_continuity_payload(map) {
        return None;
    }

    normalize_continuity_payload(ContinuityUpdatePayload {
        story_state: coerce_string_list(map.get("story_state")),
        character_state: coerce_string_list(map.get("character_state")),
        relationship_state: coerce_string_list(map.get("relationship_state")),
        current_arc: coerce_string_list(map.get("current_arc")),
        current_arc_keywords: coerce_string_list(map.get("current_arc_keywords")),
        recent_scene_patterns: coerce_string_list(map.get("recent_scene_patterns")),
        close_current_arc: coerce_bool(map.get("close_current_arc")),
        closed_arc_summary: coerce_string_list(map.get("closed_arc_summary")),
        closed_arc_keywords: coerce_string_list(map.get("closed_arc_keywords")),
    })
}

fn extract_payload_from_value(value: &Value, depth: usize) -> Option<ContinuityUpdatePayload> {
    match value {
        Value::Object(map) => coerce_payload_from_object(map).or_else(|| {
            map.values()
                .find_map(|entry| extract_payload_from_value(entry, depth))
        }),
        Value::Array(values) => values
            .iter()
            .find_map(|entry| extract_payload_from_value(entry, depth)),
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
