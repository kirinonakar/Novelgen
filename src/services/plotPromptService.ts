import { getChapterDesignInstruction, getPlotArcInstruction } from '../modules/text_utils.js';
import type { Language, PlotPromptInput } from '../types/app.js';

function getPlotSectionHeaders(language: Language): string[] {
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

export function buildPlotOutlinePrompt({ seed, language, totalChapters }: PlotPromptInput): string {
    const sectionHeaders = getPlotSectionHeaders(language);
    const arcInstruction = getPlotArcInstruction(language, totalChapters);
    const chapterDesignInstruction = getChapterDesignInstruction(language);

    return `Based on the following seed, create a detailed plot outline for a ${totalChapters}-chapter novel in ${language}.\nSeed: ${seed}\n\nFORMAT INSTRUCTIONS:\nPlease organize the output into the following 5 sections in ${language}:\n${sectionHeaders.join('\n')}\n${arcInstruction}\n${chapterDesignInstruction}\nEnsure every section is detailed. Output ONLY the plot outline based on this format.`;
}
