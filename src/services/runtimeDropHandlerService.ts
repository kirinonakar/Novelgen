import { normalizePlotOutlineOutput } from '../modules/plot_refine.js';
import { inferTotalChaptersFromPlot } from '../modules/text_utils.js';
import type { TextDropTarget } from '../types/app.js';
import { getTotalChaptersParam } from './generationParamsService.js';
import {
    setNovelText,
    setPlotText,
    setSeedText,
} from './runtimeEditorStateService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';
import { CUSTOM_SYSTEM_PROMPT_PRESET } from './systemPromptService.js';

interface RuntimeDropHandlerOptions {
    detectNextChapter: () => Promise<void>;
    refreshNovelChapterJump: (options?: { preserveValue?: boolean; forceImmediate?: boolean }) => void;
    updatePlotTokenCount: () => void;
}

export function createRuntimeDropHandler({
    detectNextChapter,
    refreshNovelChapterJump,
    updatePlotTokenCount,
}: RuntimeDropHandlerOptions) {
    return async function handleDroppedTextLoaded(target: TextDropTarget, text: string) {
        if (target === 'systemPrompt') {
            runtimeViewStateStore.setPromptEditor({
                selectedPreset: CUSTOM_SYSTEM_PROMPT_PRESET,
                systemPrompt: text,
            });
        }

        if (target === 'novel') {
            setNovelText(text);
            await detectNextChapter();
            requestAnimationFrame(() => refreshNovelChapterJump({ preserveValue: false, forceImmediate: true }));
        }

        if (target === 'plot') {
            const inferredTotalChapters = inferTotalChaptersFromPlot(text);
            const totalChapters = inferredTotalChapters || getTotalChaptersParam(0);
            if (inferredTotalChapters > 0) {
                runtimeViewStateStore.setGenerationParams({ totalChapters: String(inferredTotalChapters) });
            }
            setPlotText(normalizePlotOutlineOutput(text, { totalChapters }));
            updatePlotTokenCount();
        }

        if (target === 'seed') {
            setSeedText(text);
        }
    };
}
