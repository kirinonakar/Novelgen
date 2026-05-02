import { AppState } from '../modules/app_state.js';
import { els } from '../modules/dom_refs.js';
import { renderMarkdown } from '../modules/preview.js';
import { invoke } from '../modules/tauri_api.js';
import { showToast } from '../modules/toast.js';
import type { Language } from '../types/app.js';
import { replaceSelectOptions } from './selectOptionsService.js';
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
        replaceSelectOptions(els.savedPlots, plots, 'Select a saved plot...');
    } catch (e) { }
}

export async function reloadNovelList() {
    try {
        const novels = await invoke<string[]>('get_saved_novels');
        replaceSelectOptions(els.savedNovels, novels, 'Select a novel...');
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

        await invoke('save_novel_text', {
            filename,
            content: els.novelContent.value,
        });

        els.novelStatus.innerText = '✅ Saved: ' + filename;
        showToast(`Saved novel text: ${filename}`, 'success');

        await reloadNovelList();

        setTimeout(() => {
            if (els.novelStatus.innerText.includes('Saved')) {
                els.novelStatus.innerText = 'Idle';
            }
        }, 3000);
    } catch (e) {
        console.error('[Frontend] Save novel failed:', e);
        showToast('Failed to save novel: ' + e, 'error');
        els.novelStatus.innerText = '❌ Save Error';
    }
}

export async function loadNovel({
    saveSettings,
    detectNextChapter,
    refreshNovelChapterJump,
    updatePlotTokenCount,
}: LoadNovelOptions) {
    const filename = els.savedNovels.value;
    if (!filename) {
        showToast('Please select a novel from the list first.', 'warning');
        return;
    }

    try {
        els.novelStatus.innerText = '⏳ Loading novel...';
        const [text, metaJson] = await invoke<[string, string | null]>('load_novel', { filename });

        els.novelContent.value = text;
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
            if (meta.plot_seed) els.seedBox.value = meta.plot_seed;
            if (meta.plot_outline) {
                els.plotContent.value = meta.plot_outline;
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
        els.novelStatus.innerText = '✅ Loaded: ' + filename;
        setTimeout(() => {
            if (els.novelStatus.innerText.includes('Loaded')) {
                els.novelStatus.innerText = 'Idle';
            }
        }, 3000);
    } catch (e) {
        showToast('Failed to load novel: ' + e, 'error');
        els.novelStatus.innerText = '❌ Load Error';
    }
}
