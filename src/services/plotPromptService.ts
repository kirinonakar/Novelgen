import { getChapterDesignInstruction, getPartPlan, getPlotArcInstruction } from '../modules/text_utils.js';
import type { Language, PlotPromptInput } from '../types/app.js';

export const CHUNKED_PLOT_GENERATION_MIN_CHAPTERS = 6;

interface PlotPartPromptInput extends PlotPromptInput {
    settingsText: string;
    previousPartsText?: string;
    partIndex: number;
}

export function shouldGeneratePlotInChunks(totalChapters: number): boolean {
    const total = Math.max(1, Number.parseInt(String(totalChapters), 10) || 1);
    return total >= CHUNKED_PLOT_GENERATION_MIN_CHAPTERS;
}

export function getPlotSectionHeaders(language: Language): string[] {
    if (language === 'Korean') {
        return [
            '1. 제목',
            '2. 핵심 주제의식과 소설 스타일',
            '3. 등장인물 이름, 설정',
            '4. 세계관 설정',
            '5. 각 장 제목과 내용, 핵심 포인트',
        ];
    }

    if (language === 'Japanese') {
        return [
            '1. タイトル',
            '2. 核心となるテーマと小説のスタイル',
            '3. 登場人物の名前・設定',
            '4. 世界観設定',
            '5. 各章のタイトルと内容、重要ポイント',
        ];
    }

    return [
        '1. Title',
        '2. Core Theme and Novel Style',
        '3. Character Names and Settings',
        '4. World Building/Setting',
        '5. Chapter Titles, Content, and Key Points',
    ];
}

export function getPlotChapterSectionHeader(language: Language): string {
    return getPlotSectionHeaders(language)[4];
}

export function formatPlotPartHeading(partNumber: number, language: Language): string {
    if (language === 'Korean') return `제 ${partNumber}부`;
    if (language === 'Japanese') return `第 ${partNumber} 部`;
    return `Part ${partNumber}`;
}

export function formatPlotChapterMarker(chapterNumber: number, language: Language): string {
    if (language === 'Korean') return `제 ${chapterNumber}장`;
    if (language === 'Japanese') return `第 ${chapterNumber} 章`;
    return `Chapter ${chapterNumber}`;
}

function formatPartRange(part, language: Language): string {
    const heading = formatPlotPartHeading(part.part, language);
    const start = formatPlotChapterMarker(part.start, language);
    const end = formatPlotChapterMarker(part.end, language);
    return `${heading}: ${start} - ${end}`;
}

export function buildPlotOutlinePrompt({ seed, language, totalChapters }: PlotPromptInput): string {
    const sectionHeaders = getPlotSectionHeaders(language);
    const arcInstruction = getPlotArcInstruction(language, totalChapters);
    const chapterDesignInstruction = getChapterDesignInstruction(language);

    return `Based on the following seed, create a detailed plot outline for a ${totalChapters}-chapter novel in ${language}.\nSeed: ${seed}\n\nFORMAT INSTRUCTIONS:\nPlease organize the output into the following 5 sections in ${language}:\n${sectionHeaders.join('\n')}\n${arcInstruction}\n${chapterDesignInstruction}\nEnsure every section is detailed. Output ONLY the plot outline based on this format.`;
}

export function buildPlotSettingsPrompt({ seed, language, totalChapters }: PlotPromptInput): string {
    const sectionHeaders = getPlotSectionHeaders(language).slice(0, 4);
    const partPlan = getPartPlan(totalChapters).map(part => formatPartRange(part, language)).join('\n');

    return `You are preparing the foundation for a long-form ${totalChapters}-chapter novel plot in ${language}.
Seed: ${seed}

Generate ONLY the setting/setup sections below:
${sectionHeaders.join('\n')}

Long-form architecture:
${partPlan}

Requirements:
- Do NOT write section 5 or any chapter-by-chapter outline yet.
- Make the title, theme/style, character settings, and world-building concrete enough that later part generation can stay consistent without seeing a full finished plot.
- Include the central promise, main conflict engine, escalation ladder, midpoint pressure, endgame pressure, and intended emotional resolution inside sections 2-4 where they naturally fit.
- For each major character, define visible goal, hidden need, leverage/secret, relationship pressure, likely arc direction, and what information they should or should not know early.
- For the world or premise, define rules, limits, costs, institutions, social pressure, clues, taboos, or constraints that must shape chapter events.
- Keep it concise but specific. Output ONLY sections 1-4, without greetings or meta-commentary.`;
}

export function buildPlotPartPrompt({
    seed,
    language,
    totalChapters,
    settingsText,
    previousPartsText = '',
    partIndex,
}: PlotPartPromptInput): string {
    const plan = getPartPlan(totalChapters);
    const currentPart = plan[partIndex];
    if (!currentPart) {
        throw new Error(`Invalid plot part index: ${partIndex}`);
    }

    const partHeading = formatPlotPartHeading(currentPart.part, language);
    const requiredChapterMarkers = Array.from(
        { length: currentPart.end - currentPart.start + 1 },
        (_, offset) => formatPlotChapterMarker(currentPart.start + offset, language)
    );
    const chapterMarkers = requiredChapterMarkers.join(', ');
    const outputSkeleton = [
        partHeading,
        ...requiredChapterMarkers.map(marker => `${marker}\n- Title:\n- Content:\n- Key Points:`),
    ].join('\n\n');
    const chapterHeader = getPlotChapterSectionHeader(language);
    const arcInstruction = getPlotArcInstruction(language, totalChapters);
    const chapterDesignInstruction = getChapterDesignInstruction(language);
    const previousContext = previousPartsText.trim() || 'No previous parts have been generated yet.';
    const remainingPlan = plan.slice(partIndex + 1).map(part => formatPartRange(part, language)).join('\n') || 'No later parts remain.';
    const fullPlan = plan.map(part => formatPartRange(part, language)).join('\n');

    return `You are generating section 5 of a ${totalChapters}-chapter novel plot in ${language}, one part at a time.
Seed: ${seed}

Already generated setting/setup sections:
${settingsText}

Previously generated section-5 parts:
${previousContext}

Full part coverage plan for reference only. Do not copy this plan into the output:
${fullPlan}

Later part boundaries, for pacing only:
${remainingPlan}

Generate ONLY the current part block:
${partHeading}: ${formatPlotChapterMarker(currentPart.start, language)} - ${formatPlotChapterMarker(currentPart.end, language)}
Required chapter markers in this part: ${chapterMarkers}

Required output skeleton. Copy this structure and fill every marker with concrete plot content:
${outputSkeleton}

Output rules:
- Do NOT output sections 1-4.
- Do NOT output the section heading "${chapterHeader}"; the app will add it.
- The first line must be exactly: ${partHeading}
- Under ${partHeading}, write only the required chapter markers listed above, in ascending order, exactly once each.
- Do not include chapters before ${formatPlotChapterMarker(currentPart.start, language)} or after ${formatPlotChapterMarker(currentPart.end, language)}.
- Preserve continuity with earlier parts, but do not summarize or rewrite them.
- Use later part boundaries only to avoid resolving future conflicts, mysteries, relationship shifts, or endgame reversals too early.
- Follow this global section-5 structure rule: ${arcInstruction}
- Follow this chapter design rule: ${chapterDesignInstruction}
- Output ONLY the current part block, without greetings, explanations, or meta-commentary.`;
}
