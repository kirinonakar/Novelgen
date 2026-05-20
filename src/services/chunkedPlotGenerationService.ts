import {
    assertCompletePlotOutline,
    getChapterDesignInstruction,
    getPartPlan,
    getPlotArcInstruction,
    splitPlotIntoChapters,
} from '../modules/text_utils.js';
import {
    normalizePlotOutlineOutput,
    sanitizeRefinedPartOutput,
    sanitizeRefinedSettingsOutput,
} from '../modules/plot_refine.js';
import type { Language } from '../types/app.js';
import { generatePlotStream, type GeneratePlotParams, type PlotStreamEvent } from './plotGenerationService.js';
import { getPlotSectionHeaders } from './plotPromptService.js';

const CHUNKED_PLOT_MIN_CHAPTERS = 13;
const MAX_PART_RETRY_COUNT = 3;

type PlotGenerationApiParams = Omit<GeneratePlotParams, 'prompt' | 'maxTokens'>;

interface GeneratePlotOutlineInChunksOptions {
    seed: string;
    language: Language;
    totalChapters: number;
    apiParams: PlotGenerationApiParams;
    onStatus?: (message: string) => void;
    onUpdate?: (text: string, event?: PlotStreamEvent) => void;
    shouldStop?: () => boolean;
}

export function shouldGeneratePlotInChunks(totalChapters: number) {
    return (parseInt(String(totalChapters), 10) || 0) >= CHUNKED_PLOT_MIN_CHAPTERS;
}

function chapterSectionHeader(language: Language) {
    return getPlotSectionHeaders(language)[4];
}

function formatPartHeading(language: Language, partNumber: number) {
    if (language === 'Korean') return `제 ${partNumber}부`;
    if (language === 'Japanese') return `第 ${partNumber} 部`;
    return `Part ${partNumber}`;
}

function formatChapterHeading(language: Language, chapterNumber: number) {
    if (language === 'Korean') return `제 ${chapterNumber}장`;
    if (language === 'Japanese') return `第 ${chapterNumber} 章`;
    return `Chapter ${chapterNumber}`;
}

function syntheticOriginalPart(language: Language, partNumber: number, start: number, end: number) {
    const chapterMarkers = [];
    for (let chapter = start; chapter <= end; chapter += 1) {
        chapterMarkers.push(formatChapterHeading(language, chapter));
    }
    return [formatPartHeading(language, partNumber), ...chapterMarkers].join('\n');
}

function missingChaptersInRange(text: string, start: number, end: number) {
    const chapters = splitPlotIntoChapters(text || '');
    const missing = [];
    for (let chapter = start; chapter <= end; chapter += 1) {
        if (!chapters[chapter]?.trim()) missing.push(chapter);
    }
    return missing;
}

async function generatePlotChunk(
    prompt: string,
    {
        apiParams,
        statusText,
        onStatus,
        onDelta,
        shouldStop,
    }: {
        apiParams: PlotGenerationApiParams;
        statusText: string;
        onStatus?: (message: string) => void;
        onDelta?: (content: string, event?: PlotStreamEvent) => void;
        shouldStop?: () => boolean;
    },
) {
    let latestContent = '';
    let streamError = '';

    onStatus?.(statusText);
    await generatePlotStream({
        ...apiParams,
        prompt,
        maxTokens: 8192,
    }, (event) => {
        if (shouldStop?.() && !event.is_finished && !event.error) return;
        latestContent = event.content || latestContent;
        onDelta?.(latestContent, event);
        if (event.error) {
            streamError = event.error;
        }
    });

    if (streamError) {
        throw new Error(streamError);
    }

    return latestContent.trim();
}

function buildSettingsGenerationPrompt({
    seed,
    language,
    totalChapters,
}: {
    seed: string;
    language: Language;
    totalChapters: number;
}) {
    const headers = getPlotSectionHeaders(language);
    return `Based on the following seed, create ONLY the setup sections for a detailed ${totalChapters}-chapter novel plot in ${language}.

Seed:
${seed}

OUTPUT FORMAT:
${headers.slice(0, 4).join('\n')}

RULES:
- Output ONLY sections 1-4.
- Do NOT write section 5, story parts, or chapter entries yet.
- Make the setup detailed enough for a long chapter-by-chapter outline: title, theme/style, major cast, motivations, relationships, secrets, world rules, conflict engine, and endgame direction.
- Preserve the same language: ${language}.
- No greetings, explanations, or meta-commentary.`;
}

