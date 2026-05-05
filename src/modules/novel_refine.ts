import { AppState } from './app_state.js';
import { generateInstructionForChapter } from './novel_auto.js';
import {
    getTargetTokensParam,
    getTotalChaptersParam,
} from '../services/generationParamsService.js';
import {
    clearNovelRefineChapterRangeState,
    getEditorSnapshot,
    setNovelRefineChapterRange,
    setNovelStatus,
    setNovelText,
} from '../services/runtimeEditorStateService.js';
import { runtimeViewStateStore } from '../services/runtimeViewStateStore.js';
import { Channel, invoke } from './tauri_api.js';
import { showToast } from './toast.js';
import { estimateTokenCount, getPartPlan, splitPlotIntoChapters } from './text_utils.js';

const FULL_PLOT_CONTEXT_CHARS = 24000;
const PREVIOUS_CONTEXT_CHARS = 2600;
const NEXT_CONTEXT_CHARS = 1600;
const ORIGINAL_ENDING_CONTEXT_CHARS = 3200;
const CONTINUATION_TAIL_CHARS = 5200;
const MIN_REFINED_LENGTH_RATIO = 0.72;
const MAX_CONTINUATION_ATTEMPTS = 2;
const MAX_REFINE_OUTPUT_TOKENS = 32768;

function normalizeDigits(value) {
    return String(value || '').replace(/[０-９]/g, ch =>
        String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    );
}

function parseChapterNumber(value) {
    const parsed = parseInt(normalizeDigits(value), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function stripHeadingDecoration(line) {
    let text = String(line || '').trim();
    const hasMarkdownHeading = /^#{1,6}\s+/.test(text);
    text = text
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s*/, '')
        .replace(/^\*\*/, '')
        .replace(/\*\*$/, '')
        .trim();

    return { text, hasMarkdownHeading };
}

function parseChapterHeadingLine(line, lang) {
    const raw = String(line || '').trim();
    if (!raw) return null;

    const { text, hasMarkdownHeading } = stripHeadingDecoration(raw);
    if (!text || charCount(text) > 90) return null;

    let match = null;
    if (lang === 'Korean') {
        match = text.match(/^(제\s*)?([0-9０-９]+)\s*장(?:\s*[:：.)、\-–—]\s*.*|\s+.*|$)/i);
        if (!match || (!hasMarkdownHeading && !match[1])) return null;
        return {
            number: parseChapterNumber(match[2]),
            header: raw,
        };
    }

    if (lang === 'Japanese') {
        match = text.match(/^(第\s*)?([0-9０-９]+)\s*章(?:\s*[:：.)、\-–—]\s*.*|\s+.*|$)/i);
        if (!match || (!hasMarkdownHeading && !match[1])) return null;
        return {
            number: parseChapterNumber(match[2]),
            header: raw,
        };
    }

    match = text.match(/^Chapter\s+([0-9０-９]+)(?:\s*[:：.)、\-–—]\s*.*|\s+.*|$)/i);
    if (!match) return null;
    return {
        number: parseChapterNumber(match[1]),
        header: raw,
    };
}

function formatPartHeading(partNumber, lang) {
    if (lang === 'Korean') return `## 제 ${partNumber}부`;
    if (lang === 'Japanese') return `## 第 ${partNumber} 部`;
    return `## Part ${partNumber}`;
}

function parsePartHeadingLine(line, lang) {
    const raw = String(line || '').trim();
    if (!raw) return null;

    const { text } = stripHeadingDecoration(raw);
    if (!text || charCount(text) > 90) return null;

    let match = null;
    if (lang === 'Korean') {
        match = text.match(/^(?:제\s*)?([0-9０-９]+)\s*부(\s*[:：.)、\-–—]\s*.*)?$/i);
    } else if (lang === 'Japanese') {
        match = text.match(/^第\s*([0-9０-９]+)\s*部(\s*[:：.)、\-–—]\s*.*)?$/i);
    } else {
        match = text.match(/^Part\s+([0-9０-９]+)(\s*[:：.)、\-–—]\s*.*)?$/i);
    }

    if (!match) return null;
    return {
        number: parseChapterNumber(match[1]),
        suffix: match[2] || '',
    };
}

function splitOutPartHeadings(text, lang) {
    const partHeadings = [];
    const keptLines = [];

    for (const line of String(text || '').split(/\r?\n/)) {
        const parsed = parsePartHeadingLine(line, lang);
        if (parsed?.number) {
            partHeadings.push({ ...parsed, line: line.trim() });
        } else {
            keptLines.push(line);
        }
    }

    return {
        text: keptLines.join('\n').trim(),
        partHeadings,
    };
}

function appendOutro(existing, heading) {
    return [String(existing || '').trim(), heading.trim()]
        .filter(Boolean)
        .join('\n\n');
}

