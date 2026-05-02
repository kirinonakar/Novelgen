import { els } from '../modules/dom_refs.js';
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
    return async function handleDroppedTextLoaded(targetId: string) {
        if (targetId === els.promptBox?.id && els.preset) {
            runtimeViewStateStore.setPromptEditor({
                selectedPreset: CUSTOM_SYSTEM_PROMPT_PRESET,
                systemPrompt: els.promptBox.value,
            });
        }

        if (targetId === els.novelContent?.id) {
            setNovelText(els.novelContent.value);
            await detectNextChapter();
            refreshNovelChapterJump({ preserveValue: false });
        }

        if (targetId === els.plotContent?.id) {
            setPlotText(els.plotContent.value);
            updatePlotTokenCount();
        }

        if (targetId === els.seedBox?.id) {
            setSeedText(els.seedBox.value);
        }
    };
}
