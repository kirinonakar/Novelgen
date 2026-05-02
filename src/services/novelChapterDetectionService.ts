import { AppState } from '../modules/app_state.js';
import { els } from '../modules/dom_refs.js';
import { loadNovelState } from '../modules/novel_storage.js';
import { invoke } from '../modules/tauri_api.js';
import type { Language } from '../types/app.js';

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
            if (!els.novelContent.value.trim()) {
                els.resumeCh.value = '1';
                AppState.clearLoadedNovel();
                return;
            }

            let lastCompleted: number | string | null = null;
            if (AppState.loadedNovelFilename) {
                try {
                    const state = await loadNovelState(AppState.loadedNovelFilename);
                    AppState.setLoadedNovel(state.filename, state.meta);
                    lastCompleted = readCompletedChapter(state.meta);
                } catch (e) {
                    console.warn('[Frontend] Failed to fetch loaded novel metadata for detection:', e);
                }
            }

            if (!lastCompleted) {
                lastCompleted = readCompletedChapter(AppState.loadedNovelMetadata);
            }

            if (!lastCompleted) {
                try {
                    const metaResult = await invoke<[string, string] | null>('get_latest_novel_metadata');
                    if (metaResult) {
                        const meta = JSON.parse(metaResult[1]) as NovelMetadataSnapshot;
                        lastCompleted = readCompletedChapter(meta);
                    }
                } catch (e) {
                    console.warn('[Frontend] Failed to fetch metadata for detection:', e);
                }
            }

            let next = await invoke<number>('suggest_next_chapter', {
                text: els.novelContent.value,
                language: getLang(),
                last_completed_ch: lastCompleted,
            });

            const total = parseInt(els.numChap.value, 10) || 0;
            if (total > 0 && next > total) {
                next = 1;
            }
            els.resumeCh.value = String(next);
        } catch (e) {
            console.error('[Frontend] Chapter detection failed:', e);
        }
    }

    return { detectNextChapter };
}
