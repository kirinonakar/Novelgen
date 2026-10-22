import { runtimeSessionState } from './runtimeSessionStateService.js';
import { loadNovelState } from '../modules/novel_storage.js';
import { invoke } from '../modules/tauri_api.js';
import type { Language } from '../types/app.js';
import { getTotalChaptersParam } from './generationParamsService.js';
import { getEditorSnapshot, setNextChapter } from './runtimeEditorStateService.js';

interface NovelChapterDetectionOptions {
    getLang: () => Language;
}

interface NovelMetadataSnapshot {
    current_chapter?: number | string | null;
}

function readCompletedChapter(metadata: NovelMetadataSnapshot | null | undefined) {
    const value = metadata?.current_chapter;
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim()) return value;
    return null;
}

export function createNovelChapterDetector({ getLang }: NovelChapterDetectionOptions) {
    async function detectNextChapter() {
        try {
            const novelText = getEditorSnapshot().novel;
            if (!novelText.trim()) {
                setNextChapter('1');
                runtimeSessionState.clearLoadedNovel();
                return;
            }

            let lastCompleted: number | string | null = null;
            if (runtimeSessionState.loadedNovelFilename) {
                try {
                    const state = await loadNovelState(runtimeSessionState.loadedNovelFilename);
                    runtimeSessionState.setLoadedNovel(state.filename, state.meta);
                    lastCompleted = readCompletedChapter(state.meta);
                } catch (e) {
                    console.warn('[Frontend] Failed to fetch loaded novel metadata for detection:', e);
                }
            }

            if (!lastCompleted) {
                lastCompleted = readCompletedChapter(runtimeSessionState.loadedNovelMetadata);
            }

            let next = await invoke<number>('suggest_next_chapter', {
                text: novelText,
                language: getLang(),
                last_completed_ch: lastCompleted,
            });

            const total = getTotalChaptersParam(0);
            if (total > 0 && next > total) {
                next = 1;
            }
            setNextChapter(next);
        } catch (e) {
            console.error('[Frontend] Chapter detection failed:', e);
        }
    }

    return { detectNextChapter };
}