function buildPartGenerationPrompt({
    seed,
    language,
    totalChapters,
    settings,
    previousParts,
    partNumber,
    partCount,
    startChapter,
    endChapter,
}: {
    seed: string;
    language: Language;
    totalChapters: number;
    settings: string;
    previousParts: string[];
    partNumber: number;
    partCount: number;
    startChapter: number;
    endChapter: number;
}) {
    const previousSection = previousParts.length
        ? `\n[Already Generated Earlier Parts - Context Only, Do Not Rewrite]\n${previousParts.join('\n\n')}\n`
        : '';
    const laterPlan = getPartPlan(totalChapters)
        .filter(part => part.part > partNumber)
        .map(part => `${formatPartHeading(language, part.part)}: ${formatChapterHeading(language, part.start)}~${formatChapterHeading(language, part.end)}`)
        .join('\n') || 'None.';
    const partHeading = formatPartHeading(language, partNumber);
    const chapterMarkers = [];
    for (let chapter = startChapter; chapter <= endChapter; chapter += 1) {
        chapterMarkers.push(formatChapterHeading(language, chapter));
    }

    return `You are generating a long novel plot in chunks. Generate ONLY part ${partNumber} of ${partCount} for section 5 of this ${totalChapters}-chapter novel plot in ${language}.

[Seed]
${seed}

[Setup Sections 1-4]
${settings}
${previousSection}
[Later Part Plan - Boundary Only, Do Not Write These Parts]
${laterPlan}

CURRENT PART TO WRITE:
- First line must be exactly: ${partHeading}
- Cover only these chapter markers, in this exact order:
${chapterMarkers.join('\n')}

SECTION-5 STRUCTURE RULE:
${getPlotArcInstruction(language, totalChapters)}

CHAPTER DESIGN RULE:
${getChapterDesignInstruction(language)}

OUTPUT RULES:
- Output ONLY ${partHeading} and its assigned chapter entries.
- Do NOT output sections 1-4.
- Do NOT output the section heading "${chapterSectionHeader(language)}".
- Do NOT write earlier or later parts.
- Include every assigned chapter marker exactly once. Every chapter must have a concrete chapter title plus concrete "content" and "key points" style story detail.
- Safe chapter formats: Korean "제 N장: 장 제목" + "내용:" + "핵심 포인트:", Japanese "第 N 章: 章タイトル" + "内容:" + "重要ポイント:", English "Chapter N: Chapter Title" + "Content:" + "Key Points:".
- Keep causality compatible with the setup sections and any earlier generated parts.
- No greetings, explanations, summaries, or meta-commentary.`;
}

function buildPartRetryPrompt({
    basePrompt,
    previousOutput,
    missingChapters,
    language,
    startChapter,
    endChapter,
    retryNumber,
}: {
    basePrompt: string;
    previousOutput: string;
    missingChapters: number[];
    language: Language;
    startChapter: number;
    endChapter: number;
    retryNumber: number;
}) {
    const requiredMarkers = [];
    for (let chapter = startChapter; chapter <= endChapter; chapter += 1) {
        requiredMarkers.push(formatChapterHeading(language, chapter));
    }

    return `${basePrompt}

The previous attempt was incomplete and cannot be accepted.

[Previous Incomplete Output - Do Not Copy Blindly]
${previousOutput || '(empty output)'}

[Retry Requirement]
- Retry ${retryNumber} of ${MAX_PART_RETRY_COUNT}.
- Output this same part again from the beginning.
- The output MUST include these missing chapter markers: ${missingChapters.map(chapter => formatChapterHeading(language, chapter)).join(', ')}.
- Required full marker list for this part:
${requiredMarkers.join('\n')}
- Every chapter entry must include a chapter title and explicit content/detail labels, not just the marker.
- Do not summarize omitted chapters. Write their outline entries explicitly.`;
}

