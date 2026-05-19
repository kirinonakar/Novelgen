import { generatePlotStream, type GeneratePlotParams, type PlotStreamEvent } from '../services/plotGenerationService.js';
import {
    buildPlotPartPrompt,
    buildPlotSettingsPrompt,
    formatPlotChapterMarker,
    formatPlotPartHeading,
    getPlotChapterSectionHeader,
} from '../services/plotPromptService.js';
import { runtimeSessionState } from '../services/runtimeSessionStateService.js';
import type { Language } from '../types/app.js';
import { normalizePlotOutlineOutput } from './plot_refine.js';
import {
    assertCompletePlotOutline,
    getPartPlan,
    splitPlotIntoChapters,
} from './text_utils.js';

const MAX_PLOT_PART_GENERATION_RETRIES = 2;

type PlotGenerationApiParams = Omit<GeneratePlotParams, 'prompt' | 'maxTokens'>;

interface GeneratePlotInChunksParams {
    seed: string;
    lang: Language;
    totalChapters: number;
    apiParams: PlotGenerationApiParams;
    onStatus?: (message: string) => void;
    onUpdate?: (text: string, event?: PlotStreamEvent) => void;
    onPartFinished?: (partNumber: number) => void;
}

interface PlotPartPlan {
    part: number;
    start: number;
    end: number;
}

function appendPlotStreamHint(message: string) {
    if (message.includes('401')) {
        return `${message}\n\n[Hint] Unauthorized. Check your API key.`;
    }
    if (message.includes('403')) {
        return `${message}\n\n[Hint] Forbidden. This might be a safety filter block or permission issue.`;
    }
    if (message.includes('429')) {
        return `${message}\n\n[Hint] Quota exceeded. Wait a moment or check your billing.`;
    }
    return message;
}

async function generatePlotChunkStream(
    prompt: string,
    apiParams: PlotGenerationApiParams,
    {
        maxTokens = 8192,
        statusText,
        onStatus,
        onDelta,
    }: {
        maxTokens?: number;
        statusText: string;
        onStatus?: (message: string) => void;
        onDelta?: (text: string, event: PlotStreamEvent) => void;
    }
) {
    let latestContent = '';
    let streamError = null;

    onStatus?.(statusText);
    await generatePlotStream({
        ...apiParams,
        prompt,
        maxTokens,
    }, (event) => {
        if (runtimeSessionState.stopRequested && !event.is_finished && !event.error) return;

        latestContent = event.content || latestContent;
        onDelta?.(latestContent, event);

        if (event.error) {
            streamError = appendPlotStreamHint(event.error);
        }
    });

    if (streamError) {
        throw new Error(streamError);
    }

    return latestContent.trim();
}

function stripCodeFence(text: string) {
    return String(text || '')
        .replace(/^\s*```[A-Za-z0-9_-]*\s*/, '')
        .replace(/\s*```\s*$/g, '')
        .trim();
}

function sanitizeGeneratedSettingsOutput(rawText: string) {
    let text = stripCodeFence(rawText);
    const sectionFiveMatch = text.match(/(?:^|\n)\s*(?:#{1,6}\s*)?5[.)、]?\s+[^\n]*/i);
    const chapterOneMatch = text.match(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:Chapter\s*1|Ch\.?\s*1|제?\s*1\s*[장화]|第?\s*1\s*[章話])(?=$|[^\S\n]|[:：.)、\]\-–—]|\*\*)/i);
    const cutIndexes = [sectionFiveMatch?.index, chapterOneMatch?.index]
        .filter(index => typeof index === 'number' && index >= 0) as number[];
    if (cutIndexes.length > 0) {
        text = text.slice(0, Math.min(...cutIndexes)).trim();
    }
    return text;
}

function parseLocalizedInteger(raw: string) {
    const token = String(raw || '').replace(/[０-９]/g, ch =>
        String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    );
    return Number.parseInt(token, 10);
}

function expectedPartHeadingPattern(partNumber: number, lang: Language) {
    const boundary = String.raw`(?=$|[^\S\n]|[:：.)、\]\-–—]|\*\*)`;
    if (lang === 'Korean') {
        return new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:제\\s*)?${partNumber}\\s*부${boundary}`, 'i');
    }
    if (lang === 'Japanese') {
        return new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?第?\\s*${partNumber}\\s*部${boundary}`, 'i');
    }
    return new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?Part\\s*${partNumber}${boundary}`, 'i');
}

function anyPartHeadingPattern(lang: Language) {
    const boundary = String.raw`(?=$|[^\S\n]|[:：.)、\]\-–—]|\*\*)`;
    if (lang === 'Korean') {
        return new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:제\\s*)?([0-9０-９]+)\\s*부${boundary}`, 'gi');
    }
    if (lang === 'Japanese') {
        return new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?第?\\s*([0-9０-９]+)\\s*部${boundary}`, 'gi');
    }
    return new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?Part\\s*([0-9０-９]+)${boundary}`, 'gi');
}

