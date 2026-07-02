import { runtimeSessionState } from '../services/runtimeSessionStateService.js';
import {
    generatePlotOutlineInChunks,
    shouldGeneratePlotInChunks,
} from '../services/chunkedPlotGenerationService.js';
import { generatePlotStream } from '../services/plotGenerationService.js';
import { loadLatestNovelState, loadNovelState, metadataNextChapter } from './novel_storage.js';
import { clearNovelRefineChapterRange, refineNovelTextInChapters } from './novel_refine.js';
import { generatePlotAutoInstructions } from './plot_auto.js';
import { normalizePlotOutlineOutput, refinePlotTextInChunks } from './plot_refine.js';
import { buildPlotOutlinePrompt } from '../services/plotPromptService.js';
import {
    getTargetTokensParam,
    getTotalChaptersParam,
} from '../services/generationParamsService.js';
import { runtimeViewStateStore } from '../services/runtimeViewStateStore.js';
import type { GenerationStatus } from '../types/app.js';
import {
    getEditorSnapshot,
    setNextChapter,
    setNovelStatus as setNovelStatusView,
    setNovelText,
    setPlotStatus as setPlotStatusView,
    setPlotText,
} from '../services/runtimeEditorStateService.js';
import { invoke } from './tauri_api.js';
import { showToast } from './toast.js';
import {
    assertCompletePlotOutline,
    getCleanedInitialText,
    missingPlotChapters,
} from './text_utils.js';

const RATE_LIMIT_RETRY_DELAY_MS = 30000;
const MAX_RATE_LIMIT_AUTO_RESUME_COUNT = 30;

export function updateBatchButtons() {
    const isNovelGenerationResume = canResumeActiveNovelGenerationJob();
    if (runtimeSessionState.isPaused && runtimeSessionState.taskQueue.length > 0 && isNovelGenerationResume) {
        runtimeViewStateStore.setActivity({
            batchStartLabel: "▶️ Resume",
            batchStopLabel: runtimeSessionState.taskQueue[0].uid === runtimeSessionState.lastRanJobUid
                ? "🗑️ Clear Stopped"
                : "🗑️ All Clear",
            isBatchResume: true,
        });
    } else {
        runtimeViewStateStore.setActivity({
            batchModeStatus: '',
            batchStartLabel: "🚀 Batch Start",
            batchStopLabel: "⏹️ Stop Queue",
            isBatchResume: false,
        });
    }
}

function canResumeActiveNovelGenerationJob() {
    if (!runtimeSessionState.isPaused || runtimeSessionState.taskQueue.length === 0) return false;
    const job = runtimeSessionState.taskQueue[0];
    return job?.canResumeNovelGeneration === true;
}

function prepareActiveJobForNovelResume() {
    const job = runtimeSessionState.taskQueue[0];
    if (!job?.canResumeNovelGeneration) return;

    clearRateLimitAutoResumeTimers(job);
    job.rateLimitRetryLabel = null;
    if (job.type === 'single') {
        job.startChapter = parseInt(getEditorSnapshot().nextChapter, 10) || job.startChapter || 1;
    }
}

function rateLimitRetryLabel(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (message.includes('tokens per minute') && message.includes('exceeded')) {
        return 'Tokens per minute limit exceeded';
    }
    if (message.includes('requests per minute') && message.includes('exceeded')) {
        return 'Requests per minute limit exceeded';
    }
    if (message.includes('429') && message.includes('too many requests')) {
        return 'Too many requests';
    }
    if (message.includes('rate limit') && message.includes('exceeded')) {
        return 'Rate limit exceeded';
    }
    return null;
}

function setRateLimitRetryState(job, retryLabel) {
    job.rateLimitRetryLabel = retryLabel || 'Rate limit exceeded';
    const currentAttempt = job.rateLimitRetryAttempt || 0;
    if (currentAttempt >= MAX_RATE_LIMIT_AUTO_RESUME_COUNT) {
        clearRateLimitAutoResumeTimers(job);
        job.canResumeNovelGeneration = false;
        job.rateLimitRetryLabel = null;
        runtimeSessionState.stopRequested = true;
        runtimeSessionState.isPaused = true;
        runtimeViewStateStore.setActivity({ batchModeStatus: '' });
        setNovelStatus(`❌ Error: ${retryLabel}. Auto-resume limit reached (${MAX_RATE_LIMIT_AUTO_RESUME_COUNT}/${MAX_RATE_LIMIT_AUTO_RESUME_COUNT}).`);
        updateBatchButtons();
        return null;
    }

    job.rateLimitRetryAttempt = (job.rateLimitRetryAttempt || 0) + 1;
    job.canResumeNovelGeneration = true;
    runtimeSessionState.stopRequested = true;
    runtimeSessionState.isPaused = true;
    setNovelStatus(`⏳ ${job.rateLimitRetryLabel}. Auto-resuming in ${RATE_LIMIT_RETRY_DELAY_MS / 1000}s... (${job.rateLimitRetryAttempt}/${MAX_RATE_LIMIT_AUTO_RESUME_COUNT})`);
    updateBatchButtons();
    return job.rateLimitRetryAttempt;
}