export function normalizeNovelPartHeadings(intro, chapters, lang, totalChapters) {
    const workingChapters = chapters.map(chapter => ({ ...chapter }));
    const introParts = splitOutPartHeadings(intro, lang);
    let cleanIntro = introParts.text;
    const existingByNextChapter = new Map();

    if (workingChapters.length > 0) {
        const firstChapterNumber = workingChapters[0].number;
        for (const partHeading of introParts.partHeadings) {
            existingByNextChapter.set(firstChapterNumber, partHeading);
        }
    }

    for (let i = 0; i < workingChapters.length; i++) {
        const outroParts = splitOutPartHeadings(workingChapters[i].outro, lang);
        workingChapters[i].outro = outroParts.text;

        const nextChapterNumber = workingChapters[i + 1]?.number;
        if (!nextChapterNumber) continue;
        for (const partHeading of outroParts.partHeadings) {
            existingByNextChapter.set(nextChapterNumber, partHeading);
        }
    }

    const plan = getPartPlan(totalChapters);
    for (const { part, start, end } of plan) {
        const targetIndex = workingChapters.findIndex(chapter =>
            chapter.number >= start && chapter.number <= end
        );
        if (targetIndex < 0) continue;

        const targetChapterNumber = workingChapters[targetIndex].number;
        const existing = existingByNextChapter.get(targetChapterNumber);
        const heading = `${formatPartHeading(part, lang)}${existing?.suffix || ''}`;

        if (targetIndex === 0) {
            cleanIntro = appendOutro(cleanIntro, heading);
        } else {
            const previous = workingChapters[targetIndex - 1];
            previous.outro = appendOutro(previous.outro, heading);
        }
    }

    return { intro: cleanIntro, chapters: workingChapters };
}

function findChapterHeadings(source, lang) {
    const headings = [];
    const pattern = /[^\n]*(?:\n|$)/g;
    let match;

    while ((match = pattern.exec(source)) !== null) {
        const fullLine = match[0];
        if (!fullLine && match.index >= source.length) break;

        const line = fullLine.replace(/\n$/, '');
        const parsed = parseChapterHeadingLine(line, lang);
        if (parsed?.number) {
            headings.push({
                ...parsed,
                index: match.index,
                length: line.length,
            });
        }

        if (pattern.lastIndex >= source.length) break;
    }

    return headings;
}

export function getNovelChapterHeadings(text, lang) {
    return findChapterHeadings(String(text || '').replace(/\r\n/g, '\n'), lang)
        .filter(heading => Number.isFinite(heading.number));
}

export function splitNovelIntoChapterBlocks(text, lang, { fallbackToWhole = true } = {}) {
    const source = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!source) {
        return { intro: '', chapters: [] };
    }

    const headings = findChapterHeadings(source, lang);
    if (headings.length === 0) {
        return {
            intro: fallbackToWhole ? '' : source,
            chapters: fallbackToWhole
                ? [{ number: 1, header: '', body: source }]
                : [],
        };
    }

    const intro = source.slice(0, headings[0].index).trim();
    const chapters = [];

    for (let i = 0; i < headings.length; i++) {
        const heading = headings[i];
        const bodyStart = heading.index + heading.length;
        const end = headings[i + 1]?.index ?? source.length;
        let rawBody = source.slice(bodyStart, end).trim();
        let bodyOutro = '';

        // Extract trailing part headings so they are preserved outside the chapter body during refine.
        const lines = rawBody.split('\n');
        const trailingHeadings = [];
        while (lines.length > 0) {
            const lastLine = lines[lines.length - 1].trim();
            if (lastLine === '') {
                lines.pop();
                continue;
            }
            if (parsePartHeadingLine(lastLine, lang)) {
                trailingHeadings.unshift(lastLine);
                lines.pop();
            } else {
                break;
            }
        }
        
        if (trailingHeadings.length > 0) {
            rawBody = lines.join('\n').trim();
            bodyOutro = trailingHeadings.join('\n\n').trim();
        }

        chapters.push({
            number: heading.number,
            header: heading.header,
            body: rawBody,
            outro: bodyOutro
        });
    }

    return { intro, chapters };
}

function assembleNovel(intro, chapters) {
    const blocks = [];
    const cleanIntro = String(intro || '').trim();
    if (cleanIntro) blocks.push(cleanIntro);

    for (const chapter of chapters) {
        const header = String(chapter.header || '').trim();
        const body = String(chapter.body || '').trim();
        const outro = String(chapter.outro || '').trim();
        
        let block = header ? `${header}\n\n${body}`.trim() : body;
        if (outro) {
            block = `${block}\n\n${outro}`;
        }
        if (block) blocks.push(block);
    }

    return blocks.join('\n\n').trimEnd();
}

function takeHead(text, maxChars) {
    const chars = Array.from(String(text || ''));
    if (chars.length <= maxChars) return String(text || '');
    return `${chars.slice(0, maxChars).join('')}\n[...]`;
}

function takeTail(text, maxChars) {
    const chars = Array.from(String(text || ''));
    if (chars.length <= maxChars) return String(text || '');
    return `[...]${chars.slice(-maxChars).join('')}`;
}

function charCount(text) {
    return Array.from(String(text || '')).length;
}

