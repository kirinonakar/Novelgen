import { runtimeSessionState } from '../services/runtimeSessionStateService.js';
import { Channel, invoke } from './tauri_api.js';
import { showToast } from './toast.js';
import {
    assertCompletePlotOutline,
    getChapterDesignInstruction,
    getPlotArcInstruction,
    splitPlotIntoChapters,
} from './text_utils.js';
import {
    getEditorSnapshot,
    setPlotStatus,
    setPlotText,
} from '../services/runtimeEditorStateService.js';
import { getTotalChaptersParam } from '../services/generationParamsService.js';
import { runtimeViewStateStore } from '../services/runtimeViewStateStore.js';

const MAX_PART_RETRY_COUNT = 3;

function getPlotRefineHeaders(lang) {
    return lang === 'Korean' ? {
        settings: [
            "1. 제목",
            "2. 핵심 주제의식과 소설 스타일",
            "3. 등장인물 이름, 설정",
            "4. 세계관 설정"
        ],
        chapter: "5. 각 장 제목과 내용, 핵심 포인트"
    } : lang === 'Japanese' ? {
        settings: [
            "1. タイトル",
            "2. 核心となるテーマと小説のスタイル",
            "3. 登場人物の名前・設定",
            "4. 世界観設定"
        ],
        chapter: "5. 各章のタイトルと内容、重要ポイント"
    } : {
        settings: [
            "1. Title",
            "2. Core Theme and Novel Style",
            "3. Character Names and Settings",
            "4. World Building/Setting"
        ],
        chapter: "5. Chapter Titles, Content, and Key Points"
    };
}

function splitPlotForChunkedRefine(plotText, lang) {
    const lines = plotText.replace(/\r\n/g, '\n').split('\n');
    const sectionFiveIndex = lines.findIndex(line => /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*5\s*[.)．。]\s*/i.test(line));

    if (sectionFiveIndex < 0) {
        return {
            settingsText: plotText.trim(),
            chapterHeader: getPlotRefineHeaders(lang).chapter,
            parts: []
        };
    }

    const settingsText = lines.slice(0, sectionFiveIndex).join('\n').trim();
    const chapterHeader = lines[sectionFiveIndex].trim() || getPlotRefineHeaders(lang).chapter;
    const chapterBody = lines.slice(sectionFiveIndex + 1).join('\n').trim();
    const partHeadingRegex = /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\[?\s*(?:(?:제\s*)?(?:\d+|[０-９]+|[일이삼사오육칠팔구십]+|[ivxlcdm]+)\s*부|第\s*[0-9０-９一二三四五六七八九十百]+\s*部|part\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))(?:\s*[\]=:：.)、\-–—].*|\s*(?:\*\*)?\s*)$/i;
    const bodyLines = chapterBody.split('\n');
    const partStartIndexes = bodyLines
        .map((line, index) => partHeadingRegex.test(line) ? index : -1)
        .filter(index => index >= 0);

    if (partStartIndexes.length === 0) {
        return {
            settingsText,
            chapterHeader,
            parts: splitChapterBodyIntoFallbackParts(chapterBody, lang)
        };
    }

    const parts = [];
    for (let i = 0; i < partStartIndexes.length; i++) {
        const start = i === 0 ? 0 : partStartIndexes[i];
        const end = partStartIndexes[i + 1] ?? bodyLines.length;
        const partText = bodyLines.slice(start, end).join('\n').trim();
        if (partText) parts.push(partText);
    }

    return {
        settingsText,
        chapterHeader,
        parts: parts.length > 1 ? parts : splitChapterBodyIntoFallbackParts(chapterBody, lang)
    };
}

function isPartHeadingLine(line) {
    return /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\[?\s*(?:(?:제\s*)?(?:\d+|[０-９]+|[일이삼사오육칠팔구십]+|[ivxlcdm]+)\s*부|第\s*[0-9０-９一二三四五六七八九十百]+\s*部|part\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))(?:\s*[\]=:：.)、\-–—].*|\s*(?:\*\*)?\s*)$/i.test(line);
}