function clearRateLimitAutoResumeTimers(job) {
    if (job?.rateLimitRetryCountdownId) {
        window.clearInterval(job.rateLimitRetryCountdownId);
        job.rateLimitRetryCountdownId = null;
    }
    if (job?.rateLimitRetryTimeoutId) {
        window.clearTimeout(job.rateLimitRetryTimeoutId);
        job.rateLimitRetryTimeoutId = null;
    }
}

function isActiveRateLimitRetryJob(jobUid, retryAttempt) {
    const activeJob = runtimeSessionState.taskQueue[0];
    return !!activeJob
        && activeJob.uid === jobUid
        && activeJob.rateLimitRetryAttempt === retryAttempt
        && activeJob.canResumeNovelGeneration === true;
}

function scheduleRateLimitAutoResume(job, queueArgs, retryAttempt = job.rateLimitRetryAttempt) {
    clearRateLimitAutoResumeTimers(job);
    const jobUid = job.uid;
    let remainingSeconds = Math.ceil(RATE_LIMIT_RETRY_DELAY_MS / 1000);

    const updateCountdown = () => {
        if (!isActiveRateLimitRetryJob(jobUid, retryAttempt)) {
            return false;
        }
        const activeJob = runtimeSessionState.taskQueue[0];
        const retryLabel = activeJob.rateLimitRetryLabel || job.rateLimitRetryLabel || 'Rate limit exceeded';
        const message = `⏳ ${retryLabel}. Auto-resuming in ${remainingSeconds}s...`;
        console.log(`[Batch] ${message}`);
        setNovelStatus(message);
        runtimeViewStateStore.setActivity({ batchModeStatus: `Auto-resuming in ${remainingSeconds}s` });
        return true;
    };

    updateCountdown();
    job.rateLimitRetryCountdownId = window.setInterval(() => {
        remainingSeconds -= 1;
        if (remainingSeconds <= 0) {
            window.clearInterval(job.rateLimitRetryCountdownId);
            job.rateLimitRetryCountdownId = null;
            return;
        }
        if (!updateCountdown()) {
            clearRateLimitAutoResumeTimers(job);
        }
    }, 1000);

    job.rateLimitRetryTimeoutId = window.setTimeout(async () => {
        if (!isActiveRateLimitRetryJob(jobUid, retryAttempt)) {
            return;
        }

        const activeJob = runtimeSessionState.taskQueue[0];
        clearRateLimitAutoResumeTimers(activeJob);
        prepareActiveJobForNovelResume();
        activeJob.rateLimitRetryLabel = null;
        runtimeSessionState.isPaused = false;
        runtimeSessionState.stopRequested = false;
        runtimeViewStateStore.setActivity({ batchModeStatus: '' });
        try {
            await invoke('resume_generation');
        } catch (e) {
            console.warn('[Batch] Failed to clear backend stop flag before auto-resume:', e);
        }
        updateBatchButtons();
        processQueue(queueArgs);
    }, RATE_LIMIT_RETRY_DELAY_MS);
}

function setBatchQueueCount(queueCount) {
    runtimeViewStateStore.setActivity({ batchQueueCount: queueCount });
}

function clearBatchWorkspace(updatePlotTokenCount, refreshNovelChapterJump = null) {
    setPlotText("");
    setPlotStatusView("Idle", "idle");
    setNovelText("");
    refreshNovelChapterJump?.({ preserveValue: false });
    setNextChapter(1);
    clearNovelRefineChapterRange();
    runtimeViewStateStore.setRefineInstructions({ plot: "", novel: "" });

    runtimeSessionState.clearLoadedNovel();
    updatePlotTokenCount();
}

function getCurrentNovelStatusFilename(fallback = null) {
    return fallback || runtimeSessionState.activeNovelFilename || runtimeSessionState.loadedNovelFilename || null;
}

function formatNovelStatus(message, filename = null) {
    const currentFilename = getCurrentNovelStatusFilename(filename);
    const cleanMessage = String(message || '').replace(/\s+\([^()]+\.txt\)$/, '');
    return currentFilename ? `${cleanMessage} (${currentFilename})` : cleanMessage;
}

function setNovelStatus(message, filename = null) {
    const formattedMessage = formatNovelStatus(message, filename);
    const state: GenerationStatus = formattedMessage.includes('Error') || formattedMessage.includes('❌')
        ? 'error'
        : formattedMessage.includes('Stopped') || formattedMessage.includes('🛑')
            ? 'cancelled'
            : formattedMessage.includes('Done') || formattedMessage.includes('✅')
                ? 'completed'
                : formattedMessage.includes('Stopping')
                    ? 'stopping'
                    : 'generating';
    setNovelStatusView(formattedMessage, state);
}

function setActiveNovelFilename(filename) {
    if (!filename) return;
    runtimeSessionState.setActiveNovel(filename);
    const currentMessage = getEditorSnapshot().novelStatus.message;
    if (currentMessage) {
        setNovelStatus(currentMessage, filename);
    }
}

function getRuntimeApiParams() {
    const { apiSettings, generationParams, promptEditor } = runtimeViewStateStore.getSnapshot();
    return {
        apiBase: apiSettings.apiBase,
        modelName: apiSettings.modelName,
        apiKey: apiSettings.apiKey || 'lm-studio',
        systemPrompt: promptEditor.systemPrompt,
        temperature: parseFloat(generationParams.temperature),
        topP: parseFloat(generationParams.topP),
        repetitionPenalty: parseFloat(generationParams.repetitionPenalty),
    };
}

