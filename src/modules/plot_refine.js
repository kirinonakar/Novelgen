import { AppState } from './app_state.js';
import { els } from './dom_refs.js';
import { schedulePreviewRender } from './preview.js';
import { Channel, invoke } from './tauri_api.js';
import { getPlotArcInstruction, splitPlotIntoChapters } from './text_utils.js';

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
    const partHeadingRegex = /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\[?\s*(?:(?:제\s*)?(?:\d+|[０-９]+|[일이삼사오육칠팔구십]+|[ivxlcdm]+)\s*부|第\s*[0-9０-９一二三四五六七八九十百]+\s*部|part\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))(?:\s*[\]:：.)、\-–—].*|\s*(?:\*\*)?\s*)$/i;
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
    return /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\[?\s*(?:(?:제\s*)?(?:\d+|[０-９]+|[일이삼사오육칠팔구십]+|[ivxlcdm]+)\s*부|第\s*[0-9０-９一二三四五六七八九十百]+\s*部|part\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))(?:\s*[\]:：.)、\-–—].*|\s*(?:\*\*)?\s*)$/i.test(line);
}

function stripMarkdownHeadingNoise(line) {
    return line
        .trim()
        .replace(/^#{1,6}\s*/, '')
        .replace(/^[-*]\s*/, '')
        .replace(/^\*\*/, '')
        .replace(/\*\*$/, '')
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

function firstPartHeading(text) {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => isPartHeadingLine(line)) || '';
}

function removeSectionFiveHeaderLines(text) {
    return text
        .split(/\r?\n/)
        .filter(line => !/^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*5\s*[.)．。]\s*(?:각\s*장|各章|chapter\s+titles)/i.test(line))
        .join('\n')
        .trim();
}

