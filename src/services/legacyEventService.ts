import { AppState } from '../modules/app_state.js';
import {
    requestNovelStop,
    startOrResumeBatchQueue,
    startSingleNovelJob,
    stopOrClearBatchQueue,
} from '../modules/batch_queue.js';
import { els } from '../modules/dom_refs.js';
import { showConfirm } from '../modules/modal.js';
import { generateInstructionForChapter } from '../modules/novel_auto.js';
import { generateNovel } from '../modules/novel_generation.js';
import {
    clearNovelRefineChapterRange,
    refineNovelByChapters,
    splitNovelIntoChapterBlocks,
} from '../modules/novel_refine.js';
import { generatePlotAutoInstructions } from '../modules/plot_auto.js';
import { refinePlotInChunks } from '../modules/plot_refine.js';
import { renderMarkdown } from '../modules/preview.js';
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
import { runtimeViewStateStore } from './runtimeViewStateStore.js';
import { CUSTOM_SYSTEM_PROMPT_PRESET } from './systemPromptService.js';

interface LegacyActionOptions {
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

interface LegacyDomEnhancementOptions {
    setupPromptDropTarget: () => void;
    initNavigationAndTabs: () => void;
}

export type LegacyRuntimeActions = Pick<
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
    | 'onRefinePlot'
    | 'onAutoPlotInstructions'
    | 'onRefreshPlots'
    | 'onSavePlot'
    | 'onLoadPlot'
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

export function setupLegacyDomEnhancements({
    setupPromptDropTarget,
    initNavigationAndTabs,
}: LegacyDomEnhancementOptions) {
    setupPromptDropTarget();
    initNavigationAndTabs();
}

export function createLegacyRuntimeActions(options: LegacyActionOptions): LegacyRuntimeActions {
    function saveSettings() {
        void options.saveSettings();
    }

    function requireGoogleApiKey() {
        if (options.getProvider() !== 'Google' || els.apiKeyBox.value.trim()) return false;
        showToast('Please enter a Google API Key in the sidebar.', 'warning');
        return true;
    }

    async function applySystemPreset(presetName: string) {
        if (presetName === CUSTOM_SYSTEM_PROMPT_PRESET) {
            await options.loadCustomPromptIntoEditor();
            return;
        }

        const presetPrompt = options.getPresetPrompt(presetName);
        if (presetPrompt !== undefined) {
            els.promptBox.value = presetPrompt;
        }
    }

    async function refinePlot() {
        if (requireGoogleApiKey()) return;
        if (!els.plotContent.value.trim()) {
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
        if (!els.plotContent.value.trim()) {
            showToast('Plot is empty! Generate or load a plot first.', 'warning');
            return;
        }

        runtimeViewStateStore.setActivity({ isAutoPlotInstructionsRunning: true });
        try {
            const lang = options.getLang();
            const result = await generatePlotAutoInstructions({
                lang,
                plotOutline: els.plotContent.value,
                apiParams: {
                    apiBase: els.apiBase.value,
                    modelName: els.modelName.value,
                    apiKey: els.apiKeyBox.value || 'lm-studio',
                },
            });

            els.plotRefineInstructions.value = result;
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

        const startCh = els.novelRefineStartChapter.value.trim();
        let endCh = els.novelRefineEndChapter.value.trim();
        if (startCh && !endCh) {
            els.novelRefineEndChapter.value = startCh;
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

        if (!els.novelContent.value.trim()) {
            showToast('Novel is empty! Generate or load a novel first.', 'warning');
            return;
        }

        const plotInfo = els.plotContent.value.trim();
        const lang = options.getLang();

        const { chapters } = splitNovelIntoChapterBlocks(els.novelContent.value, lang);
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
                apiParams: {
                    apiBase: els.apiBase.value,
                    modelName: els.modelName.value,
                    apiKey: els.apiKeyBox.value || 'lm-studio',
                },
            });

            els.novelRefineInstructions.value = result.trim();
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
                content: els.plotContent.value,
                language: options.getLang(),
            });
            els.plotStatusMsg.innerText = '✅ Saved successfully';
            void options.reloadPlotList();
            setTimeout(() => {
                els.plotStatusMsg.innerText = 'Idle';
            }, 3000);
        } catch (e) {
            els.plotStatusMsg.innerText = `❌ Error: ${e}`;
        }
    }

    async function loadPlot() {
        if (!els.savedPlots.value) return;
        try {
            els.plotContent.value = await invoke('load_plot', { filename: els.savedPlots.value });
            options.updatePlotTokenCount();
            els.plotStatusMsg.innerText = `✅ Loaded: ${els.savedPlots.value}`;
            setTimeout(() => {
                els.plotStatusMsg.innerText = 'Idle';
            }, 3000);
        } catch (e) {
            els.plotStatusMsg.innerText = `❌ Error: ${e}`;
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
        const confirmed = await showConfirm(
            'Clear Novel Content',
            'Are you sure you want to clear the novel content? This action cannot be undone.',
        );
        if (!confirmed) return;

        els.novelContent.value = '';
        renderMarkdown(els.novelContent.id);
        els.novelStatus.innerText = 'Cleared.';
        els.resumeCh.value = '1';
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
        onPlotRefineInstructionsChange: saveSettings,
        onNovelRefineInstructionsChange: saveSettings,
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
        onRefinePlot: () => void refinePlot(),
        onAutoPlotInstructions: () => void generatePlotInstructions(),
        onRefreshPlots: () => void options.reloadPlotList(),
        onSavePlot: () => void savePlot(),
        onLoadPlot: () => void loadPlot(),
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