export function requestNovelStop() {
    if (runtimeSessionState.isNovelRefining && !runtimeSessionState.stopRequested) {
        runtimeSessionState.stopRequested = true;
        setNovelStatus('Stopping refine...');
        invoke('stop_generation');
        return;
    }

    if (runtimeSessionState.isWorkerRunning && !runtimeSessionState.stopRequested) {
        runtimeSessionState.stopRequested = true;
        runtimeSessionState.isPaused = true;
        invoke('stop_generation');
        updateBatchButtons();
    } else {
        runtimeSessionState.stopRequested = true;
        invoke('stop_generation');
    }
}

export function startSingleNovelJob({ getLang, generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump }) {
    if (runtimeSessionState.isNovelRefining) {
        showToast('Novel refine is already running.', 'warning');
        return;
    }

    if (runtimeSessionState.isWorkerRunning && runtimeSessionState.stopRequested) {
        showToast('Generation is stopping. Please wait a moment before queueing another novel.', 'warning');
        return;
    }

    const editor = getEditorSnapshot();
    if (!editor.plot.trim()) {
        showToast('Plot is empty! Generate a plot outline first.', 'warning');
        return;
    }

    const totalChapters = getTotalChaptersParam(0);
    const normalizedPlot = normalizePlotOutlineOutput(editor.plot, { totalChapters });
    if (normalizedPlot !== editor.plot.trim()) {
        setPlotText(normalizedPlot);
        updatePlotTokenCount();
    }

    const missingChapters = missingPlotChapters(normalizedPlot, totalChapters);
    if (missingChapters.length > 0) {
        showToast(`Plot is incomplete. Missing chapters: ${missingChapters.join(', ')}`, 'error');
        return;
    }

    if (runtimeSessionState.isPaused || (!runtimeSessionState.isWorkerRunning && runtimeSessionState.taskQueue.length > 0)) {
        runtimeSessionState.reset();
        updateBatchButtons();
    }

    const queueBehindRunningJob = runtimeSessionState.isWorkerRunning && !runtimeSessionState.isPaused;
    runtimeSessionState.taskQueue.push({
        uid: Date.now() + Math.random(),
        type: 'single',
        plotOutline: normalizedPlot,
        startChapter: queueBehindRunningJob ? 1 : (parseInt(editor.nextChapter) || 1),
        totalChapters,
        targetTokens: getTargetTokensParam(2000),
        lang: getLang(),
        plotSeed: editor.seed,
        canResumeNovelGeneration: false,
        rateLimitRetryLabel: null,
        rateLimitRetryAttempt: 0,
        rateLimitRetryCountdownId: null,
        rateLimitRetryTimeoutId: null,
    });

    setBatchQueueCount(runtimeSessionState.taskQueue.length);
    if (queueBehindRunningJob) {
        showToast('Novel generation queued with the current plot/settings.', 'success');
    }
    processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump });
}

export async function startOrResumeBatchQueue({
    getLang,
    generateNovel,
    detectNextChapter,
    updatePlotTokenCount,
    reloadNovelList,
    refreshNovelChapterJump,
}) {
    if (runtimeSessionState.isNovelRefining) {
        showToast('Novel refine is already running.', 'warning');
        return;
    }

    if (runtimeSessionState.isPaused && runtimeSessionState.taskQueue.length > 0 && canResumeActiveNovelGenerationJob()) {
        if (runtimeSessionState.isWorkerRunning && runtimeSessionState.stopRequested) {
            prepareActiveJobForNovelResume();
            runtimeSessionState.isPaused = false;
            runtimeSessionState.pendingProcessQueue = true;
            updateBatchButtons();
            return;
        }

        prepareActiveJobForNovelResume();
        runtimeSessionState.isPaused = false;
        runtimeSessionState.stopRequested = false;
        await invoke('resume_generation');

        updateBatchButtons();
        processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump });
        return;
    }

    if (runtimeSessionState.isPaused) {
        runtimeSessionState.reset();
        setBatchQueueCount(0);
        updateBatchButtons();
    }

    const count = parseInt(runtimeViewStateStore.getSnapshot().batchSettings.batchCount, 10) || 1;
    const batchSettings = runtimeViewStateStore.getSnapshot().batchSettings;
    const preserveDisplayedNovelUntilGeneration = runtimeSessionState.isWorkerRunning && !runtimeSessionState.isPaused;
    for (let i = 0; i < count; i++) {
        runtimeSessionState.taskQueue.push({
            uid: Date.now() + Math.random(),
            type: 'batch',
            seed: getEditorSnapshot().seed,
            totalChapters: getTotalChaptersParam(1),
            targetTokens: getTargetTokensParam(2000),
            lang: getLang(),
            autoRefinePlot: batchSettings.autoRefinePlot,
            autoRefinePlotInstructions: batchSettings.autoRefinePlotInstructions,
            autoRefineNovel: batchSettings.autoRefineNovel,
            autoRefineNovelInstructions: batchSettings.autoRefineNovelInstructions,
            plotRefineFinished: false,
            novelRefineFinished: false,
            lastRefinedPlotPart: 0,
            lastRefinedChapter: 0,
            preserveDisplayedNovelUntilGeneration,
            startedNovelGeneration: false,
            canResumeNovelGeneration: false,
            rateLimitRetryLabel: null,
            rateLimitRetryAttempt: 0,
            rateLimitRetryCountdownId: null,
            rateLimitRetryTimeoutId: null,
        });
    }
    setBatchQueueCount(runtimeSessionState.taskQueue.length);
    if (preserveDisplayedNovelUntilGeneration) {
        refreshNovelChapterJump?.();
    }
    processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump });
}