function trimMiddleForPrompt(text, maxChars) {
    const chars = Array.from(String(text || ''));
    if (chars.length <= maxChars) return String(text || '');

    const half = Math.floor((maxChars - 80) / 2);
    return [
        chars.slice(0, half).join(''),
        '[...middle of full plot omitted for context size...]',
        chars.slice(-half).join(''),
    ].join('\n\n');
}

function outputOnlyRule(lang) {
    if (lang === 'Korean') {
        return '수정된 현재 장 본문만 출력한다. 장 제목, 진단, 수정 방향, 설명, 코드펜스, 인사말은 절대 출력하지 않는다.';
    }
    if (lang === 'Japanese') {
        return '修正済みの現在章本文だけを出力する。章見出し、診断、修正方針、説明、コードフェンス、挨拶は出力しない。';
    }
    return 'Output only the revised current chapter body. Do not output the chapter heading, diagnosis, revision notes, explanations, code fences, or greetings.';
}

function overstatementGuide(lang) {
    if (lang === 'Korean') {
        return '현재 원고 안에서 반복되는 추상적 감탄, 과장된 규모감, 직접적인 의미 해설, 인물의 과도한 경외 표현을 줄이고 행동, 감각, 침묵, 구체적 결과로 대체한다.';
    }
    if (lang === 'Japanese') {
        return '現在の原稿内で繰り返される抽象的な賛嘆、過度なスケール感、直接的な意味説明、人物による過剰な崇拝表現を減らし、行動・感覚・沈黙・具体的な結果に置き換える。';
    }
    return 'Reduce repeated abstract awe, inflated scale, direct explanation of meaning, and excessive admiration of any character; replace them with action, sensory detail, silence, and concrete consequences.';
}

function emotionalRepetitionGuide(lang) {
    if (lang === 'Korean') {
        return `- 장면 기능 개선을 목표로 한다.
- 원고의 언어와 장르 안에서 반복되는 감정 장치, 예를 들어 침묵/정적, 온기/차가움, 위태로움/흔들림, 닿고 싶은 충동, 손을 뻗다 멈추는 동작처럼 같은 역할을 하는 표현군을 찾아 줄인다.
- 같은 감정을 반복 설명하지 말고, 각 장면마다 관계가 아주 조금씩 진전되게 한다.
- 추상적인 결론 문장보다 구체적인 행동, 물건, 시선, 호흡, 거리 변화로 마무리한다.
- 전체 플롯과 분위기는 유지하되, 장면마다 감정의 변화값을 더 선명하게 만든다.`;
    }
    if (lang === 'Japanese') {
        return `- 場面機能の改善を目的にする。
- 原稿の言語とジャンル内で繰り返される感情装置、たとえば沈黙/静けさ、温もり/冷たさ、危うさ/揺らぎ、触れたい衝動、手を伸ばしかけて止める動作のように同じ役割を果たす表現群を見つけて減らす。
- 同じ感情を説明し直すのではなく、各場面で関係が少しずつ進むようにする。
- 抽象的な結論文より、具体的な行動、物、視線、呼吸、距離の変化で場面を閉じる。
- 全体のプロットと雰囲気は維持しつつ、場面ごとの感情の変化量をより明確にする。`;
    }
    return `- Improve scene function, not just wording.
- Identify and reduce repeated emotional devices within the manuscript's language and genre, such as silence/stillness, warmth/coldness, fragility/instability, the impulse to touch, or reaching out and stopping when those expressions serve the same emotional function.
- Do not explain the same feeling again; make the relationship move forward by a small but visible degree in each scene.
- End scenes with concrete action, an object, gaze, breath, or a change in physical distance rather than an abstract concluding sentence.
- Preserve the overall plot and atmosphere, but make the emotional change value of each scene clearer.`;
}

function characterVoiceGuide(lang) {
    if (lang === 'Korean') {
        return `- 새 인물이나 새 설정을 임의로 추가하지 않는다.
- 현재 원고와 플롯에서 각 인물의 욕망, 두려움, 판단 기준, 사회적 위치, 관계 긴장을 추론한다.
- 모든 인물이 같은 방식으로 감탄하거나 해설하지 않게 한다.
- 대사는 인물의 목적, 정보 격차, 숨기는 감정, 관계의 힘 차이를 드러내게 한다.
- 주인공의 반응도 장르 역할에만 묶지 말고 관찰, 오판, 망설임, 계산, 피로 같은 인간적인 결을 허용한다.`;
    }
    if (lang === 'Japanese') {
        return `- 新しい人物や新設定を勝手に追加しない。
- 現在の原稿とプロットから、各人物の欲望、恐れ、判断基準、社会的位置、関係の緊張を推定する。
- すべての人物が同じ口調で感嘆したり説明したりしないようにする。
- 台詞は人物の目的、情報差、隠した感情、関係上の力の差を表すようにする。
- 主人公の反応にも、観察、誤判断、ためらい、計算、疲労など人間的な揺れを許す。`;
    }
    return `- Do not invent new characters or new setting rules.
- Infer each character's desire, fear, judgment criteria, social position, and relationship tension from the current manuscript and plot.
- Do not let every character admire, explain, or react in the same way.
- Dialogue should reveal purpose, information gaps, concealed emotion, and power dynamics.
- Give the protagonist human texture through observation, misjudgment, hesitation, calculation, fatigue, or restraint when appropriate.`;
}

