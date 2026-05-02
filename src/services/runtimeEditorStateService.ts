import type { GenerationStatus } from '../types/app.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';

export function getEditorSnapshot() {
    return runtimeViewStateStore.getSnapshot().editor;
}

export function setSeedText(seed: string) {
    runtimeViewStateStore.setEditor({ seed });
}

export function setPlotText(plot: string) {
    runtimeViewStateStore.setEditor({ plot });
}

export function setNovelText(novel: string) {
    runtimeViewStateStore.setEditor({ novel });
}

export function setPlotStatus(message: string, state: GenerationStatus = 'idle') {
    runtimeViewStateStore.setEditor({
        plotStatus: { message, state },
    });
}

export function setNovelStatus(message: string, state: GenerationStatus = 'idle') {
    runtimeViewStateStore.setEditor({
        novelStatus: { message, state },
    });
}

export function resetPlotStatusAfter(message: string, delayMs = 3000) {
    setTimeout(() => {
        if (runtimeViewStateStore.getSnapshot().editor.plotStatus.message === message) {
            setPlotStatus('Idle', 'idle');
        }
    }, delayMs);
}

export function resetNovelStatusAfter(message: string, delayMs = 3000) {
    setTimeout(() => {
        if (runtimeViewStateStore.getSnapshot().editor.novelStatus.message === message) {
            setNovelStatus('Idle', 'idle');
        }
    }, delayMs);
}

export function setNextChapter(nextChapter: string | number) {
    runtimeViewStateStore.setEditor({ nextChapter: String(nextChapter) });
}

export function setNovelRefineChapterRange(update: {
    start?: string | number;
    end?: string | number;
}) {
    runtimeViewStateStore.setEditor({
        ...(update.start !== undefined ? { novelRefineStartChapter: String(update.start) } : {}),
        ...(update.end !== undefined ? { novelRefineEndChapter: String(update.end) } : {}),
    });
}

export function clearNovelRefineChapterRangeState() {
    runtimeViewStateStore.setEditor({
        novelRefineStartChapter: '',
        novelRefineEndChapter: '',
    });
}
