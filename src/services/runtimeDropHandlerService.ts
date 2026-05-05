import { els } from '../modules/dom_refs.js';
import { normalizePlotOutlineOutput } from '../modules/plot_refine.js';
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
    return async function handleDroppedTextLoaded(targetId: string, text: string) {
        if (targetId === els.promptBox?.id && els.preset) {
            runtimeViewStateStore.setPromptEditor({
                selectedPreset: CUSTOM_SYSTEM_PROMPT_PRESET,
                systemPrompt: text,
            });
        }

        if (targetId === els.novelContent?.id) {
            setNovelText(text);
            await detectNextChapter();
            requestAnimationFrame(() => refreshNovelChapterJump({ preserveValue: false }));
        }

        if (targetId === els.plotContent?.id) {
            setPlotText(normalizePlotOutlineOutput(text, { totalChapters: getTotalChaptersParam(0) }));
            updatePlotTokenCount();
        }

        if (targetId === els.seedBox?.id) {
            setSeedText(text);
        }
    };
}
