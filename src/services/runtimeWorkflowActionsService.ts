import { AppState } from '../modules/app_state.js';
import {
    requestNovelStop,
    startOrResumeBatchQueue,
    startSingleNovelJob,
    stopOrClearBatchQueue,
} from '../modules/batch_queue.js';
import { generateInstructionForChapter } from '../modules/novel_auto.js';
import { generateNovel } from '../modules/novel_generation.js';
import {
    clearNovelRefineChapterRange,
    refineNovelByChapters,
    splitNovelIntoChapterBlocks,
} from '../modules/novel_refine.js';
import { generatePlotAutoInstructions } from '../modules/plot_auto.js';
import { refinePlotInChunks } from '../modules/plot_refine.js';
import { invoke } from '../modules/tauri_api.js';
import { showToast } from '../modules/toast.js';
import {
    setComfortMode,
    setFontSize,
    setWrapWidth,
} from '../modules/ui_preferences.js';
import type {
    ApiProvider,
    Language,
    NovelgenRuntimeActions,
    TypographyScope,
} from '../types/app.js';
import {
    cancelConfirmDialog,
    confirmDialog,
    showConfirmDialog,
} from './confirmDialogService.js';
import {
    clearNovelRefineChapterRangeState,
    getEditorSnapshot,
    resetPlotStatusAfter,
    setNextChapter,
    setNovelRefineChapterRange,
    setNovelStatus,
    setNovelText,
    setPlotStatus,
    setPlotText,
    setSeedText,
} from './runtimeEditorStateService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';
import { CUSTOM_SYSTEM_PROMPT_PRESET } from './systemPromptService.js';

interface RuntimeWorkflowActionOptions {
    getLang: () => Language;
    getProvider: () => ApiProvider;
    getPresetPrompt: (name: string) => string | undefined;
    loadCustomPromptIntoEditor: () => Promise<boolean>;
    saveSettings: () => Promise<void>;
    updatePlotTokenCount: () => void;
    reloadNovelList: () => Promise<void>;
    loadNovel: () => Promise<void>;
    saveNovel: () => Promise<void>;
    reloadPlotList: () => Promise<void>;
    detectNextChapter: () => Promise<void>;
    refreshNovelChapterJump: (options?: { preserveValue?: boolean }) => unknown[];
}

export type RuntimeWorkflowActions = Pick<
    NovelgenRuntimeActions,
    | 'onSystemPresetChange'
    | 'onTemperatureChange'
    | 'onTopPChange'
    | 'onRepetitionPenaltyChange'
    | 'onFontSizeChange'
    | 'onWrapWidthChange'
    | 'onComfortModeChange'
    | 'onPlotRefineInstructionsChange'
    | 'onNovelRefineInstructionsChange'
    | 'onBatchAutoRefinePlotChange'
    | 'onBatchAutoRefinePlotInstructionsChange'
    | 'onBatchAutoRefineNovelChange'
    | 'onBatchAutoRefineNovelInstructionsChange'
    | 'onOpenOutputFolder'
    | 'onSeedChange'
    | 'onPlotContentChange'
    | 'onNovelContentChange'
    | 'onNextChapterChange'
    | 'onNovelRefineStartChapterChange'
    | 'onNovelRefineEndChapterChange'
    | 'onConfirmDialogConfirm'
    | 'onConfirmDialogCancel'
    | 'onRefinePlot'
    | 'onAutoPlotInstructions'
    | 'onSavedPlotChange'
    | 'onRefreshPlots'
    | 'onSavePlot'
    | 'onLoadPlot'
    | 'onSavedNovelChange'
    | 'onRefreshNovels'
    | 'onLoadNovel'
    | 'onSaveNovel'
    | 'onFindNextChapter'
    | 'onGenerateNovel'
    | 'onRefineNovel'
    | 'onStopNovel'
    | 'onClearNovel'
    | 'onAutoNovelInstructions'
    | 'onBatchStart'
    | 'onBatchStop'