function buildAdjacentPlotContext(plotChapters, chapterNumber) {
    const previous = plotChapters[chapterNumber - 1];
    const next = plotChapters[chapterNumber + 1];
    return [
        previous ? `[Previous Chapter Plot]\n${previous}` : '',
        next ? `[Next Chapter Plot]\n${next}` : '',
    ].filter(Boolean).join('\n\n') || 'None.';
}

function buildNovelRefinePrompt({
    lang,
    totalChapters,
    plotOutline,
    plotChapters,
    chapter,
    chapterIndex,
    chapterCount,
    previousRefinedContext,
    nextOriginalContext,
    userInstructions,
}) {
    const currentChapterPlot = plotChapters[chapter.number] || 'No exact chapter plot was found. Infer the chapter goal from the full plot outline and adjacent chapters.';
    const adjacentPlotContext = buildAdjacentPlotContext(plotChapters, chapter.number);

    return `You are a professional fiction developmental editor and line editor. Refine one chapter of an existing ${totalChapters}-chapter novel in ${lang}.

Perform these passes internally, in order:
1. Plot comparison: keep the original plot goal and event order, and make cause-action-result clearer.
2. Scene function check: make each scene earn its place through setup, pressure, choice, payoff/reversal, or hook.
3. Character emotion/conflict: add concrete inner movement, small costs, unease, choices, and non-repeating emotional progression where the chapter resolves too easily.
4. Style cleanup: ${overstatementGuide(lang)}
5. Character voice pass: separate speech, judgment criteria, and desire by character.
6. Connection check: strengthen the final hook without changing the next chapter's required direction.

REFINE GOALS:
- Preserve the current chapter's core events, continuity, named characters, world rules, and ending direction.
- The revised chapter must be complete from its opening beat through its final beat. Do not omit, summarize, or cut off the chapter ending.
- Do not rewrite the plot from scratch.
- Keep the revised body close to the original length, or 10~20% longer when scenes are compressed.
- Prefer specific observable reactions over broad generalized reactions.
- Let readers feel meaning through scene results instead of explanatory commentary.
- Vary sentence length; after a long description, place a short reaction or consequence.
- ${outputOnlyRule(lang)}

REPEATED EMOTION STRUCTURE PASS:
${emotionalRepetitionGuide(lang)}

CHARACTER VOICE GUIDE:
${characterVoiceGuide(lang)}

[Full Plot Outline - continuity reference, may be trimmed]
${trimMiddleForPrompt(plotOutline, FULL_PLOT_CONTEXT_CHARS)}

[Current Chapter]
Chapter number: ${chapter.number}
Progress: ${chapterIndex + 1}/${chapterCount}

[Current Chapter Plot Goal]
${currentChapterPlot}

[Adjacent Plot Context]
${adjacentPlotContext}

[Novel Refine Instructions]
${userInstructions || 'None.'}

[Previous Refined Context - continuity only, do not rewrite]
${previousRefinedContext || 'None.'}

[Next Original Chapter Opening - boundary only, do not rewrite]
${nextOriginalContext || 'None.'}

[Original Current Chapter Ending - must remain represented in the revised chapter]
${takeTail(chapter.body, ORIGINAL_ENDING_CONTEXT_CHARS)}

[Original Current Chapter Body - refine this only]
${chapter.body}`;
}

function buildContinuationPrompt({
    lang,
    chapter,
    currentRefinedBody,
    plotGoal,
    userInstructions,
}) {
    return `The previous refinement of chapter ${chapter.number} appears incomplete or too compressed near the ending.

Continue the revised chapter from exactly where the current refined draft stops.

RULES:
- Output only the missing continuation text for the same chapter body.
- Do not restart the chapter.
- Do not repeat paragraphs already present in the current refined draft.
- If the current refined draft stops mid-sentence or mid-paragraph, continue directly from that point without forcing a new paragraph.
- Preserve the original chapter's final beat, emotional turn, and hook.
- Keep the same language: ${lang}.

[Current Chapter Plot Goal]
${plotGoal || 'Infer from the chapter and full plot context.'}

[Novel Refine Instructions]
${userInstructions || 'None.'}

[Original Chapter Ending That Must Be Covered]
${takeTail(chapter.body, ORIGINAL_ENDING_CONTEXT_CHARS)}

[Current Refined Draft Ending]
${takeTail(currentRefinedBody, CONTINUATION_TAIL_CHARS)}`;
}

function stripCodeFence(text) {
    const trimmed = String(text || '').trim();
    const fence = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    return fence ? fence[1].trim() : trimmed;
}

