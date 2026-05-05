import { runtimeSessionState } from '../services/runtimeSessionStateService.js';
import { loadLatestNovelState, loadNovelState, metadataNextChapter } from './novel_storage.js';
import { clearNovelRefineChapterRange, refineNovelTextInChapters } from './novel_refine.js';
import { generatePlotAutoInstructions } from './plot_auto.js';
import { normalizePlotOutlineOutput, refinePlotTextInChunks } from './plot_refine.js';
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
import { Channel, invoke } from './tauri_api.js';
import { showToast } from './toast.js';
import {
    assertCompletePlotOutline,
    getCleanedInitialText,
    getChapterDesignInstruction,
    getPlotArcInstruction,
    missingPlotChapters,
} from './text_utils.js';

export function updateBatchButtons() {
    if (runtimeSessionState.isPaused && runtimeSessionState.taskQueue.length > 0) {
        runtimeViewStateStore.setActivity({
            batchStartLabel: "▶️ Resume",
            batchStopLabel: runtimeSessionState.taskQueue[0].uid === runtimeSessionState.lastRanJobUid
                ? "🗑️ Clear Stopped"
                : "🗑️ All Clear",
            isBatchResume: true,
        });
    } else {
        runtimeViewStateStore.setActivity({
            batchStartLabel: "🚀 Batch Start",
            batchStopLabel: "⏹️ Stop Queue",
            isBatchResume: false,
        });
    }
}

function setBatchQueueCount(queueCount) {
    runtimeViewStateStore.setActivity({ batchQueueCount: queueCount });
}

function clearBatchWorkspace(updatePlotTokenCount, refreshNovelChapterJump = null) {
    setPlotText("");
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

    runtimeSessionState.taskQueue.push({
        uid: Date.now() + Math.random(),
        type: 'single',
        plotOutline: normalizedPlot,
        startChapter: parseInt(editor.nextChapter) || 1,
        totalChapters,
        targetTokens: getTargetTokensParam(2000),
        lang: getLang(),
        plotSeed: editor.seed
    });

    setBatchQueueCount(runtimeSessionState.taskQueue.length);
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

    if (runtimeSessionState.isPaused && runtimeSessionState.taskQueue.length > 0) {
        if (runtimeSessionState.isWorkerRunning && runtimeSessionState.stopRequested) {
            runtimeSessionState.isPaused = false;
            runtimeSessionState.pendingProcessQueue = true;
            updateBatchButtons();
            return;
        }

        runtimeSessionState.isPaused = false;
        runtimeSessionState.stopRequested = false;
        await invoke('resume_generation');

        updateBatchButtons();
        processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump });
        return;
    }

    if (runtimeSessionState.isPaused) {
        runtimeSessionState.isPaused = false;
        runtimeSessionState.stopRequested = false;
        updateBatchButtons();
    }

    const count = parseInt(runtimeViewStateStore.getSnapshot().batchSettings.batchCount, 10) || 1;
    const batchSettings = runtimeViewStateStore.getSnapshot().batchSettings;
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
        });
    }
    setBatchQueueCount(runtimeSessionState.taskQueue.length);
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
                await runSingleJob(job, { generateNovel, detectNextChapter, reloadNovelList, refreshNovelChapterJump });
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

        if (!runtimeSessionState.isPaused) {
            if (!getEditorSnapshot().novelStatus.message.includes("Error")) {
                setNovelStatus(runtimeSessionState.stopRequested ? '🛑 Stopped.' : '✅ Done');
            }
        } else if (!getEditorSnapshot().novelStatus.message.includes("Error")) {
            setNovelStatus('⏸️ Paused.');
        }
        updateBatchButtons();

        if (shouldProcessPendingQueue) {
            runtimeSessionState.stopRequested = false;
            queueMicrotask(() => processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump }));
        }
    }
}

async function runSingleJob(job, { generateNovel, detectNextChapter, reloadNovelList, refreshNovelChapterJump }) {
    const { plotOutline, startChapter, totalChapters, targetTokens, lang, plotSeed } = job;

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
        await reloadNovelList?.();
    } catch (e) {
        applyGeneratedNovelState(e.generationResult);
        setNovelStatus(`❌ Error: ${e.message}`);
        runtimeSessionState.stopRequested = true;
    }

    if (!runtimeSessionState.stopRequested && !runtimeSessionState.isPaused) {
        setNextChapter(1);
    } else {
        await detectNextChapter();
    }
}