export async function generatePlotOutlineInChunks({
    seed,
    language,
    totalChapters,
    apiParams,
    onStatus,
    onUpdate,
    shouldStop,
}: GeneratePlotOutlineInChunksOptions) {
    const partPlan = getPartPlan(totalChapters);
    const sectionHeader = chapterSectionHeader(language);

    onStatus?.(`⏳ Preparing chunked plot generation (${partPlan.length} parts)...`);
    const settingsPrompt = buildSettingsGenerationPrompt({ seed, language, totalChapters });
    const rawSettings = await generatePlotChunk(settingsPrompt, {
        apiParams,
        statusText: '⏳ Generating settings (sections 1-4)...',
        onStatus,
        shouldStop,
        onDelta: (chunk, event) => onUpdate?.(chunk, event),
    });
    const settings = sanitizeRefinedSettingsOutput(rawSettings);
    if (shouldStop?.()) {
        onStatus?.('🛑 Stopped');
        return settings;
    }

    const generatedParts: string[] = [];
    let assembled = normalizePlotOutlineOutput(`${settings}\n\n${sectionHeader}`, { totalChapters });
    onUpdate?.(assembled, { content: assembled, is_finished: false });

    for (const plan of partPlan) {
        const stableAssembled = assembled;
        const basePrompt = buildPartGenerationPrompt({
            seed,
            language,
            totalChapters,
            settings,
            previousParts: generatedParts,
            partNumber: plan.part,
            partCount: partPlan.length,
            startChapter: plan.start,
            endChapter: plan.end,
        });
        const originalPart = syntheticOriginalPart(language, plan.part, plan.start, plan.end);
        let rawPart = '';
        let generatedPart = '';
        let missingChapters: number[] = [];
        let retryCount = 0;

        while (true) {
            const prompt = retryCount === 0
                ? basePrompt
                : buildPartRetryPrompt({
                    basePrompt,
                    previousOutput: rawPart,
                    missingChapters,
                    language,
                    startChapter: plan.start,
                    endChapter: plan.end,
                    retryNumber: retryCount,
                });
            const retryLabel = retryCount === 0 ? '' : ` (retry ${retryCount}/${MAX_PART_RETRY_COUNT})`;

            rawPart = await generatePlotChunk(prompt, {
                apiParams,
                statusText: `⏳ Generating plot part ${plan.part}/${partPlan.length}${retryLabel}...`,
                onStatus,
                shouldStop,
                onDelta: (chunk, event) => onUpdate?.(`${assembled}\n\n${chunk}`, event),
            });

            if (shouldStop?.()) {
                onStatus?.('🛑 Stopped');
                return stableAssembled;
            }

            generatedPart = sanitizeRefinedPartOutput(rawPart, originalPart, plan.part);
            missingChapters = missingChaptersInRange(generatedPart, plan.start, plan.end);
            if (missingChapters.length === 0) break;

            if (retryCount >= MAX_PART_RETRY_COUNT) {
                throw new Error(`Generated plot part ${plan.part}/${partPlan.length} is incomplete after ${MAX_PART_RETRY_COUNT} retries. Missing chapters: ${missingChapters.join(', ')}`);
            }

            retryCount += 1;
            onStatus?.(`⏳ Plot part ${plan.part}/${partPlan.length} missed chapters ${missingChapters.join(', ')}. Retrying ${retryCount}/${MAX_PART_RETRY_COUNT}...`);
        }

        generatedParts.push(generatedPart);
        assembled = normalizePlotOutlineOutput(`${settings}\n\n${sectionHeader}\n${generatedParts.join('\n\n')}`, { totalChapters });
        onUpdate?.(assembled, { content: assembled, is_finished: true });
    }

    assembled = normalizePlotOutlineOutput(assembled, { totalChapters });
    assertCompletePlotOutline(assembled, totalChapters, 'Generated plot outline');
    onUpdate?.(assembled, { content: assembled, is_finished: true });
    onStatus?.('✅ Done');
    return assembled;
}
