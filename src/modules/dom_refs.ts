import { showToast } from './toast.js';

export const els: Record<string, any> = {};

export function initElements() {
    console.log("[Frontend] Initializing elements...");
    try {
        els.apiBase = document.getElementById('api-base');
        els.apiKeyGroup = document.getElementById('group-api-key');
        els.apiKeyBox = document.getElementById('api-key');
        els.modelName = document.getElementById('model-name');
        els.refreshModelsBtn = document.getElementById('refresh-models-btn');

        els.preset = document.getElementById('system-preset');
        els.promptBox = document.getElementById('system-prompt');
        els.savePromptBtn = document.getElementById('save-prompt-btn');
        els.promptStatus = document.getElementById('prompt-status-msg');
        els.apiStatus = document.getElementById('api-status');

        els.numChap = document.getElementById('num-chapters');
        els.targetTokens = document.getElementById('target-tokens');
        els.temp = document.getElementById('temperature');
        els.tempVal = document.getElementById('temp-val');
        els.topP = document.getElementById('top-p');
        els.topPVal = document.getElementById('topp-val');
        els.resumeCh = document.getElementById('resume-chapter');
        els.findChBtn = document.getElementById('find-ch-btn');
        els.repetitionPenalty = document.getElementById('repetition-penalty');
        els.rpVal = document.getElementById('rp-val');
        els.openFolderBtn = document.getElementById('open-out-folder-btn');

        els.seedBox = document.getElementById('plot-seed');
        els.autoSeedBtn = document.getElementById('auto-seed-btn');
        els.btnGenPlot = document.getElementById('btn-gen-plot');
        els.btnRefinePlot = document.getElementById('btn-refine-plot');
        els.btnStopPlot = document.getElementById('btn-stop-plot');

        els.savedPlots = document.getElementById('saved-plots');
        els.btnLoadPlot = document.getElementById('btn-load-plot');
        els.btnRefreshPlots = document.getElementById('btn-refresh-plots');
        els.btnSavePlot = document.getElementById('btn-save-plot');
        els.plotStatusMsg = document.getElementById('plot-status-msg');
        els.plotRefineInstructions = document.getElementById('plot-refine-instructions');
        els.btnAutoPlotInstructions = document.getElementById('btn-auto-plot-instructions');
        els.plotContent = document.getElementById('plot-content');

        els.btnGenNovel = document.getElementById('btn-gen-novel');
        els.btnRefineNovel = document.getElementById('btn-refine-novel');
        els.btnClearNovel = document.getElementById('btn-clear-novel');
        els.btnStopNovel = document.getElementById('btn-stop-novel');
        els.novelStatus = document.getElementById('novel-status');
        els.novelRefineInstructions = document.getElementById('novel-refine-instructions');
        els.novelRefineStartChapter = document.getElementById('novel-refine-start-chapter');
        els.novelRefineEndChapter = document.getElementById('novel-refine-end-chapter');
        els.btnAutoNovelInstructions = document.getElementById('btn-auto-novel-instructions');
        els.novelChapterJump = document.getElementById('novel-chapter-jump');
        els.novelContent = document.getElementById('novel-content');
        els.novelContentPreview = document.getElementById('novel-content-preview');
        els.plotSeedPreview = document.getElementById('plot-seed-preview');
        els.plotContentPreview = document.getElementById('plot-content-preview');
        els.plotTokenCount = document.getElementById('plot-token-count');

        els.savedNovels = document.getElementById('saved-novels');
        els.btnLoadNovel = document.getElementById('btn-load-novel');
        els.btnRefreshNovels = document.getElementById('btn-refresh-novels');
        els.btnSaveNovel = document.getElementById('btn-save-novel');

        els.batchCount = document.getElementById('batch-count');
        els.queueCount = document.getElementById('queue-count');
        els.batchAutoRefinePlot = document.getElementById('batch-auto-refine-plot');
        els.batchAutoRefinePlotInstructions = document.getElementById('batch-auto-refine-plot-instructions');
        els.batchAutoRefineNovel = document.getElementById('batch-auto-refine-novel');
        els.batchAutoRefineNovelInstructions = document.getElementById('batch-auto-refine-novel-instructions');
        els.batchStartBtn = document.getElementById('batch-start-btn');
        els.batchStopBtn = document.getElementById('batch-stop-btn');

        els.modalOverlay = document.getElementById('modal-overlay');
        els.modalTitle = document.getElementById('modal-title');
        els.modalMessage = document.getElementById('modal-message');
        els.modalConfirmBtn = document.getElementById('modal-confirm');
        els.modalCancelBtn = document.getElementById('modal-cancel');

        els.providerRadios = document.getElementsByName('provider');
        els.languageRadios = document.getElementsByName('language');
        els.themeToggle = document.getElementById('theme-toggle');

        els.sidebar = document.querySelector('.sidebar');
        els.resizer = document.getElementById('sidebar-resizer');

        els.seedFsSlider = document.getElementById('seed-fs-slider');
        els.seedFsVal = document.getElementById('seed-fs-val');
        els.seedWrapSlider = document.getElementById('seed-wrap-slider');
        els.seedWrapVal = document.getElementById('seed-wrap-val');
        els.seedComfortToggle = document.getElementById('seed-comfort-toggle');
        els.plotFsSlider = document.getElementById('plot-fs-slider');
        els.plotFsVal = document.getElementById('plot-fs-val');
        els.plotWrapSlider = document.getElementById('plot-wrap-slider');
        els.plotWrapVal = document.getElementById('plot-wrap-val');
        els.plotComfortToggle = document.getElementById('plot-comfort-toggle');
        els.novelFsSlider = document.getElementById('novel-fs-slider');
        els.novelFsVal = document.getElementById('novel-fs-val');
        els.novelWrapSlider = document.getElementById('novel-wrap-slider');
        els.novelWrapVal = document.getElementById('novel-wrap-val');
        els.novelComfortToggle = document.getElementById('novel-comfort-toggle');

        console.log("[Frontend] Elements initialized successfully.");
    } catch (e) {
        showToast("Element initialization failed: " + e.message, 'error');
    }
}