function removeTopSectionFiveHeading(text: string) {
    return text.replace(/^\s*(?:#{1,6}\s*)?5[.)、]?\s+[^\n]*(?:\n|$)/i, '').trim();
}

function truncateAtLaterPartHeading(text: string, currentPartNumber: number, lang: Language) {
    const matches = [...text.matchAll(anyPartHeadingPattern(lang))];
    const laterHeading = matches.find(match => {
        const number = parseLocalizedInteger(match[1]);
        return Number.isFinite(number) && number > currentPartNumber && (match.index || 0) > 0;
    });
    return laterHeading ? text.slice(0, laterHeading.index).trim() : text.trim();
}

function chapterBlockPattern() {
    const markdownPrefix = String.raw`\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:\*\*)?\[?\s*`;
    const closingMarkdown = String.raw`(?:\s*(?:\]|\*\*))?`;
    const headingBoundary = String.raw`(?=$|[^\S\n]|[:：.)、\]\-–—]|\*\*)`;
    return new RegExp(
        String.raw`(?:^|\n)(${markdownPrefix}(?:Chapter\s*([0-9０-９]+)|Ch\.?\s*([0-9０-９]+)|제?\s*([0-9０-９]+)\s*[장화]|第?\s*([0-9０-９]+)\s*[章話])${closingMarkdown}${headingBoundary})`,
        'gi'
    );
}

function chapterBlocksInText(text: string) {
    const normalized = String(text || '');
    const matches = [...normalized.matchAll(chapterBlockPattern())];
    return matches
        .map((match, index) => {
            const headingPrefixLength = match[0].startsWith('\n') ? 1 : 0;
            const start = (match.index || 0) + headingPrefixLength;
            const bodyStart = (match.index || 0) + match[0].length;
            const nextMatchIndex = index + 1 < matches.length ? matches[index + 1].index : normalized.length;
            const end = typeof nextMatchIndex === 'number' ? nextMatchIndex : normalized.length;
            const number = parseLocalizedInteger(match[2] || match[3] || match[4] || match[5]);
            const blockText = normalized.slice(start, end).trim();
            const bodyText = normalized.slice(bodyStart, end).trim();
            return { number, text: blockText, score: bodyText.replace(/\s+/g, '').length };
        })
        .filter(block => Number.isFinite(block.number) && block.number > 0 && block.text);
}

function extractAssignedChapterBlocks(text: string, startChapter: number, endChapter: number) {
    const bestByChapter = new Map<number, { number: number; text: string; score: number }>();
    for (const block of chapterBlocksInText(text)) {
        if (block.number < startChapter || block.number > endChapter) continue;

        const previous = bestByChapter.get(block.number);
        if (!previous || block.score >= previous.score) {
            bestByChapter.set(block.number, block);
        }
    }

    return Array.from({ length: endChapter - startChapter + 1 }, (_, index) => startChapter + index)
        .map(chapter => bestByChapter.get(chapter)?.text || '')
        .filter(Boolean)
        .join('\n\n')
        .trim();
}

function mergePartOutputs(texts: string[], part: PlotPartPlan, lang: Language) {
    const expectedHeading = formatPlotPartHeading(part.part, lang);
    const mergedChapters = extractAssignedChapterBlocks(texts.join('\n\n'), part.start, part.end);
    return mergedChapters ? `${expectedHeading}\n${mergedChapters}` : texts.find(text => text?.trim())?.trim() || expectedHeading;
}

function sanitizeGeneratedPartOutput(rawText: string, part: PlotPartPlan, lang: Language) {
    const expectedHeading = formatPlotPartHeading(part.part, lang);
    const expectedHeadingRegex = expectedPartHeadingPattern(part.part, lang);
    let text = removeTopSectionFiveHeading(stripCodeFence(rawText));
    const headingMatch = text.match(expectedHeadingRegex);
    if (headingMatch && typeof headingMatch.index === 'number' && headingMatch.index > 0) {
        text = text.slice(headingMatch.index).trim();
    }
    if (!expectedHeadingRegex.test(text)) {
        text = `${expectedHeading}\n${text}`;
    }
    text = truncateAtLaterPartHeading(text, part.part, lang);

    const assignedChapterBlocks = extractAssignedChapterBlocks(text, part.start, part.end);
    if (assignedChapterBlocks) {
        return `${expectedHeading}\n${assignedChapterBlocks}`;
    }

    return text;
}

function chapterNumbersInText(text: string) {
    return Object.keys(splitPlotIntoChapters(text || ''))
        .map(num => Number.parseInt(num, 10))
        .filter(num => Number.isFinite(num) && num > 0)
        .sort((a, b) => a - b);
}

function missingChaptersInRange(text: string, start: number, end: number) {
    const chapters = splitPlotIntoChapters(text || '');
    const missing = [];
    for (let chapter = start; chapter <= end; chapter += 1) {
        if (!chapters[chapter]?.trim()) {
            missing.push(chapter);
        }
    }
    return missing;
}

function extraChaptersOutsideRange(text: string, start: number, end: number) {
    return chapterNumbersInText(text).filter(chapter => chapter < start || chapter > end);
}

function formatChapterList(chapters: number[], lang: Language) {
    return chapters.map(chapter => formatPlotChapterMarker(chapter, lang)).join(', ');
}

function buildPlotPartRetryPrompt({
    basePrompt,
    previousOutput,
    missingChapters,
    extraChapters,
    part,
    lang,
    retryNumber,
    maxRetries,
}: {
    basePrompt: string;
    previousOutput: string;
    missingChapters: number[];
    extraChapters: number[];
    part: PlotPartPlan;
    lang: Language;
    retryNumber: number;
    maxRetries: number;
}) {
    const issues = [
        missingChapters.length > 0 ? `missing required chapter markers/content: ${formatChapterList(missingChapters, lang)}` : '',
        extraChapters.length > 0 ? `included chapters outside the assigned range: ${formatChapterList(extraChapters, lang)}` : '',
    ].filter(Boolean).join('; ');

    return `${basePrompt}

Retry ${retryNumber}/${maxRetries}.
The previous output was invalid because it ${issues}.
Assigned range for this part: ${formatPlotChapterMarker(part.start, lang)} - ${formatPlotChapterMarker(part.end, lang)}.
Regenerate the entire current part block only. Keep every assigned chapter marker exactly once, in order, and include no outside chapters.

Previous invalid output:
${previousOutput}`;
}

function buildMissingChapterRepairPrompt({
    basePrompt,
    partialOutput,
    missingChapters,
    part,
    lang,
}: {
    basePrompt: string;
    partialOutput: string;
    missingChapters: number[];
    part: PlotPartPlan;
    lang: Language;
}) {
    return `${basePrompt}

The current part is almost usable, but these assigned chapter entries are still missing: ${formatChapterList(missingChapters, lang)}.

Output ONLY the missing chapter entries listed above.
- Do not output the part heading.
- Do not output any existing chapter again.
- Do not output chapters outside ${formatPlotChapterMarker(part.start, lang)} - ${formatPlotChapterMarker(part.end, lang)}.
- Use the same chapter-detail structure as the current part.

Current accepted partial part:
${partialOutput}`;
}

export async function generatePlotTextInChunks({
    seed,
    lang,
    totalChapters,
    apiParams,
    onStatus,
    onUpdate,
    onPartFinished,
}: GeneratePlotInChunksParams) {
    const plan = getPartPlan(totalChapters);
    const chapterHeader = getPlotChapterSectionHeader(lang);
    const updateOutput = (text: string, event?: PlotStreamEvent) => {
        onUpdate?.(normalizePlotOutlineOutput(text, { totalChapters }), event);
    };

    const settingsPrompt = buildPlotSettingsPrompt({ seed, language: lang, totalChapters });
    const rawSettings = await generatePlotChunkStream(settingsPrompt, apiParams, {
        maxTokens: 4096,
        statusText: `⏳ Generating plot settings...`,
        onStatus,
        onDelta: (chunk, event) => updateOutput(chunk, event),
    });
    const settingsText = sanitizeGeneratedSettingsOutput(rawSettings);
    let assembled = normalizePlotOutlineOutput(`${settingsText}\n\n${chapterHeader}`, { totalChapters });
    updateOutput(assembled, { is_finished: true, content: assembled });

    if (runtimeSessionState.stopRequested) {
        onStatus?.('🛑 Stopped');
        return assembled;
    }

    const generatedParts = [];
    for (let i = 0; i < plan.length; i += 1) {
        const part = plan[i];
        const stableAssembled = assembled;
        const basePrompt = buildPlotPartPrompt({
            seed,
            language: lang,
            totalChapters,
            settingsText,
            previousPartsText: generatedParts.join('\n\n'),
            partIndex: i,
        });

        let retryCount = 0;
        let rawPart = '';
        let sanitizedPart = '';
        let missingChapters = [];
        let extraChapters = [];
        const partRangeText = `${formatPlotChapterMarker(part.start, lang)}-${formatPlotChapterMarker(part.end, lang)}`;

        while (true) {
            const prompt = retryCount === 0
                ? basePrompt
                : buildPlotPartRetryPrompt({
                    basePrompt,
                    previousOutput: rawPart,
                    missingChapters,
                    extraChapters,
                    part,
                    lang,
                    retryNumber: retryCount,
                    maxRetries: MAX_PLOT_PART_GENERATION_RETRIES,
                });
            const retryLabel = retryCount === 0 ? '' : ` (retry ${retryCount}/${MAX_PLOT_PART_GENERATION_RETRIES})`;

            rawPart = await generatePlotChunkStream(prompt, apiParams, {
                maxTokens: 8192,
                statusText: `⏳ Generating plot part ${i + 1}/${plan.length} (${partRangeText})${retryLabel}...`,
                onStatus,
                onDelta: (chunk, event) => updateOutput(`${assembled}\n\n${chunk}`, event),
            });

            if (runtimeSessionState.stopRequested) {
                onStatus?.('🛑 Stopped');
                return stableAssembled;
            }

            sanitizedPart = sanitizeGeneratedPartOutput(rawPart, part, lang);
            missingChapters = missingChaptersInRange(sanitizedPart, part.start, part.end);
            extraChapters = extraChaptersOutsideRange(sanitizedPart, part.start, part.end);
            if (missingChapters.length === 0 && extraChapters.length === 0) break;

            if (retryCount >= MAX_PLOT_PART_GENERATION_RETRIES) {
                if (missingChapters.length > 0) {
                    const repairPrompt = buildMissingChapterRepairPrompt({
                        basePrompt,
                        partialOutput: sanitizedPart,
                        missingChapters,
                        part,
                        lang,
                    });
                    const rawRepair = await generatePlotChunkStream(repairPrompt, apiParams, {
                        maxTokens: 4096,
                        statusText: `⏳ Repairing plot part ${i + 1}/${plan.length} missing chapters (${formatChapterList(missingChapters, lang)})...`,
                        onStatus,
                        onDelta: (chunk, event) => updateOutput(`${assembled}\n\n${sanitizedPart}\n\n${chunk}`, event),
                    });
                    if (runtimeSessionState.stopRequested) {
                        onStatus?.('🛑 Stopped');
                        return stableAssembled;
                    }

                    const repairedPart = sanitizeGeneratedPartOutput(`${formatPlotPartHeading(part.part, lang)}\n${rawRepair}`, part, lang);
                    sanitizedPart = mergePartOutputs([sanitizedPart, repairedPart], part, lang);
                    missingChapters = missingChaptersInRange(sanitizedPart, part.start, part.end);
                    extraChapters = extraChaptersOutsideRange(sanitizedPart, part.start, part.end);
                    if (missingChapters.length === 0 && extraChapters.length === 0) break;
                }

                const missingText = missingChapters.length > 0
                    ? ` Missing chapter markers/content in assigned range ${partRangeText}: ${formatChapterList(missingChapters, lang)}.`
                    : '';
                const extraText = extraChapters.length > 0
                    ? ` Outside-range chapter markers: ${formatChapterList(extraChapters, lang)}.`
                    : '';
                throw new Error(`Generated plot part ${i + 1}/${plan.length} is incomplete after ${MAX_PLOT_PART_GENERATION_RETRIES} retries.${missingText}${extraText}`);
            }

            retryCount += 1;
            onStatus?.(`⏳ Plot part ${i + 1}/${plan.length} (${partRangeText}) had coverage issues. Retrying ${retryCount}/${MAX_PLOT_PART_GENERATION_RETRIES}...`);
        }

        generatedParts.push(sanitizedPart);
        onPartFinished?.(part.part);
        assembled = normalizePlotOutlineOutput(`${settingsText}\n\n${chapterHeader}\n${generatedParts.join('\n\n')}`, { totalChapters });
        updateOutput(assembled, { is_finished: true, content: assembled });
    }

    assembled = normalizePlotOutlineOutput(assembled, { totalChapters });
    assertCompletePlotOutline(assembled, totalChapters, 'Generated plot outline');
    updateOutput(assembled, { is_finished: true, content: assembled });
    onStatus?.('✅ Done');
    return assembled;
}
