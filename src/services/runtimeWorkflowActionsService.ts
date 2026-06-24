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
import { normalizePlotOutlineOutput, refinePlotInChunks, splitPlotForChunkedRefine } from '../modules/plot_refine.js';
import { invoke } from '../modules/tauri_api.js';
import { showToast } from '../modules/toast.js';
import { getTotalChaptersParam } from './generationParamsService.js';
import { inferTotalChaptersFromPlot } from '../modules/text_utils.js';
import {
    setComfortMode,
    setFontSize,
    setWrapWidth,
} from '../modules/ui_preferences.js';
import type {
    ApiProvider,
    EditorSurface,
    EditorTab,
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
    setPlotRefinePartRange,
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
    refreshNovelChapterJump: (options?: { preserveValue?: boolean; debounce?: boolean }) => Promise<unknown[]>;
    scrollNovelToSelectedChapter: (options?: { silent?: boolean }) => void;
    clearLoadedNovelSession: () => void;
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
    | 'onBatchCountChange'
    | 'onBatchAutoRefinePlotChange'
    | 'onBatchAutoRefinePlotInstructionsChange'
    | 'onBatchAutoRefineNovelChange'
    | 'onBatchAutoRefineNovelInstructionsChange'
    | 'onOpenOutputFolder'
    | 'onSeedChange'
    | 'onPlotContentChange'
    | 'onNovelContentChange'
    | 'onNextChapterChange'
    | 'onPlotRefineStartPartChange'
    | 'onPlotRefineEndPartChange'
    | 'onNovelRefineStartChapterChange'
    | 'onNovelRefineEndChapterChange'
    | 'onNovelChapterJumpChange'
    | 'onEditorTabChange'
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

    function parsePartBound(value: string) {
        const parsed = parseInt(
            String(value || '').replace(/[０-９]/g, ch =>
                String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
            ).trim(),
            10,
        );
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }

    function setPlotRefineStartPart(part: string) {
        const startPart = parsePartBound(part);
        const currentEnd = getEditorSnapshot().plotRefineEndPart;
        const endPart = parsePartBound(currentEnd);

        setPlotRefinePartRange({
            start: part,
            ...(startPart !== null && endPart !== null && endPart < startPart
                ? { end: startPart }
                : {}),
        });
    }

    function setPlotRefineEndPart(part: string) {
        const startPart = parsePartBound(getEditorSnapshot().plotRefineStartPart);
        const endPart = parsePartBound(part);

        setPlotRefinePartRange({
            end: startPart !== null && endPart !== null && endPart < startPart
                ? startPart
                : part,
        });
    }

    function buildPlotAutoInstructionContext({
        plotOutline,
        lang,
        startPart,
        endPart,
    }: {
        plotOutline: string;
        lang: Language;
        startPart: number | null;
        endPart: number | null;
    }) {
        if (startPart === null && endPart === null) {
            return { scopedPlotOutline: plotOutline, scopeDescription: '' };
        }

        const { settingsText, chapterHeader, parts } = splitPlotForChunkedRefine(plotOutline, lang);
        if (parts.length === 0) {
            return {
                scopedPlotOutline: plotOutline,
                scopeDescription: 'A part range was requested, but no part headings were detected; analyze the full plot outline.',
            };
        }

        const start = Math.max(0, Math.min(startPart ?? 1, parts.length));
        const end = Math.max(start, Math.min(endPart ?? start, parts.length));
        const scopedParts = [];
        parts.forEach((part, index) => {
            const partNumber = index + 1;
            if (partNumber >= start && partNumber <= end) {
                scopedParts.push(`[Selected Part ${partNumber}]\n${part}`);
            } else if (partNumber === start - 1 || partNumber === end + 1) {
                scopedParts.push(`[Boundary Context Part ${partNumber} - use only for continuity]\n${part}`);
            }
        });

        const rangeLabel = start === 0
            ? (end === 0 ? 'settings only' : `settings and part${end === 1 ? ' 1' : `s 1-${end}`}`)
            : (start === end ? `part ${start}` : `parts ${start}-${end}`);
        return {
            scopedPlotOutline: [
                settingsText,
                `[Auto Instruction Scope]\nAnalyze and write refinement instructions for selected ${rangeLabel} only. Boundary context is included only to prevent continuity breaks; do not target distant or boundary-only parts unless the instruction directly protects the selected range.`,
                chapterHeader,
                ...scopedParts,
            ].filter(Boolean).join('\n\n'),
            scopeDescription: `Selected target range: ${rangeLabel}. Instructions may cover multiple selected parts when needed, but must remain actionable for this selected range.`,
        };
    }

    function requireGoogleApiKey() {
        const provider = options.getProvider();
        const { apiKey } = runtimeViewStateStore.getSnapshot().apiSettings;
        const apiKeyProviders: ApiProvider[] = ['Google', 'Ollama Cloud', 'OpenCode Go', 'Zen'];
        if (!apiKeyProviders.includes(provider) || apiKey.trim()) return false;
        showToast(`Please enter a ${provider} API Key in the sidebar.`, 'warning');
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
        const totalChapters = getTotalChaptersParam(0);
        const editor = getEditorSnapshot();
        const plotOutline = normalizePlotOutlineOutput(editor.plot, { totalChapters });
        if (plotOutline !== getEditorSnapshot().plot.trim()) {
            setPlotText(plotOutline);
            options.updatePlotTokenCount();
        }
        if (!plotOutline.trim()) {
            showToast('Plot is empty! Generate or load a plot first.', 'warning');
            return;
        }

        const startPartText = editor.plotRefineStartPart.trim();
        let endPartText = editor.plotRefineEndPart.trim();
        if (startPartText && !endPartText) {
            setPlotRefinePartRange({ end: startPartText });
            endPartText = startPartText;
        }
        if (!startPartText && endPartText) {
            setPlotRefinePartRange({ start: '1' });
        }
        const startPart = parsePartBound(startPartText || (endPartText ? '1' : ''));
        let endPart = parsePartBound(endPartText);
        if (startPart !== null && endPart !== null && endPart < startPart) {
            endPart = startPart;
            setPlotRefinePartRange({ end: startPart });
        }
        const { parts } = splitPlotForChunkedRefine(plotOutline, options.getLang());
        if (startPart !== null && parts.length > 0 && startPart > parts.length) {
            showToast(`Start part ${startPart} was not found. This plot has ${parts.length} part${parts.length === 1 ? '' : 's'}.`, 'warning');
            return;
        }
        const { scopedPlotOutline, scopeDescription } = buildPlotAutoInstructionContext({
            plotOutline,
            lang: options.getLang(),
            startPart,
            endPart,
        });

        runtimeViewStateStore.setActivity({ isAutoPlotInstructionsRunning: true });
        try {
            const lang = options.getLang();
            const result = await generatePlotAutoInstructions({
                lang,
                plotOutline: scopedPlotOutline,
                apiParams: getApiParams(),
                scopeDescription,
            });

            runtimeViewStateStore.setRefineInstructions({ plot: result });
            saveSettings();
            const rangeLabel = startPart !== null
                ? ` for ${endPart && endPart !== startPart ? `Parts ${startPart}-${endPart}` : `Part ${startPart}`}`
                : '';
            showToast(`Auto instructions generated${rangeLabel}.`, 'success');
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
            const totalChapters = getTotalChaptersParam(0);
            const normalizedPlot = normalizePlotOutlineOutput(getEditorSnapshot().plot, { totalChapters });
            if (normalizedPlot !== getEditorSnapshot().plot.trim()) {
                setPlotText(normalizedPlot);
                options.updatePlotTokenCount();
            }

            await invoke('save_plot', {
                content: normalizedPlot,
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
            const inferredTotalChapters = inferTotalChaptersFromPlot(content);
            const totalChapters = inferredTotalChapters || getTotalChaptersParam(0);
            if (inferredTotalChapters > 0) {
                runtimeViewStateStore.setGenerationParams({ totalChapters: String(inferredTotalChapters) });
            }
            setPlotText(normalizePlotOutlineOutput(content, { totalChapters }));
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
        void options.refreshNovelChapterJump({ preserveValue: false, debounce: false });
        options.clearLoadedNovelSession();
    }

    function setEditorTab(surface: EditorSurface, tab: EditorTab) {
        const { tabs } = runtimeViewStateStore.getSnapshot().editor;
        runtimeViewStateStore.setEditor({
            tabs: {
                ...tabs,
                [surface]: tab,
            },
        });

        if (surface === 'novel') {
            void options.refreshNovelChapterJump({ debounce: false });
            if (tab === 'preview') {
                requestAnimationFrame(() => options.scrollNovelToSelectedChapter({ silent: true }));
            }
        }
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
        onBatchCountChange: (batchCount) => {
            runtimeViewStateStore.setBatchSettings({ batchCount });
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
        onNovelContentChange: (content) => {
            setNovelText(content);
            void options.refreshNovelChapterJump({ debounce: true });
        },
        onNextChapterChange: setNextChapter,
        onPlotRefineStartPartChange: setPlotRefineStartPart,
        onPlotRefineEndPartChange: setPlotRefineEndPart,
        onNovelRefineStartChapterChange: (chapter) => setNovelRefineChapterRange({ start: chapter }),
        onNovelRefineEndChapterChange: (chapter) => setNovelRefineChapterRange({ end: chapter }),
        onNovelChapterJumpChange: (chapter) => {
            runtimeViewStateStore.setEditor({ novelChapterJump: chapter });
            requestAnimationFrame(() => options.scrollNovelToSelectedChapter());
        },
        onEditorTabChange: setEditorTab,
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
                refreshNovelChapterJump: options.refreshNovelChapterJump,
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
                refreshNovelChapterJump: options.refreshNovelChapterJump,
            });
        },
        onBatchStop: () => {
            stopOrClearBatchQueue({
                updatePlotTokenCount: options.updatePlotTokenCount,
                refreshNovelChapterJump: options.refreshNovelChapterJump,
            });
        },
    };
}
