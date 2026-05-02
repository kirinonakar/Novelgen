import { AppState } from '../modules/app_state.js';
import { els } from '../modules/dom_refs.js';
import { renderMarkdown } from '../modules/preview.js';
import { invoke } from '../modules/tauri_api.js';
import { showToast } from '../modules/toast.js';
import type { Language } from '../types/app.js';
import {
    getEditorSnapshot,
    resetNovelStatusAfter,
    setNovelStatus,
    setNovelText,
    setPlotText,
    setSeedText,
} from './runtimeEditorStateService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';

interface LoadNovelOptions {
    getLang: () => Language;
    saveSettings: () => Promise<void>;
    detectNextChapter: () => Promise<void>;
    refreshNovelChapterJump: (options?: { preserveValue?: boolean }) => unknown[];
    updatePlotTokenCount: () => void;
}

export async function reloadPlotList() {
    try {
        const plots = await invoke<string[]>('get_saved_plots');
        const { selectedPlot } = runtimeViewStateStore.getSnapshot().savedContent;
        runtimeViewStateStore.setSavedContent({
            plotFiles: plots,
            selectedPlot: plots.includes(selectedPlot) ? selectedPlot : '',
        });
    } catch (e) { }
}

export async function reloadNovelList() {
    try {
        const novels = await invoke<string[]>('get_saved_novels');
        const { selectedNovel } = runtimeViewStateStore.getSnapshot().savedContent;
        runtimeViewStateStore.setSavedContent({
            novelFiles: novels,
            selectedNovel: novels.includes(selectedNovel) ? selectedNovel : '',
        });
    } catch (e) {
        console.warn('[Frontend] Failed to reload novel list:', e);
    }
}

export async function saveNovel() {
    let filename = AppState.loadedNovelFilename;
    if (!filename) {
        try {
            filename = await invoke<string>('get_next_novel_filename');
            AppState.setLoadedNovel(filename, null);
        } catch (e) {
            showToast('Failed to determine a filename for saving.', 'error');
            return;
        }
    }

    try {
        els.novelStatus.innerText = '⏳ Saving novel...';
        setNovelStatus('⏳ Saving novel...', 'saving');

        await invoke('save_novel_text', {
            filename,
            content: getEditorSnapshot().novel,
        });

        const message = '✅ Saved: ' + filename;
        els.novelStatus.innerText = message;
        setNovelStatus(message, 'completed');
        showToast(`Saved novel text: ${filename}`, 'success');

        await reloadNovelList();

        resetNovelStatusAfter(message);
    } catch (e) {
        console.error('[Frontend] Save novel failed:', e);
        showToast('Failed to save novel: ' + e, 'error');
        els.novelStatus.innerText = '❌ Save Error';
        setNovelStatus('❌ Save Error', 'error');
    }
}

export async function loadNovel({
    saveSettings,
    detectNextChapter,
    refreshNovelChapterJump,
    updatePlotTokenCount,
}: LoadNovelOptions) {
    const filename = runtimeViewStateStore.getSnapshot().savedContent.selectedNovel;
    if (!filename) {
        showToast('Please select a novel from the list first.', 'warning');
        return;
    }

    try {
        els.novelStatus.innerText = '⏳ Loading novel...';
        setNovelStatus('⏳ Loading novel...', 'loading');
        const [text, metaJson] = await invoke<[string, string | null]>('load_novel', { filename });

        els.novelContent.value = text;
        setNovelText(text);
        renderMarkdown(els.novelContent.id);
        refreshNovelChapterJump({ preserveValue: false });

        if (metaJson) {
            const meta = JSON.parse(metaJson);
            AppState.setLoadedNovel(filename, meta);
            if (meta.num_chapters) els.numChap.value = meta.num_chapters;
            if (meta.target_tokens) els.targetTokens.value = meta.target_tokens;
            if (meta.language) {
                Array.from<HTMLInputElement>(els.languageRadios).forEach(r => {
                    if (r.value === meta.language) r.checked = true;
                });
                if (meta.language === 'Korean' || meta.language === 'Japanese' || meta.language === 'English') {
                    runtimeViewStateStore.setGenerationParams({ language: meta.language });
                }
            }
            if (meta.plot_seed) {
                els.seedBox.value = meta.plot_seed;
                setSeedText(meta.plot_seed);
            }
            if (meta.plot_outline) {
                els.plotContent.value = meta.plot_outline;
                setPlotText(meta.plot_outline);
                updatePlotTokenCount();
                renderMarkdown(els.plotContent.id);
            }
            await saveSettings();

            showToast(`Loaded novel: ${filename}`, 'success');
        } else {
            AppState.setLoadedNovel(filename, null);
            showToast(`Loaded novel text: ${filename} (No metadata found)`, 'info');
        }

        await detectNextChapter();
        const message = '✅ Loaded: ' + filename;
        els.novelStatus.innerText = message;
        setNovelStatus(message, 'completed');
        resetNovelStatusAfter(message);
    } catch (e) {
        showToast('Failed to load novel: ' + e, 'error');
        els.novelStatus.innerText = '❌ Load Error';
        setNovelStatus('❌ Load Error', 'error');
    }
}