function stripMarkdownHeadingNoise(line) {
    return line
        .trim()
        .replace(/^>\s*/, '')
        .replace(/^#{1,6}\s*/, '')
        .replace(/^\*\*+/, '')
        .replace(/\*\*+$/, '')
        .replace(/^[-*+]\s*/, '')
        .replace(/^\*+/, '')
        .replace(/\*+$/, '')
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .trim();
}

function parseSmallNumberToken(raw) {
    if (!raw) return null;
    const token = raw.trim().toLowerCase().replace(/[０-９]/g, ch =>
        String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    );
    if (/^\d+$/.test(token)) return parseInt(token, 10);

    const english = {
        one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
        seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    };
    if (english[token]) return english[token];

    const korean = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9, 십: 10 };
    if (korean[token]) return korean[token];

    const japanese = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    if (japanese[token]) return japanese[token];

    const roman = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
    return roman[token] || null;
}

function partOrdinalFromHeading(line) {
    const normalized = stripMarkdownHeadingNoise(line);
    const koreanMatch = normalized.match(/(?:제\s*)?(\d+|[０-９]+|[일이삼사오육칠팔구십]+|[ivxlcdm]+)\s*부/i);
    if (koreanMatch) return parseSmallNumberToken(koreanMatch[1]);
    const japaneseMatch = normalized.match(/第\s*([0-9０-９一二三四五六七八九十百]+)\s*部/i);
    if (japaneseMatch) return parseSmallNumberToken(japaneseMatch[1]);
    const englishMatch = normalized.match(/part\s*(\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)/i);
    if (englishMatch) return parseSmallNumberToken(englishMatch[1]);
    return null;
}

function isSectionFiveHeaderLine(line) {
    const normalized = stripMarkdownHeadingNoise(line);
    if (!/^\s*5\s*[.)．。]/i.test(normalized)) return false;

    return /각\s*장|장\s*제목|各章|chapter\s+titles?|chapters?\s*,?\s*content/i.test(normalized);
}

function isSectionFiveMetaLine(line) {
    const normalized = stripMarkdownHeadingNoise(line)
        .replace(/^[(*_~\s]+/, '')
        .replace(/[)*_~\s]+$/, '')
        .trim();

    return /section\s*5/i.test(normalized) && /intentionally|left\s+out|omitted|as\s+per\s+instructions/i.test(normalized);
}

function isChapterHeadingLine(line) {
    return /^\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:\*\*)?\[?\s*(?:Chapter\s*\d+|제?\s*\d+\s*장|第?\s*[0-9０-９一二三四五六七八九十百]+\s*章)(?:\s*(?:\]|\*\*))?(?=$|[^\S\n]|[:：.)、\]\-–—]|\*\*)/i.test(line);
}

function chapterNumberFromHeadingLine(line) {
    const normalized = stripMarkdownHeadingNoise(line);
    const match = normalized.match(/^(?:Chapter\s*(\d+)|제?\s*(\d+)\s*장|第?\s*([0-9０-９一二三四五六七八九十百]+)\s*章)/i);
    return parseSmallNumberToken(match?.[1] || match?.[2] || match?.[3]);
}

function firstPartHeading(text) {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => isPartHeadingLine(line)) || '';
}

function removeSectionFiveHeaderLines(text) {
    return text
        .split(/\r?\n/)
        .filter(line => !isSectionFiveHeaderLine(line))
        .join('\n')
        .trim();
}

export function sanitizeRefinedSettingsOutput(rawOutput, fallbackSettings = '') {
    const lines = String(rawOutput || '').replace(/\r\n/g, '\n').split('\n');
    const cutIndex = lines.findIndex(line =>
        isSectionFiveHeaderLine(line) || isPartHeadingLine(line) || isChapterHeadingLine(line)
    );
    const sanitized = (cutIndex >= 0 ? lines.slice(0, cutIndex) : lines)
        .filter(line => !isSectionFiveMetaLine(line))
        .join('\n')
        .trim();

    return sanitized || fallbackSettings.trim();
}

function scoreChapterCoverage(text, requiredChapters) {
    const chapters = new Set(chapterNumbersInText(text));
    const requiredHits = requiredChapters.size > 0
        ? [...requiredChapters].filter(chapter => chapters.has(chapter)).length
        : chapters.size;

    return {
        requiredHits,
        uniqueChapters: chapters.size,
        detailLength: text.trim().length,
    };
}