function stripManuscriptLabel(text) {
    const lines = String(text || '').trim().split(/\r?\n/);
    const labelPattern = /^\s*(?:수정\s*원고|수정본|개정\s*원고|Refined\s*(?:Chapter|Draft|Manuscript)?|Revised\s*(?:Chapter|Draft|Manuscript)?|改稿|修正文|本文)\s*[:：-]?\s*/i;
    const markerIndex = lines.findIndex(line => labelPattern.test(line.trim()));

    if (markerIndex >= 0) {
        const sameLineRemainder = lines[markerIndex].replace(labelPattern, '').trim();
        const rest = lines.slice(markerIndex + 1);
        return [sameLineRemainder, ...rest].filter(Boolean).join('\n').trim();
    }

    return lines.join('\n').trim();
}

function removeLeadingChapterHeading(text, chapterNumber, lang) {
    const source = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!source) return '';

    const firstLineEnd = source.indexOf('\n');
    const firstLine = firstLineEnd >= 0 ? source.slice(0, firstLineEnd) : source;
    const parsed = parseChapterHeadingLine(firstLine, lang);
    if (!parsed || parsed.number !== chapterNumber) {
        return source;
    }

    return source.slice(firstLine.length).trim();
}

function trimAtNextChapterHeading(text, chapterNumber, lang) {
    const source = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!source) return '';

    const headings = findChapterHeadings(source, lang)
        .filter(heading => heading.index > 0 && heading.number !== chapterNumber);
    if (headings.length === 0) return source;

    return source.slice(0, headings[0].index).trim();
}

function sanitizeRefinedChapterBody(rawOutput, chapterNumber, lang) {
    let text = stripManuscriptLabel(stripCodeFence(rawOutput));
    text = removeLeadingChapterHeading(text, chapterNumber, lang);
    text = trimAtNextChapterHeading(text, chapterNumber, lang);
    text = splitOutPartHeadings(text, lang).text;
    return stripManuscriptLabel(stripCodeFence(text)).trim();
}

function withApiHint(message) {
    let msg = String(message || 'Unknown API error');
    if (msg.includes('401')) msg += '\n\n[Hint] Unauthorized. Check your API key.';
    else if (msg.includes('403')) msg += '\n\n[Hint] Forbidden. This might be a safety filter block or permission issue.';
    else if (msg.includes('429')) msg += '\n\n[Hint] Quota exceeded. Wait a moment or check your billing.';
    else if (msg.includes('Failed to parse input at pos 0')) {
        msg += '\n\n[Hint] Model mismatch detected. Ensure LM Studio chat template is correctly set for models like Gemma 4.';
    }
    return msg;
}

function maxTokensForChapter(chapterBody, targetTokens) {
    const chapterTokens = estimateTokenCount(chapterBody);
    const target = parseInt(targetTokens, 10) || 2000;
    return Math.min(
        MAX_REFINE_OUTPUT_TOKENS,
        Math.max(4096, Math.ceil(chapterTokens * 3.2), target + 3000),
    );
}

function maxTokensForContinuation(chapterBody, targetTokens) {
    const chapterTokens = estimateTokenCount(chapterBody);
    const target = parseInt(targetTokens, 10) || 2000;
    return Math.min(
        Math.ceil(MAX_REFINE_OUTPUT_TOKENS / 2),
        Math.max(4096, Math.ceil(chapterTokens * 1.2), target + 1800),
    );
}

function hasCompleteSentenceEnding(text) {
    return /[.!?。！？…」』”’)"'\]\}]\s*$/.test(String(text || '').trim());
}

function startsWithSentenceContinuation(text) {
    const trimmed = String(text || '').trimStart();
    if (!trimmed) return false;
    return /^[,.;:!?，。！？、」』”’)"'\]\}]/.test(trimmed);
}

function looksPossiblyTruncated(refinedBody, originalBody, maxTokens) {
    const refined = String(refinedBody || '').trim();
    const original = String(originalBody || '').trim();
    if (!refined || !original) return true;

    const originalChars = charCount(original);
    const refinedChars = charCount(refined);
    const lengthRatio = refinedChars / Math.max(1, originalChars);
    const refinedTokens = estimateTokenCount(refined);
    const nearTokenBudget = refinedTokens >= maxTokens * 0.82;
    const incompleteEnding = refinedChars >= 80 && !hasCompleteSentenceEnding(refined);
    const missingTooMuch = originalChars >= 1200 && lengthRatio < MIN_REFINED_LENGTH_RATIO;

    return missingTooMuch || incompleteEnding || (nearTokenBudget && !hasCompleteSentenceEnding(refined));
}

function appendWithOverlap(baseText, continuationText) {
    const base = String(baseText || '').trimEnd();
    let continuation = stripManuscriptLabel(stripCodeFence(continuationText)).trim();
    if (!base) return continuation;
    if (!continuation) return base;

    const maxOverlap = Math.min(900, base.length, continuation.length);
    for (let size = maxOverlap; size >= 40; size--) {
        if (base.slice(-size) === continuation.slice(0, size)) {
            continuation = continuation.slice(size).trimStart();
            break;
        }
    }

    if (!continuation) return base;

    if (!hasCompleteSentenceEnding(base) || startsWithSentenceContinuation(continuation)) {
        const separator = /\s$/.test(base) || startsWithSentenceContinuation(continuation) ? '' : ' ';
        return `${base}${separator}${continuation}`;
    }

    return `${base}\n\n${continuation}`;
}