function sanitizeRefinedPartOutput(rawOutput, originalPart, partNumber) {
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
    const arcInstruction = getPlotArcInstruction(lang);

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
- The first line must be the current part heading. Keep the part number as part ${partNumber}; you may polish only the title after the colon.
- Current part heading from the original outline: ${currentPartHeading || `(part ${partNumber})`}
- Do NOT output the section heading "${chapterHeader}".
- Do NOT rewrite the setting sections.
- Do NOT rewrite earlier parts.
- Do NOT write future parts.
- Do NOT output headings or summaries for any other part number, including "(계속)" continuations.
- Use later original parts only as boundary/context so part ${partNumber} ends in the right place before part ${partNumber + 1}. Stop before the next part begins.
- Preserve clear part markers and chapter markers exactly where appropriate.
- Preserve coverage for all chapters included in this part; do not skip or merge chapters.
- Keep the outline compatible with the refined setting sections and earlier refined parts.
- Follow this section-5 structure rule: ${arcInstruction}
- No greetings, explanations, or meta-talk.

${getRefinementGoals({ isPartRefine: true })}

The final assembled plot will place your output under this section heading:
${chapterHeader}`;
}

async function generatePlotChunk(prompt, { statusText, onDelta, onStatus = null }) {
    let latestContent = "";
    let streamError = null;
    const onEvent = new Channel();
    onEvent.onmessage = (event) => {
        if (AppState.stopRequested && !event.is_finished && !event.error) return;
        latestContent = event.content || latestContent;
        onDelta(latestContent, event);

        if (event.error) {
            let msg = event.error;
            if (msg.includes("401")) msg += "\n\n[Hint] Unauthorized. Check your API key.";
            else if (msg.includes("403")) msg += "\n\n[Hint] Forbidden. This might be a safety filter block or permission issue.";
            else if (msg.includes("429")) msg += "\n\n[Hint] Quota exceeded. Wait a moment or check your billing.";
            streamError = msg;
        }
    };

    els.plotStatusMsg.innerText = statusText;
    if (onStatus) onStatus(statusText);
    await invoke("generate_plot", {
        params: {
            api_base: els.apiBase.value,
            model_name: els.modelName.value,
            api_key: els.apiKeyBox.value || "lm-studio",
            system_prompt: els.promptBox.value,
            prompt,
            temperature: parseFloat(els.temp.value),
            top_p: parseFloat(els.topP.value),
            repetition_penalty: parseFloat(els.repetitionPenalty.value),
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
    const originalPlot = els.plotContent.value.trim();
    const lang = getLang();
    const totalChapters = parseInt(els.numChap.value) || 0;
    const refineInstructions = els.plotRefineInstructions?.value?.trim() || '';
    const { parts } = splitPlotForChunkedRefine(originalPlot, lang);

    AppState.stopRequested = false;
    els.btnGenPlot.disabled = true;
    els.btnRefinePlot.disabled = true;
    els.plotStatusMsg.innerText = `⏳ Preparing chunked refine (${parts.length} part${parts.length === 1 ? '' : 's'} detected)...`;
    els.plotContent.value = "";
    updatePlotTokenCount();

    try {
        const refinedPlot = await refinePlotTextInChunks({
            originalPlot,
            lang,
            totalChapters,
            refineInstructions,
            onStatus: (msg) => { els.plotStatusMsg.innerText = msg; },
            onUpdate: (text, event) => {
                els.plotContent.value = text;
                updatePlotTokenCount();
                schedulePreviewRender(els.plotContent.id, {
                    source: 'stream',
                    force: event?.is_finished || Boolean(event?.error),
                    immediate: event?.is_finished || Boolean(event?.error)
                });
            }
        });
        if (!AppState.stopRequested) {
            els.plotContent.value = refinedPlot;
            updatePlotTokenCount();
            schedulePreviewRender(els.plotContent.id, { source: 'stream', force: true, immediate: true });
            els.plotStatusMsg.innerText = "✅ Done";
        }
    } catch (e) {
        els.plotContent.value += `\n\n[Error]: ${e.message || e}`;
        updatePlotTokenCount();
        schedulePreviewRender(els.plotContent.id, { source: 'stream', force: true, immediate: true });
        els.plotStatusMsg.innerText = "❌ Error";
    } finally {
        els.btnGenPlot.disabled = false;
        els.btnRefinePlot.disabled = false;
    }
}

export async function refinePlotTextInChunks({
    originalPlot,
    lang,
    totalChapters,
    refineInstructions,
    onUpdate,
    onStatus,
}) {
    const { chapterHeader, parts } = splitPlotForChunkedRefine(originalPlot, lang);
    const updatePlotOutput = (text, event) => {
        onUpdate?.(text, event);
    };

    onStatus?.(`⏳ Preparing chunked refine (${parts.length} part${parts.length === 1 ? '' : 's'} detected)...`);

    const settingsPrompt = buildSettingsRefinePrompt({ lang, totalChapters, plotText: originalPlot, refineInstructions });
    const refinedSettings = await generatePlotChunk(settingsPrompt, {
        statusText: "⏳ Refining settings...",
        onStatus,
        onDelta: (chunk, event) => updatePlotOutput(chunk, event)
    });
    if (AppState.stopRequested) {
        onStatus?.("🛑 Stopped");
        return refinedSettings;
    }

    if (parts.length === 0) {
        updatePlotOutput(refinedSettings, { is_finished: true });
        onStatus?.("✅ Done");
        return refinedSettings;
    }

    const refinedParts = [];
    let assembled = `${refinedSettings}\n\n${chapterHeader}`;
    updatePlotOutput(assembled, { is_finished: false });

    for (let i = 0; i < parts.length; i++) {
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
                onDelta: (chunk, event) => updatePlotOutput(`${assembled}\n\n${chunk}`, event)
            });
            if (AppState.stopRequested) {
                onStatus?.("🛑 Stopped");
                return assembled;
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
        assembled = `${refinedSettings}\n\n${chapterHeader}\n${refinedParts.join('\n\n')}`;
        updatePlotOutput(assembled, { is_finished: false });
    }

    updatePlotOutput(assembled, { is_finished: true });
    onStatus?.("✅ Done");
    return assembled;
}