>;

export function createRuntimeWorkflowActions(options: RuntimeWorkflowActionOptions): RuntimeWorkflowActions {
    function saveSettings() {
        void options.saveSettings();
    }

    function parsePositiveChapter(value: string) {
        const parsed = parseInt(
            String(value || '').replace(/[０-９]/g, ch =>
                String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
            ).trim(),
            10,
        );
        return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
    }

    function requireGoogleApiKey() {
        const { apiKey } = runtimeViewStateStore.getSnapshot().apiSettings;
        if (options.getProvider() !== 'Google' || apiKey.trim()) return false;
        showToast('Please enter a Google API Key in the sidebar.', 'warning');
        return true;
    }

    function getApiParams() {
        const { apiBase, apiKey, modelName } = runtimeViewStateStore.getSnapshot().apiSettings;
        return {
            apiBase,
            apiKey: apiKey || 'lm-studio',
            modelName,
        };
    }

    async function applySystemPreset(presetName: string) {
        if (presetName === CUSTOM_SYSTEM_PROMPT_PRESET) {
            await options.loadCustomPromptIntoEditor();
            return;
        }

        const presetPrompt = options.getPresetPrompt(presetName);
        if (presetPrompt !== undefined) {
            runtimeViewStateStore.setPromptEditor({
                selectedPreset: presetName,
                systemPrompt: presetPrompt,
            });
        }
    }

    async function refinePlot() {
        if (requireGoogleApiKey()) return;
        if (!getEditorSnapshot().plot.trim()) {
            showToast('Plot is empty! Load or generate a plot first.', 'warning');
            return;
        }

        await refinePlotInChunks({
            getLang: options.getLang,
            updatePlotTokenCount: options.updatePlotTokenCount,
        });
    }

    async function generatePlotInstructions() {
        if (requireGoogleApiKey()) return;
        const plotOutline = getEditorSnapshot().plot;
        if (!plotOutline.trim()) {
            showToast('Plot is empty! Generate or load a plot first.', 'warning');
            return;
        }

        runtimeViewStateStore.setActivity({ isAutoPlotInstructionsRunning: true });
        try {
            const lang = options.getLang();
            const result = await generatePlotAutoInstructions({
                lang,
                plotOutline,
                apiParams: getApiParams(),
            });

            runtimeViewStateStore.setRefineInstructions({ plot: result });
            saveSettings();
            showToast('Auto instructions generated.', 'success');
        } catch (e) {
            console.error('[Frontend] Auto instructions failed:', e);
            showToast('Failed to generate instructions: ' + String(e), 'error');
        } finally {
            runtimeViewStateStore.setActivity({ isAutoPlotInstructionsRunning: false });
        }
    }

    async function generateNovelInstructions() {
        if (requireGoogleApiKey()) return;

        const editor = getEditorSnapshot();
        const startCh = editor.novelRefineStartChapter.trim();
        let endCh = editor.novelRefineEndChapter.trim();
        if (startCh && !endCh) {
            setNovelRefineChapterRange({ end: startCh });
            endCh = startCh;
        }
        const startNumber = parsePositiveChapter(startCh);
        const endNumber = parsePositiveChapter(endCh);
        if (startNumber !== null && endNumber !== null && endNumber < startNumber) {
            setNovelRefineChapterRange({ end: startCh });
            endCh = startCh;
        }

        if (!startCh || startCh !== endCh) {
            showToast('Start and End chapter must be identical to use Auto Instructions.', 'warning');
            return;
        }

        const chapterNumber = parseInt(startCh, 10);
        if (!chapterNumber) {
            showToast('Invalid chapter number.', 'warning');
            return;
        }

        if (!editor.novel.trim()) {
            showToast('Novel is empty! Generate or load a novel first.', 'warning');
            return;
        }

        const plotInfo = editor.plot.trim();
        const lang = options.getLang();

        const { chapters } = splitNovelIntoChapterBlocks(editor.novel, lang);
        const chapterBlocks = chapters.sort((a, b) => a.number - b.number);

        const currentChapterIndex = chapterBlocks.findIndex(c => c.number === chapterNumber);
        if (currentChapterIndex === -1) {
            showToast(`Chapter ${chapterNumber} not found in the text.`, 'warning');
            return;
        }

        const currentChapterText = chapterBlocks[currentChapterIndex].body;
        const prevChapterText = currentChapterIndex > 0 ? chapterBlocks[currentChapterIndex - 1].body : 'None.';
        const nextChapterText = currentChapterIndex < chapterBlocks.length - 1 ? chapterBlocks[currentChapterIndex + 1].body : 'None.';

        runtimeViewStateStore.setActivity({ isAutoNovelInstructionsRunning: true });
        try {
            const result = await generateInstructionForChapter({
                lang,
                plotInfo,
                prevChapterText,
                currentChapterText,
                nextChapterText,
                apiParams: getApiParams(),
            });

            runtimeViewStateStore.setRefineInstructions({ novel: result.trim() });
            saveSettings();
            showToast(`Auto instructions generated for Chapter ${chapterNumber}.`, 'success');
        } catch (e) {
            console.error('[Frontend] Auto novel instructions failed:', e);
            showToast('Failed to generate instructions: ' + String(e), 'error');
        } finally {
            runtimeViewStateStore.setActivity({ isAutoNovelInstructionsRunning: false });
        }
    }

    async function savePlot() {
        try {
            await invoke('save_plot', {
                content: getEditorSnapshot().plot,
                language: options.getLang(),
            });
            const message = '✅ Saved successfully';
            setPlotStatus(message, 'completed');
            void options.reloadPlotList();
            resetPlotStatusAfter(message);
        } catch (e) {
            setPlotStatus(`❌ Error: ${e}`, 'error');
        }
    }

    async function loadPlot() {
        const filename = runtimeViewStateStore.getSnapshot().savedContent.selectedPlot;
        if (!filename) return;
        try {
            const content = await invoke<string>('load_plot', { filename });
            setPlotText(content);
            options.updatePlotTokenCount();
            const message = `✅ Loaded: ${filename}`;
            setPlotStatus(message, 'completed');
            resetPlotStatusAfter(message);
        } catch (e) {
            setPlotStatus(`❌ Error: ${e}`, 'error');
        }
    }

    async function refineNovel() {
        if (requireGoogleApiKey()) return;
        await refineNovelByChapters({
            getLang: options.getLang,
            detectNextChapter: options.detectNextChapter,
            reloadNovelList: options.reloadNovelList,
        });
    }

    async function clearNovel() {
        const confirmed = await showConfirmDialog(
            'Clear Novel Content',
            'Are you sure you want to clear the novel content? This action cannot be undone.',
        );
        if (!confirmed) return;

        setNovelText('');
        setNovelStatus('Cleared.', 'idle');
        setNextChapter('1');
        clearNovelRefineChapterRangeState();
        clearNovelRefineChapterRange();
        options.refreshNovelChapterJump({ preserveValue: false });
        AppState.clearLoadedNovel();
    }

    return {
        onSystemPresetChange: (presetName) => void applySystemPreset(presetName),
        onTemperatureChange: (temperature) => {
            runtimeViewStateStore.setGenerationParams({ temperature });
        },
        onTopPChange: (topP) => {
            runtimeViewStateStore.setGenerationParams({ topP });
        },
        onRepetitionPenaltyChange: (repetitionPenalty) => {
            runtimeViewStateStore.setGenerationParams({ repetitionPenalty });
        },
        onFontSizeChange: (scope: TypographyScope, fontSize: string) => {
            runtimeViewStateStore.setTypographyScope(scope, { fontSize });
            setFontSize(scope, fontSize);
            saveSettings();
        },
        onWrapWidthChange: (scope: TypographyScope, wrapWidth: string) => {
            runtimeViewStateStore.setTypographyScope(scope, { wrapWidth });
            setWrapWidth(scope, wrapWidth);
            saveSettings();
        },
        onComfortModeChange: (scope: TypographyScope, comfort: boolean) => {
            runtimeViewStateStore.setTypographyScope(scope, { comfort });
            setComfortMode(scope, comfort, { persist: true });
        },
        onPlotRefineInstructionsChange: (instructions) => {
            runtimeViewStateStore.setRefineInstructions({ plot: instructions });
            saveSettings();
        },
        onNovelRefineInstructionsChange: (instructions) => {
            runtimeViewStateStore.setRefineInstructions({ novel: instructions });
            saveSettings();
        },
        onBatchAutoRefinePlotChange: (enabled) => {
            runtimeViewStateStore.setBatchSettings({ autoRefinePlot: enabled });
            saveSettings();
        },
        onBatchAutoRefinePlotInstructionsChange: (enabled) => {
            runtimeViewStateStore.setBatchSettings({ autoRefinePlotInstructions: enabled });
            saveSettings();
        },
        onBatchAutoRefineNovelChange: (enabled) => {
            runtimeViewStateStore.setBatchSettings({ autoRefineNovel: enabled });
            saveSettings();
        },
        onBatchAutoRefineNovelInstructionsChange: (enabled) => {
            runtimeViewStateStore.setBatchSettings({ autoRefineNovelInstructions: enabled });
            saveSettings();
        },
        onOpenOutputFolder: () => {
            invoke('open_output_folder').catch(e => showToast('Failed to open folder: ' + e, 'error'));
        },
        onSeedChange: setSeedText,
        onPlotContentChange: (content) => {
            setPlotText(content);
            options.updatePlotTokenCount();
        },
        onNovelContentChange: setNovelText,
        onNextChapterChange: setNextChapter,
        onNovelRefineStartChapterChange: (chapter) => setNovelRefineChapterRange({ start: chapter }),
        onNovelRefineEndChapterChange: (chapter) => setNovelRefineChapterRange({ end: chapter }),
        onConfirmDialogConfirm: confirmDialog,
        onConfirmDialogCancel: cancelConfirmDialog,
        onRefinePlot: () => void refinePlot(),
        onAutoPlotInstructions: () => void generatePlotInstructions(),
        onSavedPlotChange: (filename) => {
            runtimeViewStateStore.setSavedContent({ selectedPlot: filename });
        },
        onRefreshPlots: () => void options.reloadPlotList(),
        onSavePlot: () => void savePlot(),
        onLoadPlot: () => void loadPlot(),
        onSavedNovelChange: (filename) => {
            runtimeViewStateStore.setSavedContent({ selectedNovel: filename });
        },
        onRefreshNovels: () => void options.reloadNovelList(),
        onLoadNovel: () => void options.loadNovel(),
        onSaveNovel: () => void options.saveNovel(),
        onFindNextChapter: () => void options.detectNextChapter(),
        onGenerateNovel: () => {
            startSingleNovelJob({
                getLang: options.getLang,
                generateNovel,
                detectNextChapter: options.detectNextChapter,
                updatePlotTokenCount: options.updatePlotTokenCount,
                reloadNovelList: options.reloadNovelList,
            });
        },
        onRefineNovel: () => void refineNovel(),
        onStopNovel: requestNovelStop,
        onClearNovel: () => void clearNovel(),
        onAutoNovelInstructions: () => void generateNovelInstructions(),
        onBatchStart: () => {
            startOrResumeBatchQueue({
                getLang: options.getLang,
                generateNovel,
                detectNextChapter: options.detectNextChapter,
                updatePlotTokenCount: options.updatePlotTokenCount,
                reloadNovelList: options.reloadNovelList,
            });
        },
        onBatchStop: () => {
            stopOrClearBatchQueue({ updatePlotTokenCount: options.updatePlotTokenCount });
        },
    };
}