function isBetterCoverage(candidate, currentBest) {
    if (!currentBest) return true;
    if (candidate.score.requiredHits !== currentBest.score.requiredHits) {
        return candidate.score.requiredHits > currentBest.score.requiredHits;
    }
    if (candidate.score.uniqueChapters !== currentBest.score.uniqueChapters) {
        return candidate.score.uniqueChapters > currentBest.score.uniqueChapters;
    }
    return candidate.score.detailLength > currentBest.score.detailLength;
}

function hasSameCoverageScore(candidate, currentBest) {
    return Boolean(currentBest)
        && candidate.score.requiredHits === currentBest.score.requiredHits
        && candidate.score.uniqueChapters === currentBest.score.uniqueChapters
        && candidate.score.detailLength === currentBest.score.detailLength;
}

function requiredChapterSet(totalChapters) {
    const total = Math.max(0, parseInt(String(totalChapters || ''), 10) || 0);
    return new Set(Array.from({ length: total }, (_, index) => index + 1));
}

function bestSectionFiveBlock(lines, sectionIndexes, totalChapters = 0) {
    const requiredChapters = requiredChapterSet(totalChapters);
    let best = null;

    sectionIndexes.forEach((start, index) => {
        const end = sectionIndexes[index + 1] ?? lines.length;
        const segment = lines.slice(start, end).join('\n').trim();
        const candidate = {
            text: segment,
            score: scoreChapterCoverage(segment, requiredChapters),
        };

        if (isBetterCoverage(candidate, best) || hasSameCoverageScore(candidate, best)) {
            best = candidate;
        }
    });

    return best?.text || '';
}

function keepBestSectionFiveBlock(text, totalChapters = 0) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const sectionIndexes = [];
    lines.forEach((line, index) => {
        if (isSectionFiveHeaderLine(line)) sectionIndexes.push(index);
    });

    if (sectionIndexes.length <= 1) return text.trim();

    const firstSectionIndex = sectionIndexes[0];
    const settingsText = lines.slice(0, firstSectionIndex).join('\n').trim();
    const chapterSection = bestSectionFiveBlock(lines, sectionIndexes, totalChapters);
    return [settingsText, chapterSection].filter(Boolean).join('\n\n').trim();
}

function leadingLinesBeforeChapter(text) {
    const lines = String(text || '').split(/\r?\n/);
    const chapterIndex = lines.findIndex(line => isChapterHeadingLine(line));
    return chapterIndex > 0 ? lines.slice(0, chapterIndex) : [];
}

function preserveExistingPartPrefix(candidateText, existingText) {
    const candidatePrefix = leadingLinesBeforeChapter(candidateText);
    if (candidatePrefix.some(line => isPartHeadingLine(line))) return candidateText;

    const existingPrefix = leadingLinesBeforeChapter(existingText);
    if (!existingPrefix.some(line => isPartHeadingLine(line))) return candidateText;

    const candidateLines = candidateText.split(/\r?\n/);
    const firstChapterIndex = candidateLines.findIndex(line => isChapterHeadingLine(line));
    if (firstChapterIndex < 0) return candidateText;

    return [
        existingPrefix.join('\n').trim(),
        candidateLines.slice(firstChapterIndex).join('\n').trim(),
    ].filter(Boolean).join('\n').trim();
}

function chooseChapterBlock(chapterBlocks, chapterOrder, chapterNumber, candidateText) {
    const existing = chapterBlocks.get(chapterNumber);
    const candidate = {
        text: candidateText,
        score: chapterDetailScore(candidateText),
    };

    if (!existing) {
        chapterOrder.push(chapterNumber);
        chapterBlocks.set(chapterNumber, candidate);
        return;
    }

    if (candidate.score > existing.score) {
        chapterBlocks.set(chapterNumber, {
            ...candidate,
            text: preserveExistingPartPrefix(candidate.text, existing.text),
        });
    }
}