async function runBatchJob(job, { generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList, refreshNovelChapterJump }) {
    const isSameJob = job.uid === runtimeSessionState.lastRanJobUid;
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
    const h = lang === 'Korean' ? [
        '1. 제목', '2. 핵심 주제의식과 소설 스타일', '3. 등장인물 이름, 설정', '4. 세계관 설정',
        '5. 각 장 제목과 내용, 핵심 포인트 (Include clear markers like \'제 1장\', \'제 2장\', etc.)'
    ] : lang === 'Japanese' ? [
        '1. タイトル', '2. 核心となるテーマと小説のスタイル', '3. 登場人物の名前・設定', '4. 世界観設定',
        '5. 各章のタイトルと内容、重要ポイント (Include clear markers like \'第 1 章\', \'第 2 章\', etc.)'
    ] : [
        '1. Title', '2. Core Theme and Novel Style', '3. Character Names and Settings',
        '4. World Building/Setting',
        '5. Chapter Titles, Content, and Key Points (Include clear markers like \'Chapter 1\', \'Chapter 2\', etc.)'
    ];
    const arcInstruction = getPlotArcInstruction(lang, job.totalChapters);
    const chapterDesignInstruction = getChapterDesignInstruction(lang);

    const plotPrompt = `Based on the following seed, create a detailed plot outline for a ${job.totalChapters}-chapter novel in ${lang}.\nSeed: ${job.seed}\n\nFORMAT INSTRUCTIONS:\nPlease organize the output into the following 5 sections in ${lang}:\n${h.join('\n')}\n${arcInstruction}\n${chapterDesignInstruction}\nEnsure every section is detailed. Output ONLY the plot outline based on this format, without any greetings, meta-commentary.`;

    if (!isSameJob || !plotOutline || !plotActuallyComplete) {
        if (!isSameJob || !plotActuallyComplete) {
            console.log("[Batch] New or incomplete job detected, clearing UI fields.");
            setPlotText("");
            setNovelText("");
            clearNovelRefineChapterRange();
            runtimeSessionState.clearLoadedNovel();
            updatePlotTokenCount();
        }

        setNovelStatus(`[Batch] Generating plot (${runtimeSessionState.taskQueue.length} remaining)...`);
        let plotError = null;
        let generatedPlotThisRun = false;
        const plotChannel = new Channel();
        plotChannel.onmessage = (ev) => {
            if (ev.error) plotError = ev.error;
            plotOutline = ev.content;
            setPlotText(plotOutline);
            updatePlotTokenCount();
        };

        try {
            const apiParams = getRuntimeApiParams();
            await invoke('generate_plot', {
                params: {
                    api_base: apiParams.apiBase,
                    model_name: apiParams.modelName,
                    api_key: apiParams.apiKey,
                    system_prompt: apiParams.systemPrompt,
                    prompt: plotPrompt,
                    temperature: apiParams.temperature,
                    top_p: apiParams.topP,
                    repetition_penalty: apiParams.repetitionPenalty,
                    max_tokens: 8192
                },
                onEvent: plotChannel
            });
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
            }
        }

        if (plotError) {
            setNovelStatus(`[Batch] Plot Error: ${plotError}`);
            setPlotText("");
            updatePlotTokenCount();
            runtimeSessionState.stopRequested = true;
            runtimeSessionState.isPaused = true;
            return;
        }
    } else {
        setNovelStatus(`[Batch] Resuming from existing plot (${runtimeSessionState.taskQueue.length} remaining)...`);
    }

    if (runtimeSessionState.stopRequested) return;

    if (job.autoRefinePlot && !job.plotRefineFinished && !runtimeSessionState.stopRequested) {
        const preRefinePlot = plotOutline;
        job.lastRefinedPlotPart = 0;
        try {
            let refineInstructions = runtimeViewStateStore.getSnapshot().refineInstructions.plot.trim();
            if (job.autoRefinePlotInstructions) {
                setNovelStatus(`[Batch] Generating Auto Instructions...`);
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
            plotOutline = await refinePlotTextInChunks({
                originalPlot: plotOutline,
                lang,
                totalChapters: job.totalChapters,
                refineInstructions,
                startPart: job.lastRefinedPlotPart ? job.lastRefinedPlotPart + 1 : 1,
                onStatus: (msg) => {
                    setNovelStatus(`[Batch] ${msg.replace(/^⏳\s*/, '')}`);
                    if (msg === "✅ Done") {
                        setPlotStatusView("✅ Done", 'completed');
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
            setPlotStatusView("❌ Error", 'error');
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
            // Reset plot refinement progress so it starts over on resume if restored to original
            job.lastRefinedPlotPart = 0;
        } else {
            job.plotRefineFinished = true;
        }
    }

    if (runtimeSessionState.stopRequested) return;

    plotOutline = normalizePlotOutlineOutput(plotOutline, { totalChapters: job.totalChapters });
    setPlotText(plotOutline);
    updatePlotTokenCount();

    try {
        assertCompletePlotOutline(plotOutline, job.totalChapters, 'Plot outline before novel generation');
    } catch (e) {
        setNovelStatus(`[Batch] Plot Error: ${e.message || e}`);
        showToast(`[Batch] Plot incomplete: ${e.message || e}`, 'error');
        runtimeSessionState.stopRequested = true;
        runtimeSessionState.isPaused = true;
        return;
    }

    let currentText = getEditorSnapshot().novel;
    if (!currentText) {
        setNovelText('');
    }
    let completedNovelFilename = null;
    let safetyLimit = 0;

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
            applyGeneratedNovelState(e.generationResult);
            setNovelStatus(`[Batch] Error: ${e.message}`);
            runtimeSessionState.stopRequested = true;
            runtimeSessionState.isPaused = true;
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
    }
}