async function generateRefinedChapter(prompt, {
    maxTokens,
    statusText,
    onDelta,
}) {
    let latestContent = '';
    let streamError = null;
    const onEvent = new Channel();

    onEvent.onmessage = (event) => {
        if (AppState.stopRequested && !event.is_finished && !event.error) return;

        latestContent = event.content || latestContent;
        onDelta?.(latestContent, event);

        if (event.error) {
            streamError = withApiHint(event.error);
        }
    };

    setNovelStatus(statusText, 'refining');
    const { apiSettings, generationParams, promptEditor } = runtimeViewStateStore.getSnapshot();
    await invoke('generate_plot', {
        params: {
            api_base: apiSettings.apiBase,
            model_name: apiSettings.modelName,
            api_key: apiSettings.apiKey || 'lm-studio',
            system_prompt: promptEditor.systemPrompt,
            prompt,
            temperature: parseFloat(generationParams.temperature),
            top_p: parseFloat(generationParams.topP),
            repetition_penalty: parseFloat(generationParams.repetitionPenalty),
            max_tokens: maxTokens,
        },
        onEvent,
    });

    if (streamError) {
        throw new Error(streamError);
    }

    return latestContent.trim();
}

async function refineChapterWithContinuation({
    prompt,
    chapter,
    chapterIndex,
    chapterCount,
    lang,
    plotGoal,
    userInstructions,
    maxTokens,
    statusPrefix,
    assemblePreview,
}) {
    const prefixStatus = (message) => statusPrefix ? `${statusPrefix} ${message}` : message;
    const rawChapter = await generateRefinedChapter(prompt, {
        maxTokens,
        statusText: prefixStatus(`Refining chapter ${chapter.number} (${chapterIndex + 1}/${chapterCount})...`),
        onDelta: (chunk, event) => {
            const previewBody = sanitizeRefinedChapterBody(chunk, chapter.number, lang) || chunk;
            assemblePreview(previewBody, event);
        },
    });

    let refinedBody = sanitizeRefinedChapterBody(rawChapter, chapter.number, lang);
    let continuationAttempts = 0;

    while (
        !AppState.stopRequested &&
        continuationAttempts < MAX_CONTINUATION_ATTEMPTS &&
        looksPossiblyTruncated(refinedBody, chapter.body, maxTokens)
    ) {
        continuationAttempts += 1;
        const continuationPrompt = buildContinuationPrompt({
            lang,
            chapter,
            currentRefinedBody: refinedBody,
            plotGoal,
            userInstructions,
        });
        const continuationMaxTokens = maxTokensForContinuation(chapter.body, String(getTargetTokensParam(2000)));
        const continuation = await generateRefinedChapter(continuationPrompt, {
            maxTokens: continuationMaxTokens,
            statusText: prefixStatus(`Completing chapter ${chapter.number} ending (${continuationAttempts}/${MAX_CONTINUATION_ATTEMPTS})...`),
            onDelta: (chunk, event) => {
                const continuationBody = sanitizeRefinedChapterBody(chunk, chapter.number, lang) || chunk;
                const previewBody = appendWithOverlap(refinedBody, continuationBody);
                assemblePreview(previewBody, event);
            },
        });
        const continuationBody = sanitizeRefinedChapterBody(continuation, chapter.number, lang) || continuation;
        refinedBody = appendWithOverlap(refinedBody, continuationBody);
    }

    return refinedBody;
}

function setNovelRefineBusy(isBusy) {
    runtimeViewStateStore.setActivity({ isNovelRunning: isBusy });
}

function updateNovelOutput(text) {
    setNovelText(text);
}

function latestChapterNumber(chapters) {
    return chapters
        .map(chapter => chapter.number)
        .filter(Number.isFinite)
        .reduce((max, chapterNumber) => Math.max(max, chapterNumber), 0);
}