function dedupeRepeatedChapterBlocksPreservingParts(text) {
    const lines = String(text || '').split(/\r?\n/);
    const chapterOrder = [];
    const chapterBlocks = new Map();
    let pendingLines = [];
    let currentBlock = null;

    const flushCurrentBlock = () => {
        if (!currentBlock) return;
        chooseChapterBlock(
            chapterBlocks,
            chapterOrder,
            currentBlock.chapterNumber,
            currentBlock.lines.join('\n').trim()
        );
        currentBlock = null;
    };

    for (const line of lines) {
        if (isChapterHeadingLine(line)) {
            flushCurrentBlock();
            const chapterNumber = chapterNumberFromHeadingLine(line);
            if (Number.isFinite(chapterNumber)) {
                currentBlock = {
                    chapterNumber,
                    lines: [...pendingLines, line],
                };
                pendingLines = [];
            } else {
                pendingLines.push(line);
            }
            continue;
        }

        if (isPartHeadingLine(line) && currentBlock) {
            flushCurrentBlock();
            pendingLines = [line];
            continue;
        }

        if (currentBlock) {
            currentBlock.lines.push(line);
        } else {
            pendingLines.push(line);
        }
    }

    flushCurrentBlock();

    if (chapterOrder.length === 0) return text.trim();

    const dedupedChapters = chapterOrder
        .map(chapterNumber => chapterBlocks.get(chapterNumber)?.text || '')
        .filter(Boolean);
    const trailingText = pendingLines.join('\n').trim();

    return [
        ...dedupedChapters,
        trailingText,
    ].filter(Boolean).join('\n\n').trim();
}

function dedupeChapterSection(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const sectionIndex = lines.findIndex(line => isSectionFiveHeaderLine(line));
    if (sectionIndex < 0) {
        return dedupeRepeatedChapterBlocksPreservingParts(text);
    }

    const beforeSectionBody = lines.slice(0, sectionIndex + 1).join('\n').trim();
    const sectionBody = lines.slice(sectionIndex + 1).join('\n').trim();
    return [
        beforeSectionBody,
        dedupeRepeatedChapterBlocksPreservingParts(sectionBody),
    ].filter(Boolean).join('\n').trim();
}

export function normalizePlotOutlineOutput(text, { totalChapters = 0 } = {}) {
    const oneSection = keepBestSectionFiveBlock(text, totalChapters);
    return dedupeChapterSection(oneSection).trim();
}

function collapseDuplicateCurrentPartBlocks(text, originalPart, partNumber) {
    const lines = text.split(/\r?\n/);
    const currentHeadingIndexes = [];

    lines.forEach((line, index) => {
        if (isPartHeadingLine(line) && partOrdinalFromHeading(line) === partNumber) {
            currentHeadingIndexes.push(index);
        }
    });

    if (currentHeadingIndexes.length <= 1) return text;

    const requiredChapters = new Set(chapterNumbersInText(originalPart));
    let best = null;
    currentHeadingIndexes.forEach((start, index) => {
        const end = currentHeadingIndexes[index + 1] ?? lines.length;
        const segment = lines.slice(start, end).join('\n').trim();
        const candidate = {
            text: segment,
            score: scoreChapterCoverage(segment, requiredChapters),
        };
        if (isBetterCoverage(candidate, best)) {
            best = candidate;
        }
    });

    return best?.text || text;
}

function chapterDetailScore(text) {
    const normalized = text.toLowerCase();
    const fieldMatches = [
        '내용:', '핵심 포인트:', 'chapter_function', 'start_scene', 'end_state', 'end_hook',
        'must_include', 'must_not_include', 'not_this_chapter', 'chapter_keywords',
        'reveal_or_knowledge_step', 'external_threat', 'relationship_drama', 'mystery',
        'combat', 'comedy', 'content:', 'key points:', '重要ポイント', '内容:',
    ].filter(label => normalized.includes(label.toLowerCase())).length;

    return fieldMatches * 1000 + text.trim().length;
}

function dedupeRepeatedChapterBlocks(text) {
    return dedupeRepeatedChapterBlocksPreservingParts(text);
}