export function stopOrClearBatchQueue({ updatePlotTokenCount, refreshNovelChapterJump = null }) {
    if (runtimeSessionState.isWorkerRunning && !runtimeSessionState.stopRequested) {
        runtimeSessionState.stopRequested = true;
        runtimeSessionState.isPaused = true;
        invoke('stop_generation');
        updateBatchButtons();
    } else if (runtimeSessionState.isPaused || runtimeSessionState.taskQueue.length > 0) {
        if (runtimeSessionState.taskQueue.length > 0 && runtimeSessionState.taskQueue[0].uid === runtimeSessionState.lastRanJobUid) {
            runtimeSessionState.taskQueue.shift();
            runtimeSessionState.lastRanJobUid = null;

            clearBatchWorkspace(updatePlotTokenCount, refreshNovelChapterJump);

            setNovelStatus("Stopped job cleared.");
            setBatchQueueCount(runtimeSessionState.taskQueue.length);
            if (runtimeSessionState.taskQueue.length === 0) {
                runtimeSessionState.isPaused = false;
            }
        } else {
            runtimeSessionState.reset({ clearStopRequested: !runtimeSessionState.isWorkerRunning });
            setBatchQueueCount(0);
            clearBatchWorkspace(updatePlotTokenCount, refreshNovelChapterJump);

            setNovelStatus("Queue cleared.");
        }
        updateBatchButtons();
    } else {
        runtimeSessionState.stopRequested = true;
        invoke('stop_generation');
    }
}

function applyGeneratedNovelState(result) {
    if (!result?.novelFilename) return;
    runtimeSessionState.setLoadedNovel(result.novelFilename, result.metadata || null);
}

function applyInterruptedNovelResult(result, refreshNovelChapterJump = null) {
    if (!result) return;
    if (typeof result.fullNovelText === 'string' && result.fullNovelText.length > 0) {
        setNovelText(result.fullNovelText);
        refreshNovelChapterJump?.();
    }
    applyGeneratedNovelState(result);
}

async function processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump }) {
    if (runtimeSessionState.isWorkerRunning) {
        runtimeSessionState.pendingProcessQueue = true;
        return;
    }
    runtimeSessionState.isWorkerRunning = true;
    runtimeViewStateStore.setActivity({ isNovelRunning: true });

    try {
        runtimeSessionState.pendingProcessQueue = false;
        runtimeSessionState.stopRequested = false;
        runtimeSessionState.isPaused = false;
        updateBatchButtons();

        while (runtimeSessionState.taskQueue.length > 0 && !runtimeSessionState.stopRequested) {
            setBatchQueueCount(runtimeSessionState.taskQueue.length);
            const job = runtimeSessionState.taskQueue[0];
            setBatchQueueCount(runtimeSessionState.taskQueue.length);

            if (job.type === 'batch') {
                await runBatchJob(job, { generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump });
            } else if (job.type === 'single') {
                await runSingleJob(job, { generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump });
            }

            if (!runtimeSessionState.stopRequested) {
                runtimeSessionState.taskQueue.shift();
                runtimeSessionState.lastRanJobUid = null;
            }
        }
    } catch (e) {
        console.error("[ProcessQueue] Error:", e);
        setNovelStatus("❌ Fatal Error: " + e.message);
        runtimeSessionState.isPaused = true;
    } finally {
        runtimeSessionState.isWorkerRunning = false;
        runtimeViewStateStore.setActivity({ isNovelRunning: false });
        setBatchQueueCount(runtimeSessionState.taskQueue.length);
        const shouldProcessPendingQueue = runtimeSessionState.pendingProcessQueue
            && runtimeSessionState.taskQueue.length > 0
            && !runtimeSessionState.isPaused;
        runtimeSessionState.pendingProcessQueue = false;

        const novelStatusMessage = getEditorSnapshot().novelStatus.message;
        if (!runtimeSessionState.isPaused) {
            if (!novelStatusMessage.includes("Error")) {
                setNovelStatus(runtimeSessionState.stopRequested ? '🛑 Stopped.' : '✅ Done');
            }
        } else if (!novelStatusMessage.includes("Error") && !novelStatusMessage.includes("Auto-resuming")) {
            setNovelStatus('⏸️ Paused.');
        }
        updateBatchButtons();

        if (shouldProcessPendingQueue) {
            runtimeSessionState.stopRequested = false;
            queueMicrotask(() => processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump }));
        }
    }
}

