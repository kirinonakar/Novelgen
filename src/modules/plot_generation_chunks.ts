import { generatePlotStream, type GeneratePlotParams, type PlotStreamEvent } from '../services/plotGenerationService.js';
import {
    buildPlotPartPrompt,
    buildPlotSettingsPrompt,
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
    const chapterOneMatch = text.match(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:Chapter\s*1|제?\s*1\s*장|第?\s*1\s*章)(?=$|[^\S\n]|[:：.)、\]\-–—]|\*\*)/i);
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

function sanitizeGeneratedPartOutput(rawText: string, part, lang: Language) {
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
    return truncateAtLaterPartHeading(text, part.part, lang);
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

function buildPlotPartRetryPrompt({
    basePrompt,
    previousOutput,
    missingChapters,
    extraChapters,
    retryNumber,
    maxRetries,
}: {
    basePrompt: string;
    previousOutput: string;
    missingChapters: number[];
    extraChapters: number[];
    retryNumber: number;
    maxRetries: number;
}) {
    const issues = [
        missingChapters.length > 0 ? `missing required chapter markers/content: ${missingChapters.join(', ')}` : '',
        extraChapters.length > 0 ? `included chapters outside the assigned range: ${extraChapters.join(', ')}` : '',
    ].filter(Boolean).join('; ');

    return `${basePrompt}

Retry ${retryNumber}/${maxRetries}.
The previous output was invalid because it ${issues}.
Regenerate the entire current part block only. Keep every assigned chapter marker exactly once, in order, and include no outside chapters.

Previous invalid output:
${previousOutput}`;
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

        while (true) {
            const prompt = retryCount === 0
                ? basePrompt
                : buildPlotPartRetryPrompt({
                    basePrompt,
                    previousOutput: rawPart,
                    missingChapters,
                    extraChapters,
                    retryNumber: retryCount,
                    maxRetries: MAX_PLOT_PART_GENERATION_RETRIES,
                });
            const retryLabel = retryCount === 0 ? '' : ` (retry ${retryCount}/${MAX_PLOT_PART_GENERATION_RETRIES})`;

            rawPart = await generatePlotChunkStream(prompt, apiParams, {
                maxTokens: 8192,
                statusText: `⏳ Generating plot part ${i + 1}/${plan.length}${retryLabel}...`,
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
                const missingText = missingChapters.length > 0
                    ? ` Missing chapter markers/content: ${missingChapters.join(', ')}.`
                    : '';
                const extraText = extraChapters.length > 0
                    ? ` Outside-range chapter markers: ${extraChapters.join(', ')}.`
                    : '';
                throw new Error(`Generated plot part ${i + 1}/${plan.length} is incomplete after ${MAX_PLOT_PART_GENERATION_RETRIES} retries.${missingText}${extraText}`);
            }

            retryCount += 1;
            onStatus?.(`⏳ Plot part ${i + 1}/${plan.length} had coverage issues. Retrying ${retryCount}/${MAX_PLOT_PART_GENERATION_RETRIES}...`);
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