export function sanitizeRefinedPartOutput(rawOutput, originalPart, partNumber) {
    const originalHeading = firstPartHeading(originalPart);
    let text = removeSectionFiveHeaderLines(rawOutput);
    if (!text) return originalHeading || '';

    const lines = text.split(/\r?\n/);
    const headingIndexes = [];
    lines.forEach((line, index) => {
        if (isPartHeadingLine(line)) {
            headingIndexes.push({ index, ordinal: partOrdinalFromHeading(line) });
        }
    });

    const currentHeading = headingIndexes.find(item => item.ordinal === partNumber);
    if (currentHeading) {
        const nextDifferentHeading = headingIndexes.find(item =>
            item.index > currentHeading.index && item.ordinal !== partNumber
        );
        const end = nextDifferentHeading ? nextDifferentHeading.index : lines.length;
        text = lines.slice(currentHeading.index, end).join('\n').trim();
    } else if (headingIndexes.length > 0) {
        const firstDifferentHeading = headingIndexes.find(item => item.ordinal !== partNumber);
        if (firstDifferentHeading) {
            const beforeDifferent = lines.slice(0, firstDifferentHeading.index).join('\n').trim();
            text = beforeDifferent || originalPart.trim();
        }
    }

    if (originalHeading && !isPartHeadingLine(text.split(/\r?\n/)[0] || '')) {
        text = `${originalHeading}\n${text}`.trim();
    }

    text = collapseDuplicateCurrentPartBlocks(text, originalPart, partNumber);
    text = dedupeRepeatedChapterBlocks(text);

    if (originalHeading && !isPartHeadingLine(text.split(/\r?\n/)[0] || '')) {
        text = `${originalHeading}\n${text}`.trim();
    }

    return text.trim();
}

function chapterNumbersInText(text) {
    return Object.keys(splitPlotIntoChapters(text))
        .map(num => parseInt(num, 10))
        .filter(num => Number.isFinite(num))
        .sort((a, b) => a - b);
}

function missingRequiredChapters(refinedPart, originalPart) {
    const required = chapterNumbersInText(originalPart);
    if (required.length === 0) return [];

    const present = new Set(chapterNumbersInText(refinedPart));
    return required.filter(chapterNumber => !present.has(chapterNumber));
}

function buildPartRetryPrompt({
    basePrompt,
    previousOutput,
    missingChapters,
    originalCurrentPart,
    retryNumber,
    maxRetries,
}) {
    return `${basePrompt}

The previous attempt was incomplete and cannot be accepted.

[Previous Incomplete Output - Do Not Copy Blindly]
${previousOutput || '(empty output)'}

[Retry Requirement]
- Retry ${retryNumber} of ${maxRetries}.
- Output the full refined text for this same part again.
- The output MUST include chapter markers for these missing chapters: ${missingChapters.join(', ')}.
- Preserve every chapter marker that exists in the original current part.
- Do not summarize omitted chapters. Write their refined outline entries explicitly.

[Original Current Part - Required Chapter Coverage]
${originalCurrentPart}`;
}

function splitChapterBodyIntoFallbackParts(chapterBody, lang) {
    if (!chapterBody.trim()) return [];

    const chapterRegex = lang === 'Korean'
        ? /(?:^|\n)(?=\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*제?\s*\d+\s*장(?:\s|[:：.)、\-–—]|\*\*|$))/gi
        : lang === 'Japanese'
            ? /(?:^|\n)(?=\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*第?\s*[0-9０-９一二三四五六七八九十百]+\s*章(?:\s|[:：.)、\-–—]|\*\*|$))/gi
            : /(?:^|\n)(?=\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*chapter\s*\d+(?:\s|[:：.)、\-–—]|\*\*|$))/gi;

    const chunks = chapterBody
        .split(chapterRegex)
        .map(chunk => chunk.trim())
        .filter(Boolean);

    if (chunks.length <= 1) {
        return [chapterBody.trim()];
    }

    const chaptersPerPart = 8;
    const fallbackParts = [];
    for (let i = 0; i < chunks.length; i += chaptersPerPart) {
        fallbackParts.push(chunks.slice(i, i + chaptersPerPart).join('\n\n'));
    }
    return fallbackParts;
}

function formatRefineInstructions(refineInstructions) {
    return refineInstructions?.trim()
        ? `[User Refine Instructions]\n${refineInstructions.trim()}\n`
        : `[User Refine Instructions]\nNone.\n`;
}