async function runSingleJob(job, { generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump }) {
    const { plotOutline, startChapter, totalChapters, targetTokens, lang, plotSeed } = job;
    const queueArgs = { generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump };
    let rateLimitRetryAttempt = null;

    if (startChapter === 1) {
        setNovelText("");
        refreshNovelChapterJump?.({ preserveValue: false });
        clearNovelRefineChapterRange();
        runtimeSessionState.clearLoadedNovel();
    }
    let initialText = "";
    let recentChapters = [];
    let storyState = '';
    let characterState = '';
    let relationshipState = '';
    let currentArc = '';
    let currentArcKeywords = [];
    let currentArcStartChapter = 1;
    let closedArcs = [];
    let expressionCooldown = [];
    let recentScenePatterns = [];
    let needsMemoryRebuild = false;
    let continuityFallbackCount = 0;
    let novelFilename = null;

    if (startChapter > 1) {
        setNovelStatus('Loading saved state...');
        try {
            let state = null;
            let loadedState = null;
            let stateSource = 'latest';

            if (runtimeSessionState.loadedNovelFilename) {
                loadedState = await loadNovelState(runtimeSessionState.loadedNovelFilename);
                state = loadedState;
                stateSource = 'loaded';
            }

            if (!state?.meta && !loadedState) {
                const latestState = await loadLatestNovelState();
                if (latestState?.meta) {
                    state = latestState;
                    stateSource = 'latest';
                }
            }

            if (state?.meta && metadataNextChapter(state.meta) === startChapter) {
                recentChapters = state.meta.recent_chapters || [];
                storyState = state.meta.story_state || '';
                characterState = state.meta.character_state || '';
                relationshipState = state.meta.relationship_state || '';
                currentArc = state.meta.current_arc || '';
                currentArcKeywords = state.meta.current_arc_keywords || [];
                currentArcStartChapter = state.meta.current_arc_start_chapter || 1;
                closedArcs = state.meta.closed_arcs || [];
                expressionCooldown = state.meta.expression_cooldown || [];
                recentScenePatterns = state.meta.recent_scene_patterns || [];
                needsMemoryRebuild = state.meta.needs_memory_rebuild === true;
                continuityFallbackCount = state.meta.continuity_fallback_count || 0;
                novelFilename = state.filename;
                initialText = state.text || getEditorSnapshot().novel;
                runtimeSessionState.setLoadedNovel(state.filename, state.meta);
                setActiveNovelFilename(state.filename);
                setNovelStatus('✅ Metadata loaded. Resuming...');
            } else if (stateSource === 'loaded' && loadedState?.filename) {
                novelFilename = loadedState.filename;
                initialText = getEditorSnapshot().novel || loadedState.text || '';
                runtimeSessionState.setLoadedNovel(loadedState.filename, loadedState.meta);
                setActiveNovelFilename(loadedState.filename);
                setNovelStatus('⚠️ Metadata mismatch, reconstructing from displayed text.');
            } else {
                initialText = getEditorSnapshot().novel;
            }
        } catch (_) {
            initialText = getEditorSnapshot().novel;
        }
    }

    initialText = getCleanedInitialText(initialText, lang, startChapter);

    try {
        job.canResumeNovelGeneration = true;
        const result = await generateNovel({
            startChapter, totalChapters, targetTokens, lang,
            plotOutline, initialText, novelFilename,
            recentChapters, storyState, characterState, relationshipState, currentArc, currentArcKeywords, currentArcStartChapter, closedArcs, expressionCooldown, recentScenePatterns, needsMemoryRebuild, continuityFallbackCount,
            onStatus: (msg) => { setNovelStatus(msg); },
            onChapterFinished: (ch) => {
                setNextChapter(Math.min(ch + 1, totalChapters + 1));
            },
            onContentUpdated: () => refreshNovelChapterJump?.(),
            onFilenameKnown: setActiveNovelFilename,
            stopSignal: () => runtimeSessionState.stopRequested,
            plotSeed: plotSeed
        });
        setNovelText(result.fullNovelText);
        refreshNovelChapterJump?.();
        applyGeneratedNovelState(result);
        job.canResumeNovelGeneration = false;
        job.rateLimitRetryLabel = null;
        await reloadNovelList?.();
    } catch (e) {
        const retryLabel = rateLimitRetryLabel(e);
        applyInterruptedNovelResult(e.generationResult, refreshNovelChapterJump);
        if (retryLabel) {
            rateLimitRetryAttempt = setRateLimitRetryState(job, retryLabel);
        } else {
            setNovelStatus(`❌ Error: ${e.message}`);
            runtimeSessionState.stopRequested = true;
            runtimeSessionState.isPaused = true;
        }
    }

    if (!runtimeSessionState.stopRequested && !runtimeSessionState.isPaused) {
        setNextChapter(1);
    } else {
        await detectNextChapter();
        if (rateLimitRetryAttempt) {
            scheduleRateLimitAutoResume(job, queueArgs, rateLimitRetryAttempt);
        }
    }
}

