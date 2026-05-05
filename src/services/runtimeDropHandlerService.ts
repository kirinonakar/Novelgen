import { normalizePlotOutlineOutput } from '../modules/plot_refine.js';
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
    refreshNovelChapterJump: (options?: { preserveValue?: boolean }) => unknown[];
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
            requestAnimationFrame(() => refreshNovelChapterJump({ preserveValue: false }));
        }

        if (target === 'plot') {
            setPlotText(normalizePlotOutlineOutput(text, { totalChapters: getTotalChaptersParam(0) }));
            updatePlotTokenCount();
        }

        if (target === 'seed') {
            setSeedText(text);
        }
    };
}