function getRefinementGoals({ isPartRefine = false } = {}) {
    const outlineCompatibilityGoal = isPartRefine
        ? '- Keep all details compatible with the refined setting sections, earlier refined parts, and later original outline boundaries.'
        : '- Keep all details compatible with the chapter/part outline that will be refined later.';

    return `REFINEMENT GOALS:
- Preserve the core premise, genre identity, protagonist goal, and main character dynamics.
- Polish the title, theme, style, character settings, and worldbuilding to make them more distinctive, coherent, and commercially appealing.
- Strengthen emotional stakes, character motivations, interpersonal conflicts, story logic, foreshadowing, and long-form consistency.
- Make every added or revised detail support causality, tension, theme, or reader engagement.
${outlineCompatibilityGoal}
- Avoid radical changes to the premise, genre, protagonist goal, or ending direction unless required to fix a major flaw.
- Replace vague or generic descriptions with concrete story-driving details.
- Output only the refined content. No greetings, explanations, commentary, or meta-talk.`;
}

function buildSettingsRefinePrompt({ lang, totalChapters, plotText, refineInstructions }) {
    const headers = getPlotRefineHeaders(lang);
    return `You are a master story architect. Refine ONLY the setting/setup sections of this ${totalChapters}-chapter novel plot in ${lang}.

[Current Full Plot Outline]
${plotText}

${formatRefineInstructions(refineInstructions)}
OUTPUT RULES:
- Output ONLY sections 1-4.
- Do NOT write section 5 or any chapter/part content yet.
- Preserve the same language: ${lang}.
- Strictly maintain these section headings:
${headers.settings.join('\n')}

${getRefinementGoals()}`;
}

function buildPartRefinePrompt({
    lang,
    totalChapters,
    chapterHeader,
    refinedSettings,
    refinedPreviousParts,
    originalCurrentPart,
    originalFutureParts,
    currentPartHeading,
    partNumber,
    partCount,
    refineInstructions,
}) {
    const previousSection = refinedPreviousParts.length
        ? `\n[Already Refined Earlier Parts - Context Only, Do Not Rewrite]\n${refinedPreviousParts.join('\n\n')}\n`
        : '';
    const futureSection = originalFutureParts.length
        ? `\n[Original Later Parts - Boundary Context Only, Do Not Rewrite]\n${originalFutureParts.join('\n\n')}\n`
        : '';
    const arcInstruction = getPlotArcInstruction(lang, totalChapters);
    const chapterDesignInstruction = getChapterDesignInstruction(lang);

    return `You are a master story architect. Refine ONLY part ${partNumber} of ${partCount} of the chapter-content section for this ${totalChapters}-chapter novel plot in ${lang}.

[Refined Setting Sections]
${refinedSettings}
${previousSection}
[Original Current Part ${partNumber} - Rewrite This Part Only]
${originalCurrentPart}
${futureSection}

${formatRefineInstructions(refineInstructions)}
OUTPUT RULES:
- Output ONLY the refined text for part ${partNumber}.
- The first line must be the current part heading exactly once. Keep the part number as part ${partNumber}; you may polish only the title after the colon.
- Current part heading from the original outline: ${currentPartHeading || `(part ${partNumber})`}
- Do NOT output the section heading "${chapterHeader}".
- Do NOT rewrite the setting sections.
- Do NOT rewrite earlier parts.
- Do NOT write future parts.
- Do NOT output headings or summaries for any other part number, including "(계속)" continuations.
- Use later original parts only as boundary/context so part ${partNumber} ends in the right place before part ${partNumber + 1}. Stop before the next part begins.
- Preserve clear part markers and chapter markers exactly where appropriate.
- Preserve coverage for all chapters included in this part; do not skip, merge, repeat, or append a second copy of any chapter.
- Keep the outline compatible with the refined setting sections and earlier refined parts.
- Follow this section-5 structure rule: ${arcInstruction}
- Follow this chapter design rule: ${chapterDesignInstruction}
- No greetings, explanations, or meta-talk.

${getRefinementGoals({ isPartRefine: true })}

The final assembled plot will place your output under this section heading:
${chapterHeader}`;
}