async function runBatchJob(job, { generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump }) {
    const queueArgs = { generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump };
    const isSameJob = job.uid === runtimeSessionState.lastRanJobUid;
    const canResumeDisplayedBatchNovel = isSameJob && job.startedNovelGeneration;
    runtimeSessionState.lastRanJobUid = job.uid;
    if (!isSameJob) {
        runtimeSessionState.clearActiveNovel();
    }

    const initialPlotOutline = getEditorSnapshot().plot.trim();
    let plotOutline = normalizePlotOutlineOutput(initialPlotOutline, { totalChapters: job.totalChapters });
    if (plotOutline !== initialPlotOutline) {
        setPlotText(plotOutline);
        updatePlotTokenCount();
    }
    const plotActuallyComplete = missingPlotChapters(plotOutline, job.totalChapters).length === 0;

    const lang = job.lang;
    const plotPrompt = buildPlotOutlinePrompt({
        seed: job.seed,
        language: lang,
        totalChapters: job.totalChapters,
    });

    if (!isSameJob || !plotOutline || !plotActuallyComplete) {
        if (!isSameJob || !plotActuallyComplete) {
            console.log("[Batch] New or incomplete job detected, clearing UI fields.");
            setPlotText("");
            setPlotStatusView("Idle", "idle");
            if (!job.preserveDisplayedNovelUntilGeneration) {
                setNovelText("");
                refreshNovelChapterJump?.({ preserveValue: false });
            }
            clearNovelRefineChapterRange();
            runtimeSessionState.clearLoadedNovel();
            updatePlotTokenCount();
        }

        setPlotStatusView('⏳ Generating...', 'generating');
        setNovelStatus(`[Batch] Generating plot (${runtimeSessionState.taskQueue.length} remaining)...`);
        let plotError = null;
        let generatedPlotThisRun = false;
        try {
            const apiParams = getRuntimeApiParams();
            if (shouldGeneratePlotInChunks(job.totalChapters)) {
                plotOutline = await generatePlotOutlineInChunks({
                    seed: job.seed,
                    language: lang,
                    totalChapters: job.totalChapters,
                    apiParams,
                    shouldStop: () => runtimeSessionState.stopRequested,
                    onStatus: (msg) => {
                        const cleanMsg = msg.replace(/^⏳\s*/, '');
                        setNovelStatus(`[Batch] ${cleanMsg}`);
                        setPlotStatusView(msg, msg.includes('Stopped') || msg.includes('🛑') ? 'cancelled' : 'generating');
                    },
                    onUpdate: (text) => {
                        plotOutline = normalizePlotOutlineOutput(text, { totalChapters: job.totalChapters });
                        setPlotText(plotOutline);
                        updatePlotTokenCount();
                    }
                });
            } else {
                await generatePlotStream({
                    ...apiParams,
                    prompt: plotPrompt,
                    maxTokens: 8192,
                }, (ev) => {
                    if (ev.error) {
                        plotError = ev.error;
                        setPlotStatusView('❌ Error', 'error');
                    }
                    if (!ev.is_finished && !ev.error && ev.status) {
                        setPlotStatusView(ev.status, 'generating');
                        setNovelStatus(`[Batch] ${ev.status}`);
                    }
                    plotOutline = ev.content;
                    setPlotText(plotOutline);
                    updatePlotTokenCount();
                });
            }
            if (runtimeSessionState.stopRequested) {
                setPlotStatusView('🛑 Stopped', 'cancelled');
                return;
            }
            generatedPlotThisRun = true;
        } catch (e) {
            plotError = e.message || e.toString();
        }

        if (!plotError && generatedPlotThisRun) {
            plotOutline = normalizePlotOutlineOutput(plotOutline, { totalChapters: job.totalChapters });
            setPlotText(plotOutline);
            updatePlotTokenCount();

            const missingGeneratedChapters = missingPlotChapters(plotOutline, job.totalChapters);
            if (missingGeneratedChapters.length > 0) {
                plotError = `Generated plot is incomplete. Missing chapters: ${missingGeneratedChapters.join(', ')}. Please retry before novel generation.`;
            } else {
                setPlotStatusView('✅ Done', 'completed');
            }
        }

        if (plotError) {
            setNovelStatus(`[Batch] Plot Error: ${plotError}`);
            setPlotStatusView(`❌ Error: ${plotError}`, 'error');
            setPlotText("");
            updatePlotTokenCount();
            runtimeSessionState.stopRequested = true;
            runtimeSessionState.isPaused = true;
            return;
        }
    } else {
        setNovelStatus(`[Batch] Resuming from existing plot (${runtimeSessionState.taskQueue.length} remaining)...`);
        setPlotStatusView('✅ Done', 'completed');
    }

    if (runtimeSessionState.stopRequested) return;

    if (job.autoRefinePlot && !job.plotRefineFinished && !runtimeSessionState.stopRequested) {
        const preRefinePlot = plotOutline;
        job.lastRefinedPlotPart = 0;
        try {
            let refineInstructions = runtimeViewStateStore.getSnapshot().refineInstructions.plot.trim();
            if (job.autoRefinePlotInstructions) {
                setNovelStatus(`[Batch] Generating Auto Instructions...`);
                setPlotStatusView(`⏳ Auto Instructions...`, 'refining');
                const apiParams = getRuntimeApiParams();
                const autoInstructionsResult = await generatePlotAutoInstructions({
                    lang,
                    plotOutline,
                    apiParams: {
                        apiBase: apiParams.apiBase,
                        modelName: apiParams.modelName,
                        apiKey: apiParams.apiKey,
                    }
                });
                refineInstructions = autoInstructionsResult;

                runtimeViewStateStore.setRefineInstructions({ plot: autoInstructionsResult });
            }

            setNovelStatus(`[Batch] Refining plot before novel generation...`);
            setPlotStatusView(`⏳ Refining...`, 'refining');
            plotOutline = await refinePlotTextInChunks({
                originalPlot: plotOutline,
                lang,
                totalChapters: job.totalChapters,
                refineInstructions,
                startPart: job.lastRefinedPlotPart ? job.lastRefinedPlotPart + 1 : 1,
                onStatus: (msg) => {
                    const cleanMsg = msg.replace(/^⏳\s*/, '');
                    setNovelStatus(`[Batch] ${cleanMsg}`);
                    if (msg === "✅ Done") {
                        setPlotStatusView("✅ Done", 'completed');
                    } else if (msg.includes("Error") || msg.includes("❌")) {
                        setPlotStatusView(cleanMsg, 'error');
                    } else if (msg.includes("Stopped") || msg.includes("🛑")) {
                        setPlotStatusView(cleanMsg, 'cancelled');
                    } else {
                        setPlotStatusView(msg, 'refining');
                    }
                },
                onPartFinished: (p) => { job.lastRefinedPlotPart = p; },
                onUpdate: (text) => {
                    setPlotText(normalizePlotOutlineOutput(text, { totalChapters: job.totalChapters }));
                    updatePlotTokenCount();
                }
            });
            plotOutline = normalizePlotOutlineOutput(plotOutline, { totalChapters: job.totalChapters });
            setPlotText(plotOutline);
            updatePlotTokenCount();
            assertCompletePlotOutline(plotOutline, job.totalChapters, 'Refined plot outline');
            setPlotStatusView("✅ Done", 'completed');
            setNovelStatus(`[Batch] ✅ Plot refine done`);
            job.lastRefinedPlotPart = 0;
        } catch (e) {
            setPlotText(normalizePlotOutlineOutput(preRefinePlot, { totalChapters: job.totalChapters }));
            updatePlotTokenCount();
            setPlotStatusView(`❌ Error: ${e.message || e}`, 'error');
            setNovelStatus(`[Batch] Plot Refine Error: ${e.message || e}`);
            showToast(`[Batch] Plot refine failed: ${e.message || e}`, 'error');
            runtimeSessionState.stopRequested = true;
            runtimeSessionState.isPaused = true;
            job.lastRefinedPlotPart = 0;
            return;
        }

        if (runtimeSessionState.stopRequested) {
            setPlotText(normalizePlotOutlineOutput(preRefinePlot, { totalChapters: job.totalChapters }));
            updatePlotTokenCount();
            setPlotStatusView("🛑 Stopped", 'cancelled');
            // Reset plot refinement progress so it starts over on resume if restored to original
            job.lastRefinedPlotPart = 0;
        } else {
            job.plotRefineFinished = true;
            setPlotStatusView("✅ Done", 'completed');
        }
    }

    if (runtimeSessionState.stopRequested) return;

    plotOutline = normalizePlotOutlineOutput(plotOutline, { totalChapters: job.totalChapters });
    setPlotText(plotOutline);
    updatePlotTokenCount();
    setPlotStatusView("✅ Done", 'completed');

    try {
        assertCompletePlotOutline(plotOutline, job.totalChapters, 'Plot outline before novel generation');
    } catch (e) {
        setNovelStatus(`[Batch] Plot Error: ${e.message || e}`);
        showToast(`[Batch] Plot incomplete: ${e.message || e}`, 'error');
        runtimeSessionState.stopRequested = true;
        runtimeSessionState.isPaused = true;
        return;
    }

    let currentText = canResumeDisplayedBatchNovel ? getEditorSnapshot().novel : '';
    if (!currentText) {
        refreshNovelChapterJump?.();
    }
    let completedNovelFilename = null;
    let safetyLimit = 0;
    let rateLimitRetryAttempt = null;

    while (true) {
        let lastCompleted = null;
        let recentChapters = [];
        let storyState = '';
        let characterState = '';
        let relationshipState = '';
        let currentArc = '';
        let currentArcKeywords = [];
        let currentArcStartChapter = 1;
        let closedArcs = [];
        let expressionCooldown = [];
        let recentScenePatterns = [];
        let needsMemoryRebuild = false;
        let continuityFallbackCount = 0;
        let novelFilename = null;

        if (isSameJob) {
            try {
                const metaResult = await invoke('get_latest_novel_metadata');
                if (metaResult) {
                    const [fname, jsonStr] = metaResult;
                    const meta = JSON.parse(jsonStr);
                    lastCompleted = meta.current_chapter;
                    recentChapters = meta.recent_chapters || [];
                    storyState = meta.story_state || '';
                    characterState = meta.character_state || '';
                    relationshipState = meta.relationship_state || '';
                    currentArc = meta.current_arc || '';
                    currentArcKeywords = meta.current_arc_keywords || [];
                    currentArcStartChapter = meta.current_arc_start_chapter || 1;
                    closedArcs = meta.closed_arcs || [];
                    expressionCooldown = meta.expression_cooldown || [];
                    recentScenePatterns = meta.recent_scene_patterns || [];
                    needsMemoryRebuild = meta.needs_memory_rebuild === true;
                    continuityFallbackCount = meta.continuity_fallback_count || 0;
                    novelFilename = fname;
                    setActiveNovelFilename(fname);
                }
            } catch (e) {
                console.warn("[Batch] Failed to load metadata for resumption:", e);
            }
        }

        const nextCh = await invoke('suggest_next_chapter', {
            text: currentText,
            language: lang,
            last_completed_ch: lastCompleted
        });
        if (nextCh > job.totalChapters || runtimeSessionState.stopRequested) break;
        if (safetyLimit++ > job.totalChapters + 3) break;

        currentText = getCleanedInitialText(currentText, lang, nextCh);

        try {
            if (!job.startedNovelGeneration) {
                job.startedNovelGeneration = true;
                job.preserveDisplayedNovelUntilGeneration = false;
                setNovelText('');
                refreshNovelChapterJump?.({ preserveValue: false });
            }
            job.canResumeNovelGeneration = true;
            const result = await generateNovel({
                startChapter: nextCh, totalChapters: job.totalChapters,
                targetTokens: job.targetTokens, lang,
                plotOutline, initialText: currentText,
                novelFilename,
                recentChapters, storyState, characterState, relationshipState, currentArc, currentArcKeywords, currentArcStartChapter, closedArcs, expressionCooldown, recentScenePatterns, needsMemoryRebuild, continuityFallbackCount,
                onStatus: (msg) => { setNovelStatus(`[Batch] ${msg}`); },
                onChapterFinished: (ch) => {
                    setNextChapter(Math.min(ch + 1, job.totalChapters + 1));
                },
                onContentUpdated: () => refreshNovelChapterJump?.(),
                onFilenameKnown: setActiveNovelFilename,
                stopSignal: () => runtimeSessionState.stopRequested,
                plotSeed: job.seed
            });
            currentText = result.fullNovelText;
            novelFilename = result.novelFilename || novelFilename;
            completedNovelFilename = novelFilename;
            applyGeneratedNovelState(result);
            setNovelText(currentText);
            refreshNovelChapterJump?.();
        } catch (e) {
            const retryLabel = rateLimitRetryLabel(e);
            applyInterruptedNovelResult(e.generationResult, refreshNovelChapterJump);
            if (typeof e.generationResult?.fullNovelText === 'string') {
                currentText = e.generationResult.fullNovelText;
            }
            if (retryLabel) {
                rateLimitRetryAttempt = setRateLimitRetryState(job, retryLabel);
            } else {
                setNovelStatus(`[Batch] Error: ${e.message}`);
                runtimeSessionState.stopRequested = true;
                runtimeSessionState.isPaused = true;
            }
            break;
        }

        const nextAfter = await invoke('suggest_next_chapter', {
            text: currentText,
            language: lang,
            last_completed_ch: null
        });
        if (nextAfter <= nextCh && !runtimeSessionState.stopRequested) {
            setNovelStatus(`[Batch] Error: Generation stalled at chapter ${nextCh}. No new chapter header detected in text.`);
            runtimeSessionState.stopRequested = true;
            runtimeSessionState.isPaused = true;
            break;
        }
    }

    if (!runtimeSessionState.stopRequested && !runtimeSessionState.isPaused) {
        job.canResumeNovelGeneration = false;
        job.rateLimitRetryLabel = null;
        if (job.autoRefineNovel && !job.novelRefineFinished && currentText.trim()) {
            try {
                setNovelStatus(`[Batch] Refining novel...`);
                const apiParams = getRuntimeApiParams();
                const refined = await refineNovelTextInChapters({
                    originalNovel: currentText,
                    plotOutline,
                    lang,
                    totalChapters: job.totalChapters,
                    userInstructions: runtimeViewStateStore.getSnapshot().refineInstructions.novel.trim(),
                    chapterRange: (job.lastRefinedChapter && job.lastRefinedChapter < job.totalChapters)
                        ? { start: job.lastRefinedChapter + 1, end: null }
                        : null,
                    statusPrefix: '[Batch]',
                    detectNextChapter,
                    apiParams: {
                        apiBase: apiParams.apiBase,
                        modelName: apiParams.modelName,
                        apiKey: apiParams.apiKey,
                    },
                    autoInstructionsPerChapter: job.autoRefineNovelInstructions,
                    onChapterFinished: (ch) => { job.lastRefinedChapter = ch; },
                });
                if (refined?.fullText) {
                    currentText = refined.fullText;
                    completedNovelFilename = refined.filename || completedNovelFilename;
                    setActiveNovelFilename(completedNovelFilename);
                    setNovelText(currentText);
                    refreshNovelChapterJump?.();
                    setNovelStatus(`[Batch] ✅ Novel refine done`);
                    job.novelRefineFinished = true;
                }
            } catch (e) {
                setNovelStatus(`[Batch] Novel Refine Error: ${e.message || e}`);
                runtimeSessionState.stopRequested = true;
                runtimeSessionState.isPaused = true;
                return;
            }
        }

        if (runtimeSessionState.stopRequested || runtimeSessionState.isPaused) {
            await detectNextChapter();
            return;
        }

        await reloadNovelList?.();
        setNextChapter(1);
    } else {
        await detectNextChapter();
        if (rateLimitRetryAttempt) {
            scheduleRateLimitAutoResume(job, queueArgs, rateLimitRetryAttempt);
        }
    }
}