function parseOptionalChapterBound(value) {
    const text = normalizeDigits(value).trim();
    if (!text) return null;

    const parsed = parseInt(text, 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
}

export function clearNovelRefineChapterRange() {
    clearNovelRefineChapterRangeState();
}

function chapterMatchesRange(chapterNumber, chapterRange) {
    if (!chapterRange) return true;
    if (chapterRange.start !== null && chapterNumber < chapterRange.start) return false;
    if (chapterRange.end !== null && chapterNumber > chapterRange.end) return false;
    return true;
}

function formatChapterRange(chapterRange) {
    if (!chapterRange || (chapterRange.start === null && chapterRange.end === null)) {
        return '';
    }
    if (chapterRange.start !== null && chapterRange.end !== null) {
        return `chapters ${chapterRange.start}-${chapterRange.end}`;
    }
    if (chapterRange.start !== null) {
        return `chapter ${chapterRange.start} through the end`;
    }
    return `the beginning through chapter ${chapterRange.end}`;
}

async function saveRefinedNovelState({ finalText, lang, chapters, plotOutline }) {
    let filename = AppState.loadedNovelFilename;
    if (!filename) {
        filename = await invoke('get_next_novel_filename');
    }

    const totalChapters = getTotalChaptersParam(chapters.length || 1);
    const currentChapter = Math.min(latestChapterNumber(chapters) || chapters.length || 1, totalChapters);
    const metadata = {
        ...(AppState.loadedNovelMetadata || {}),
        title: AppState.loadedNovelMetadata?.title || 'Novel',
        language: lang,
        num_chapters: totalChapters,
        target_tokens: getTargetTokensParam(0),
        current_chapter: currentChapter,
        needs_memory_rebuild: true,
        plot_seed: getEditorSnapshot().seed || AppState.loadedNovelMetadata?.plot_seed || '',
        plot_outline: plotOutline,
        story_state: '',
        character_state: '',
        relationship_state: '',
        current_arc: '',
        current_arc_keywords: [],
        current_arc_start_chapter: 1,
        recent_chapters: [],
        closed_arcs: [],
        expression_cooldown: [],
        recent_scene_patterns: [],
        continuity_fallback_count: 0,
    };

    await invoke('save_novel_state', {
        filename,
        textContent: finalText,
        metadataJson: JSON.stringify(metadata, null, 2),
    });

    AppState.setLoadedNovel(filename, metadata);
    return filename;
}

export async function refineNovelTextInChapters({
    originalNovel,
    plotOutline,
    lang,
    totalChapters,
    userInstructions = '',
    chapterRange = null,
    statusPrefix = '',
    detectNextChapter = null,
    reloadNovelList = null,
    apiParams = null,
    autoInstructionsPerChapter = false,
    onChapterFinished = null,
}) {
    if (!plotOutline) {
        showToast('Plot is empty! Generate or load a plot before refining the novel.', 'warning');
        return null;
    }
    if (!originalNovel) {
        showToast('Novel is empty! Generate or load a novel before refining.', 'warning');
        return null;
    }

    const parsedNovel = splitNovelIntoChapterBlocks(originalNovel, lang);
    const normalizedNovel = normalizeNovelPartHeadings(
        parsedNovel.intro,
        parsedNovel.chapters,
        lang,
        totalChapters,
    );
    const { intro, chapters } = normalizedNovel;
    if (chapters.length === 0) {
        showToast('No novel text was found to refine.', 'warning');
        return null;
    }

    const plotChapters = splitPlotIntoChapters(plotOutline);
    const workingChapters = chapters.map(chapter => ({ ...chapter }));
    const targetIndexes = chapters
        .map((chapter, index) => ({ chapter, index }))
        .filter(({ chapter }) => chapterMatchesRange(chapter.number, chapterRange))
        .map(({ index }) => index);
    const rangeText = formatChapterRange(chapterRange);
    const prefixStatus = (message) => statusPrefix ? `${statusPrefix} ${message}` : message;

    if (targetIndexes.length === 0) {
        showToast(`No chapters found for ${rangeText || 'the selected range'}.`, 'warning');
        return null;
    }

    AppState.stopRequested = false;
    AppState.isNovelRefining = true;
    const preparingMessage = prefixStatus(
        `Preparing novel refine (${targetIndexes.length} of ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}${rangeText ? `, ${rangeText}` : ''})...`
    );
    setNovelStatus(preparingMessage, 'refining');

    try {
        for (let selectedIndex = 0; selectedIndex < targetIndexes.length; selectedIndex++) {
            if (AppState.stopRequested) break;

            const i = targetIndexes[selectedIndex];
            const chapter = chapters[i];
            const previousRefinedContext = takeTail(
                workingChapters
                    .slice(0, i)
                    .slice(-2)
                    .map(item => `${item.header}\n\n${item.body}`.trim())
                    .join('\n\n'),
                PREVIOUS_CONTEXT_CHARS,
            );
            const nextOriginalContext = chapters[i + 1]
                ? takeHead(`${chapters[i + 1].header}\n\n${chapters[i + 1].body}`.trim(), NEXT_CONTEXT_CHARS)
                : '';

            let chapterUserInstructions = userInstructions;
            if (autoInstructionsPerChapter && apiParams) {
                const autoMessage = prefixStatus(`Auto-analyzing chapter ${chapter.number} (${selectedIndex + 1}/${targetIndexes.length})...`);
                setNovelStatus(autoMessage, 'refining');
                try {
                    const prevText = i > 0 ? workingChapters[i - 1].body : "None.";
                    const nextText = i < chapters.length - 1 ? chapters[i + 1].body : "None.";
                    const autoInstr = await generateInstructionForChapter({
                        lang,
                        plotInfo: plotOutline,
                        prevChapterText: prevText,
                        currentChapterText: chapter.body,
                        nextChapterText: nextText,
                        apiParams,
                    });
                    chapterUserInstructions = autoInstr;
                    
                    runtimeViewStateStore.setRefineInstructions({ novel: chapterUserInstructions });
                } catch (e) {
                    console.error("[novel_refine] Failed to generate auto instructions:", e);
                }
                if (AppState.stopRequested) break;
            }

            const prompt = buildNovelRefinePrompt({
                lang,
                totalChapters,
                plotOutline,
                plotChapters,
                chapter,
                chapterIndex: selectedIndex,
                chapterCount: targetIndexes.length,
                previousRefinedContext,
                nextOriginalContext,
                userInstructions: chapterUserInstructions,
            });
            const maxTokens = maxTokensForChapter(chapter.body, String(getTargetTokensParam(2000)));

            const refinedBody = await refineChapterWithContinuation({
                prompt,
                chapter,
                chapterIndex: selectedIndex,
                chapterCount: targetIndexes.length,
                lang,
                plotGoal: plotChapters[chapter.number],
                userInstructions: chapterUserInstructions,
                maxTokens,
                statusPrefix,
                assemblePreview: (previewBody, event) => {
                    const visibleChapters = workingChapters.map((item, itemIndex) =>
                        itemIndex === i ? { ...chapter, body: previewBody } : item
                    );
                    updateNovelOutput(assembleNovel(intro, visibleChapters));
                },
            });

            if (AppState.stopRequested) break;

            if (!refinedBody) {
                throw new Error(`Refined chapter ${chapter.number} returned empty content.`);
            }

            workingChapters[i] = { ...chapter, body: refinedBody };
            onChapterFinished?.(chapter.number);
            const intermediateText = assembleNovel(intro, workingChapters);
            updateNovelOutput(intermediateText);
            // Save after each chapter
            await saveRefinedNovelState({
                finalText: intermediateText,
                lang,
                chapters: workingChapters,
                plotOutline,
            });
        }

        if (AppState.stopRequested) {
            const stoppedText = assembleNovel(intro, workingChapters);
            setNovelText(stoppedText);
            const stoppedMessage = prefixStatus('Stopped.');
            setNovelStatus(stoppedMessage, 'cancelled');
            if (detectNextChapter) detectNextChapter();
            return null;
        }

        const finalText = assembleNovel(intro, workingChapters);
        updateNovelOutput(finalText);
        const filename = await saveRefinedNovelState({
            finalText,
            lang,
            chapters: workingChapters,
            plotOutline,
        });

        await reloadNovelList?.();
        await detectNextChapter?.();
        const doneMessage = prefixStatus(`Done. Saved: ${filename}`);
        setNovelStatus(doneMessage, 'completed');
        if (!statusPrefix) {
            showToast(`Refined novel saved: ${filename}`, 'success');
        }
        return { fullText: finalText, filename };
    } catch (e) {
        console.error('[NovelRefine] Error:', e);
        setNovelText(assembleNovel(intro, workingChapters));
        if (detectNextChapter) detectNextChapter();
        const errorMessage = prefixStatus(`Error: ${e.message || e}`);
        setNovelStatus(errorMessage, 'error');
        showToast(`Novel refine failed: ${e.message || e}`, 'error');
        throw e;
    } finally {
        AppState.isNovelRefining = false;
    }
}

export async function refineNovelByChapters({ getLang, detectNextChapter, reloadNovelList }) {
    if (AppState.isWorkerRunning) {
        showToast('A novel generation job is already running.', 'warning');
        return;
    }
    if (AppState.isNovelRefining) return;

    setNovelRefineBusy(true);
    try {
        const editor = getEditorSnapshot();
        const startChapter = parseOptionalChapterBound(editor.novelRefineStartChapter);
        let endChapter = parseOptionalChapterBound(editor.novelRefineEndChapter);
        if (startChapter !== null && endChapter !== null && endChapter < startChapter) {
            endChapter = startChapter;
            setNovelRefineChapterRange({ end: startChapter });
        }
        const chapterRange = startChapter !== null || endChapter !== null
            ? { start: startChapter, end: endChapter }
            : null;

        const shouldAdvanceEndChapter = chapterRange !== null
            && chapterRange.start !== null
            && chapterRange.end !== null
            && chapterRange.start === chapterRange.end;

        await refineNovelTextInChapters({
            originalNovel: getEditorSnapshot().novel.trim(),
            plotOutline: getEditorSnapshot().plot.trim(),
            lang: getLang(),
            totalChapters: getTotalChaptersParam(1),
            userInstructions: runtimeViewStateStore.getSnapshot().refineInstructions.novel.trim(),
            chapterRange,
            detectNextChapter,
            reloadNovelList,
            onChapterFinished: (ch) => {
                const nextChapter = ch + 1;
                setNovelRefineChapterRange({ start: nextChapter });
                if (shouldAdvanceEndChapter) {
                    setNovelRefineChapterRange({ end: nextChapter });
                }
            }
        });
    } finally {
        setNovelRefineBusy(false);
    }
}