async function generatePlotChunk(prompt, { statusText, onDelta, onStatus = null, emitFinalDelta = true }) {
    let latestContent = "";
    let streamError = null;
    const onEvent = new Channel();
    onEvent.onmessage = (event) => {
        if (runtimeSessionState.stopRequested && !event.is_finished && !event.error) return;
        latestContent = event.content || latestContent;
        // Refine callers sanitize the final chunk before showing it, so avoid flashing raw+sanitized output.
        if (emitFinalDelta || !event.is_finished || event.error) {
            onDelta(latestContent, event);
        }

        if (event.error) {
            let msg = event.error;
            if (msg.includes("401")) msg += "\n\n[Hint] Unauthorized. Check your API key.";
            else if (msg.includes("403")) msg += "\n\n[Hint] Forbidden. This might be a safety filter block or permission issue.";
            else if (msg.includes("429")) msg += "\n\n[Hint] Quota exceeded. Wait a moment or check your billing.";
            streamError = msg;
        }
    };

    setPlotStatus(statusText, 'refining');
    if (onStatus) onStatus(statusText);
    const { apiSettings, generationParams, promptEditor } = runtimeViewStateStore.getSnapshot();
    await invoke("generate_plot", {
        params: {
            api_base: apiSettings.apiBase,
            model_name: apiSettings.modelName,
            api_key: apiSettings.apiKey || "lm-studio",
            system_prompt: promptEditor.systemPrompt,
            prompt,
            temperature: parseFloat(generationParams.temperature),
            top_p: parseFloat(generationParams.topP),
            repetition_penalty: parseFloat(generationParams.repetitionPenalty),
            max_tokens: 8192
        },
        onEvent
    });
    if (streamError) {
        throw new Error(streamError);
    }

    return latestContent.trim();
}

export async function refinePlotInChunks({ getLang, updatePlotTokenCount }) {
    const lang = getLang();
    const totalChapters = getTotalChaptersParam(0);
    const originalPlot = normalizePlotOutlineOutput(getEditorSnapshot().plot.trim(), { totalChapters });
    const refineInstructions = runtimeViewStateStore.getSnapshot().refineInstructions.plot.trim();
    const { parts } = splitPlotForChunkedRefine(originalPlot, lang);

    runtimeSessionState.stopRequested = false;
    runtimeViewStateStore.setActivity({ isPlotRunning: true });
    const preparingMessage = `⏳ Preparing chunked refine (${parts.length} part${parts.length === 1 ? '' : 's'} detected)...`;
    setPlotStatus(preparingMessage, 'refining');
    setPlotText("");
    updatePlotTokenCount();

    try {
        const refinedPlot = await refinePlotTextInChunks({
            originalPlot,
            lang,
            totalChapters,
            refineInstructions,
            onStatus: (msg) => {
                setPlotStatus(msg, 'refining');
            },
            onUpdate: (text, event) => {
                setPlotText(normalizePlotOutlineOutput(text, { totalChapters }));
                updatePlotTokenCount();
            }
        });
        if (!runtimeSessionState.stopRequested) {
            setPlotText(refinedPlot);
            updatePlotTokenCount();
            setPlotStatus("✅ Done", 'completed');
        } else {
            setPlotText(originalPlot);
            updatePlotTokenCount();
        }
    } catch (e) {
        setPlotText(originalPlot);
        updatePlotTokenCount();
        setPlotStatus("❌ Error", 'error');
        showToast(`Plot refine failed: ${e.message || e}`, 'error');
    } finally {
        runtimeViewStateStore.setActivity({ isPlotRunning: false });
    }
}

