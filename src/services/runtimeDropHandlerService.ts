import { els } from '../modules/dom_refs.js';
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
    return async function handleDroppedTextLoaded(targetId: string) {
        if (targetId === els.promptBox?.id && els.preset) {
            els.preset.value = CUSTOM_SYSTEM_PROMPT_PRESET;
        }

        if (targetId === els.novelContent?.id) {
            await detectNextChapter();
            refreshNovelChapterJump({ preserveValue: false });
        }

        if (targetId === els.plotContent?.id) {
            updatePlotTokenCount();
        }
    };
}