export async function refinePlotTextInChunks({
    originalPlot,
    lang,
    totalChapters,
    refineInstructions,
    onUpdate,
    onStatus,
    onPartFinished = null,
    startPart = 1,
}) {
    const sourcePlot = normalizePlotOutlineOutput(originalPlot, { totalChapters });
    const { settingsText, chapterHeader, parts } = splitPlotForChunkedRefine(sourcePlot, lang);
    const updatePlotOutput = (text, event) => {
        onUpdate?.(text, event);
    };

    assertCompletePlotOutline(sourcePlot, totalChapters, 'Source plot outline');
    onStatus?.(`⏳ Preparing chunked refine (${parts.length} part${parts.length === 1 ? '' : 's'} detected)...`);

    const settingsPrompt = buildSettingsRefinePrompt({ lang, totalChapters, plotText: sourcePlot, refineInstructions });
    const rawRefinedSettings = await generatePlotChunk(settingsPrompt, {
        statusText: "⏳ Refining settings...",
        onStatus,
        emitFinalDelta: false,
        onDelta: (chunk, event) => updatePlotOutput(chunk, event)
    });
    const refinedSettings = parts.length > 0
        ? sanitizeRefinedSettingsOutput(rawRefinedSettings, settingsText)
        : rawRefinedSettings.trim();
    if (runtimeSessionState.stopRequested) {
        onStatus?.("🛑 Stopped");
        return refinedSettings;
    }

    if (parts.length === 0) {
        assertCompletePlotOutline(refinedSettings, totalChapters, 'Refined plot outline');
        updatePlotOutput(refinedSettings, { is_finished: true });
        onStatus?.("✅ Done");
        return refinedSettings;
    }

    const refinedParts = [];
    let assembled = normalizePlotOutlineOutput(`${refinedSettings}\n\n${chapterHeader}`, { totalChapters });
    updatePlotOutput(assembled, { is_finished: false });

    for (let i = (startPart - 1); i < parts.length; i++) {
        const stableAssembled = assembled;
        const currentPartHeading = firstPartHeading(parts[i]);
        const expectedPartNumber = partOrdinalFromHeading(currentPartHeading) || i + 1;
        const partPrompt = buildPartRefinePrompt({
            lang,
            totalChapters,
            chapterHeader,
            refinedSettings,
            refinedPreviousParts: refinedParts,
            originalCurrentPart: parts[i],
            originalFutureParts: parts.slice(i + 1),
            currentPartHeading,
            partNumber: expectedPartNumber,
            partCount: parts.length,
            refineInstructions,
        });
        let retryCount = 0;
        let rawPart = "";
        let part = "";
        let missingChapters = [];

        while (true) {
            const prompt = retryCount === 0
                ? partPrompt
                : buildPartRetryPrompt({
                    basePrompt: partPrompt,
                    previousOutput: rawPart,
                    missingChapters,
                    originalCurrentPart: parts[i],
                    retryNumber: retryCount,
                    maxRetries: MAX_PART_RETRY_COUNT,
                });
            const retryLabel = retryCount === 0 ? '' : ` (retry ${retryCount}/${MAX_PART_RETRY_COUNT})`;

            rawPart = await generatePlotChunk(prompt, {
                statusText: `⏳ Refining plot part ${i + 1}/${parts.length}${retryLabel}...`,
                onStatus,
                emitFinalDelta: false,
                onDelta: (chunk, event) => updatePlotOutput(`${assembled}\n\n${chunk}`, event)
            });
            if (runtimeSessionState.stopRequested) {
                onStatus?.("🛑 Stopped");
                return stableAssembled;
            }

            part = sanitizeRefinedPartOutput(rawPart, parts[i], expectedPartNumber);
            missingChapters = missingRequiredChapters(part, parts[i]);
            if (missingChapters.length === 0) break;

            if (retryCount >= MAX_PART_RETRY_COUNT) {
                throw new Error(`Refined plot part ${i + 1}/${parts.length} is incomplete after ${MAX_PART_RETRY_COUNT} retries. Missing chapter markers: ${missingChapters.join(', ')}`);
            }

            retryCount += 1;
            onStatus?.(`⏳ Plot part ${i + 1}/${parts.length} missed chapter markers ${missingChapters.join(', ')}. Retrying ${retryCount}/${MAX_PART_RETRY_COUNT}...`);
        }

        refinedParts.push(part);
        onPartFinished?.(i + 1);
        assembled = normalizePlotOutlineOutput(`${refinedSettings}\n\n${chapterHeader}\n${refinedParts.join('\n\n')}`, { totalChapters });
        updatePlotOutput(assembled, { is_finished: true });
    }

    assembled = normalizePlotOutlineOutput(assembled, { totalChapters });
    assertCompletePlotOutline(assembled, totalChapters, 'Refined plot outline');
    updatePlotOutput(assembled, { is_finished: true });
    onStatus?.("✅ Done");
    return assembled;
}
