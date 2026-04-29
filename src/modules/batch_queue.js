import { AppState } from './app_state.js';
import { els } from './dom_refs.js';
import { loadLatestNovelState, loadNovelState, metadataNextChapter } from './novel_storage.js';
import { clearNovelRefineChapterRange, refineNovelTextInChapters } from './novel_refine.js';
import { refinePlotTextInChunks } from './plot_refine.js';
import { renderMarkdown, schedulePreviewRender } from './preview.js';
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
    if (AppState.isPaused && AppState.taskQueue.length > 0) {
        els.batchStartBtn.innerText = "▶️ Resume";
        els.batchStartBtn.classList.add('btn-resume');

        if (AppState.taskQueue[0].uid === AppState.lastRanJobUid) {
            els.batchStopBtn.innerText = "🗑️ Clear Stopped";
        } else {
            els.batchStopBtn.innerText = "🗑️ All Clear";
        }
    } else {
        els.batchStartBtn.innerText = "🚀 Batch Start";
        els.batchStartBtn.classList.remove('btn-resume');
        els.batchStopBtn.innerText = "⏹️ Stop Queue";
    }
}

function clearBatchWorkspace(updatePlotTokenCount) {
    els.plotContent.value = "";
    els.novelContent.value = "";
    els.novelContent.dispatchEvent(new Event('input', { bubbles: true }));
    els.novelContent.dispatchEvent(new CustomEvent('novel-content-updated', { bubbles: true }));
    if (els.resumeCh) els.resumeCh.value = 1;
    clearNovelRefineChapterRange();
    if (els.plotRefineInstructions) els.plotRefineInstructions.value = "";
    if (els.novelRefineInstructions) els.novelRefineInstructions.value = "";

    AppState.clearLoadedNovel();
    updatePlotTokenCount();
    renderMarkdown(els.plotContent.id);
    renderMarkdown(els.novelContent.id);
}

function getCurrentNovelStatusFilename(fallback = null) {
    return fallback || AppState.activeNovelFilename || AppState.loadedNovelFilename || null;
}

function formatNovelStatus(message, filename = null) {
    const currentFilename = getCurrentNovelStatusFilename(filename);
    const cleanMessage = String(message || '').replace(/\s+\([^()]+\.txt\)$/, '');
    return currentFilename ? `${cleanMessage} (${currentFilename})` : cleanMessage;
}

function setNovelStatus(message, filename = null) {
    els.novelStatus.innerText = formatNovelStatus(message, filename);
}

function setActiveNovelFilename(filename) {
    if (!filename) return;
    AppState.setActiveNovel(filename);
    if (els.novelStatus?.innerText) {
        setNovelStatus(els.novelStatus.innerText, filename);
    }
}

export function requestNovelStop() {
    if (AppState.isNovelRefining && !AppState.stopRequested) {
        AppState.stopRequested = true;
        setNovelStatus('Stopping refine...');
        invoke('stop_generation');
        return;
    }

    if (AppState.isWorkerRunning && !AppState.stopRequested) {
        AppState.stopRequested = true;
        AppState.isPaused = true;
        invoke('stop_generation');
        updateBatchButtons();
    } else {
        AppState.stopRequested = true;
        invoke('stop_generation');
    }
}

export function startSingleNovelJob({ getLang, generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList }) {
    if (AppState.isNovelRefining) {
        showToast('Novel refine is already running.', 'warning');
        return;
    }

    if (!els.plotContent.value.trim()) {
        showToast('Plot is empty! Generate a plot outline first.', 'warning');
        return;
    }

    const totalChapters = parseInt(els.numChap.value) || 0;
    const missingChapters = missingPlotChapters(els.plotContent.value, totalChapters);
    if (missingChapters.length > 0) {
        showToast(`Plot is incomplete. Missing chapters: ${missingChapters.join(', ')}`, 'error');
        return;
    }

    if (AppState.isPaused || (!AppState.isWorkerRunning && AppState.taskQueue.length > 0)) {
        AppState.reset();
        updateBatchButtons();
    }

    AppState.taskQueue.push({
        uid: Date.now() + Math.random(),
        type: 'single',
        plotOutline: els.plotContent.value,
        startChapter: parseInt(els.resumeCh.value) || 1,
        totalChapters,
        targetTokens: parseInt(els.targetTokens.value),
        lang: getLang(),
        plotSeed: els.seedBox.value
    });

    els.queueCount.value = AppState.taskQueue.length;
    processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList });
}

export async function startOrResumeBatchQueue({
    getLang,
    generateNovel,
    detectNextChapter,
    updatePlotTokenCount,
    reloadNovelList,
}) {
    if (AppState.isNovelRefining) {
        showToast('Novel refine is already running.', 'warning');
        return;
    }

    if (AppState.isPaused && AppState.taskQueue.length > 0) {
        if (AppState.isWorkerRunning && AppState.stopRequested) {
            AppState.isPaused = false;
            AppState.pendingProcessQueue = true;
            updateBatchButtons();
            return;
        }

        AppState.isPaused = false;
        AppState.stopRequested = false;
        await invoke('resume_generation');

        updateBatchButtons();
        processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList });
        return;
    }

    if (AppState.isPaused) {
        AppState.isPaused = false;
        AppState.stopRequested = false;
        updateBatchButtons();
    }

    const count = parseInt(els.batchCount.value) || 1;
    for (let i = 0; i < count; i++) {
        AppState.taskQueue.push({
            uid: Date.now() + Math.random(),
            type: 'batch',
            seed: els.seedBox.value,
            totalChapters: parseInt(els.numChap.value),
            targetTokens: parseInt(els.targetTokens.value),
            lang: getLang(),
            autoRefinePlot: els.batchAutoRefinePlot?.checked === true,
            autoRefinePlot2Pass: els.batchAutoRefinePlot2Pass?.checked === true,
            autoRefineNovel: els.batchAutoRefineNovel?.checked === true,
            autoRefineNovelInstructions: els.batchAutoRefineNovelInstructions?.checked === true,
            plotRefineFinished: false,
            novelRefineFinished: false,
            lastRefinedPlotPart: 0,
            lastRefinedChapter: 0,
        });
    }
    els.queueCount.value = AppState.taskQueue.length;
    processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList });
}

export function stopOrClearBatchQueue({ updatePlotTokenCount }) {
    if (AppState.isWorkerRunning && !AppState.stopRequested) {
        AppState.stopRequested = true;
        AppState.isPaused = true;
        invoke('stop_generation');
        updateBatchButtons();
    } else if (AppState.isPaused || AppState.taskQueue.length > 0) {
        if (AppState.taskQueue.length > 0 && AppState.taskQueue[0].uid === AppState.lastRanJobUid) {
            AppState.taskQueue.shift();
            AppState.lastRanJobUid = null;

            clearBatchWorkspace(updatePlotTokenCount);

            setNovelStatus("Stopped job cleared.");
            els.queueCount.value = AppState.taskQueue.length;
            if (AppState.taskQueue.length === 0) {
                AppState.isPaused = false;
            }
        } else {
            AppState.reset({ clearStopRequested: !AppState.isWorkerRunning });
            els.queueCount.value = 0;
            clearBatchWorkspace(updatePlotTokenCount);

            setNovelStatus("Queue cleared.");
        }
        updateBatchButtons();
    } else {
        AppState.stopRequested = true;
        invoke('stop_generation');
    }
}

function applyGeneratedNovelState(result) {
    if (!result?.novelFilename) return;
    AppState.setLoadedNovel(result.novelFilename, result.metadata || null);
}

async function processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList }) {
    if (AppState.isWorkerRunning) {
        AppState.pendingProcessQueue = true;
        return;
    }
    AppState.isWorkerRunning = true;

    try {
        AppState.pendingProcessQueue = false;
        AppState.stopRequested = false;
        AppState.isPaused = false;
        updateBatchButtons();

        while (AppState.taskQueue.length > 0 && !AppState.stopRequested) {
            els.queueCount.value = AppState.taskQueue.length;
            const job = AppState.taskQueue[0];
            els.queueCount.value = AppState.taskQueue.length;

            if (job.type === 'batch') {
                await runBatchJob(job, { generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList });
            } else if (job.type === 'single') {
                await runSingleJob(job, { generateNovel, detectNextChapter, reloadNovelList });
            }

            if (!AppState.stopRequested) {
                AppState.taskQueue.shift();
                AppState.lastRanJobUid = null;
            }
        }
    } catch (e) {
        console.error("[ProcessQueue] Error:", e);
        setNovelStatus("❌ Fatal Error: " + e.message);
        AppState.isPaused = true;
    } finally {
        AppState.isWorkerRunning = false;
        els.queueCount.value = AppState.taskQueue.length;
        const shouldProcessPendingQueue = AppState.pendingProcessQueue
            && AppState.taskQueue.length > 0
            && !AppState.isPaused;
        AppState.pendingProcessQueue = false;

        if (!AppState.isPaused) {
            if (!els.novelStatus.innerText.includes("Error")) {
                setNovelStatus(AppState.stopRequested ? '🛑 Stopped.' : '✅ Done');
            }
        } else if (!els.novelStatus.innerText.includes("Error")) {
            setNovelStatus('⏸️ Paused.');
        }
        updateBatchButtons();

        if (shouldProcessPendingQueue) {
            AppState.stopRequested = false;
            queueMicrotask(() => processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList }));
        }
    }
}

async function runSingleJob(job, { generateNovel, detectNextChapter, reloadNovelList }) {
    const { plotOutline, startChapter, totalChapters, targetTokens, lang, plotSeed } = job;

    if (startChapter === 1) {
        els.novelContent.value = "";
        els.novelContent.dispatchEvent(new Event('input', { bubbles: true }));
        els.novelContent.dispatchEvent(new CustomEvent('novel-content-updated', { bubbles: true }));
        clearNovelRefineChapterRange();
        renderMarkdown(els.novelContent.id);
        AppState.clearLoadedNovel();
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

            if (AppState.loadedNovelFilename) {
                loadedState = await loadNovelState(AppState.loadedNovelFilename);
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
                initialText = state.text || els.novelContent.value;
                AppState.setLoadedNovel(state.filename, state.meta);
                setActiveNovelFilename(state.filename);
                setNovelStatus('✅ Metadata loaded. Resuming...');
            } else if (stateSource === 'loaded' && loadedState?.filename) {
                novelFilename = loadedState.filename;
                initialText = els.novelContent.value || loadedState.text || '';
                AppState.setLoadedNovel(loadedState.filename, loadedState.meta);
                setActiveNovelFilename(loadedState.filename);
                setNovelStatus('⚠️ Metadata mismatch, reconstructing from displayed text.');
            } else {
                initialText = els.novelContent.value;
            }
        } catch (_) {
            initialText = els.novelContent.value;
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
                if (els.resumeCh) els.resumeCh.value = Math.min(ch + 1, totalChapters + 1);
            },
            onFilenameKnown: setActiveNovelFilename,
            stopSignal: () => AppState.stopRequested,
            plotSeed: plotSeed
        });
        els.novelContent.value = result.fullNovelText;
        els.novelContent.dispatchEvent(new CustomEvent('novel-content-updated', { bubbles: true }));
        applyGeneratedNovelState(result);
        await reloadNovelList?.();
    } catch (e) {
        applyGeneratedNovelState(e.generationResult);
        setNovelStatus(`❌ Error: ${e.message}`);
        AppState.stopRequested = true;
    }

    if (!AppState.stopRequested && !AppState.isPaused) {
        els.resumeCh.value = 1;
    } else {
        await detectNextChapter();
    }
}

async function runBatchJob(job, { generateNovel, detectNextChapter, updatePlotTokenCount, reloadNovelList }) {
    const isSameJob = job.uid === AppState.lastRanJobUid;
    AppState.lastRanJobUid = job.uid;
    if (!isSameJob) {
        AppState.clearActiveNovel();
    }

    let plotOutline = els.plotContent.value.trim();
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
            els.plotContent.value = "";
            els.novelContent.value = "";
            clearNovelRefineChapterRange();
            AppState.clearLoadedNovel();
            updatePlotTokenCount();
            renderMarkdown(els.plotContent.id);
            renderMarkdown(els.novelContent.id);
        }

        setNovelStatus(`[Batch] Generating plot (${AppState.taskQueue.length} remaining)...`);
        let plotError = null;
        let generatedPlotThisRun = false;
        const plotChannel = new Channel();
        plotChannel.onmessage = (ev) => {
            if (ev.error) plotError = ev.error;
            plotOutline = ev.content;
            els.plotContent.value = plotOutline;
            updatePlotTokenCount();
            schedulePreviewRender(els.plotContent.id, {
                source: 'stream',
                force: ev.is_finished || Boolean(ev.error),
                immediate: ev.is_finished || Boolean(ev.error)
            });
        };

        try {
            await invoke('generate_plot', {
                params: {
                    api_base: els.apiBase.value, model_name: els.modelName.value,
                    api_key: els.apiKeyBox.value || 'lm-studio',
                    system_prompt: els.promptBox.value, prompt: plotPrompt,
                    temperature: parseFloat(els.temp.value),
                    top_p: parseFloat(els.topP.value),
                    repetition_penalty: parseFloat(els.repetitionPenalty.value),
                    max_tokens: 8192
                },
                onEvent: plotChannel
            });
            generatedPlotThisRun = true;
        } catch (e) {
            plotError = e.message || e.toString();
        }

        if (!plotError && generatedPlotThisRun) {
            const missingGeneratedChapters = missingPlotChapters(plotOutline, job.totalChapters);
            if (missingGeneratedChapters.length > 0) {
                plotError = `Generated plot is incomplete. Missing chapters: ${missingGeneratedChapters.join(', ')}. Please retry before novel generation.`;
            }
        }

        if (plotError) {
            setNovelStatus(`[Batch] Plot Error: ${plotError}`);
            els.plotContent.value = ""; // Clear partial plot on generation error
            updatePlotTokenCount();
            renderMarkdown(els.plotContent.id);
            AppState.stopRequested = true;
            AppState.isPaused = true;
            return;
        }
    } else {
        setNovelStatus(`[Batch] Resuming from existing plot (${AppState.taskQueue.length} remaining)...`);
    }

    if (AppState.stopRequested) return;

    if (job.autoRefinePlot && !job.plotRefineFinished && !AppState.stopRequested) {
        const preRefinePlot = plotOutline;
        const passCount = job.autoRefinePlot2Pass ? 2 : 1;
        for (let pass = 1; pass <= passCount; pass++) {
            if (AppState.stopRequested) break;
            job.lastRefinedPlotPart = 0;
            try {
                const passPrefix = passCount > 1 ? `[Pass ${pass}/${passCount}] ` : '';
                setNovelStatus(`[Batch] ${passPrefix}Generating Auto Instructions...`);
                const systemPrompt = "You are a professional plot editor for web novels and long-form fiction.";
                const prompt = `Read the novel plot below and output only improvement points, exactly 10 sentences.\n\nRules:\n- Output exactly 10 sentences in ${lang}.\n- Number them from 1 to 10.\n- Each sentence must contain one specific direction for improvement.\n- Do not include praise, impressions, summaries, or restatements.\n- Do not use softening phrases such as "This is good," "Interesting," or "Overall."\n- Review the plot from the perspectives of plot holes, plausibility, character motivation, conflict structure, pacing, theme, long-term serialization potential, reader engagement, climax design, and foreshadowing payoff.\n- Do not merely point out problems; also suggest how to fix them.\n- Preserve the genre and intended direction of the plot while making the story stronger.\n- Do not include any meta-explanation; output only the 10 improvement sentences.\n\nNovel plot:\n${plotOutline}`;

                const autoInstructionsResult = await invoke("chat_completion", {
                    apiBase: els.apiBase.value,
                    modelName: els.modelName.value,
                    apiKey: els.apiKeyBox.value || "lm-studio",
                    systemPrompt: systemPrompt,
                    prompt: prompt,
                    temperature: 0.7,
                    topP: 0.9,
                    maxTokens: 2000,
                    repetitionPenalty: 1.1
                });

                if (els.plotRefineInstructions) {
                    els.plotRefineInstructions.value = autoInstructionsResult.trim();
                    els.plotRefineInstructions.dispatchEvent(new Event('change'));
                }

                setNovelStatus(`[Batch] ${passPrefix}Refining plot before novel generation...`);
                plotOutline = await refinePlotTextInChunks({
                    originalPlot: plotOutline,
                    lang,
                    totalChapters: job.totalChapters,
                    refineInstructions: autoInstructionsResult.trim(),
                    startPart: job.lastRefinedPlotPart ? job.lastRefinedPlotPart + 1 : 1,
                    onStatus: (msg) => {
                        setNovelStatus(`[Batch] ${passPrefix}${msg.replace(/^⏳\s*/, '')}`);
                        if (msg === "✅ Done") {
                            els.plotStatusMsg.innerText = "✅ Done";
                        }
                    },
                    onPartFinished: (p) => { job.lastRefinedPlotPart = p; },
                    onUpdate: (text, event) => {
                        els.plotContent.value = text;
                        updatePlotTokenCount();
                        schedulePreviewRender(els.plotContent.id, {
                            source: 'stream',
                            force: event?.is_finished || Boolean(event?.error),
                            immediate: event?.is_finished || Boolean(event?.error)
                        });
                    }
                });
                els.plotContent.value = plotOutline;
                updatePlotTokenCount();
                schedulePreviewRender(els.plotContent.id, { source: 'stream', force: true, immediate: true });
                assertCompletePlotOutline(plotOutline, job.totalChapters, 'Refined plot outline');
                els.plotStatusMsg.innerText = "✅ Done";
                setNovelStatus(`[Batch] ✅ Plot refine done`);
                job.lastRefinedPlotPart = 0;
            } catch (e) {
                els.plotContent.value = preRefinePlot;
                updatePlotTokenCount();
                schedulePreviewRender(els.plotContent.id, { source: 'stream', force: true, immediate: true });
                els.plotStatusMsg.innerText = "❌ Error";
                setNovelStatus(`[Batch] Plot Refine Error: ${e.message || e}`);
                showToast(`[Batch] Plot refine failed: ${e.message || e}`, 'error');
                AppState.stopRequested = true;
                AppState.isPaused = true;
                job.lastRefinedPlotPart = 0;
                return;
            }
        }

        if (AppState.stopRequested) {
            els.plotContent.value = preRefinePlot;
            updatePlotTokenCount();
            schedulePreviewRender(els.plotContent.id, { source: 'stream', force: true, immediate: true });
            // Reset plot refinement progress so it starts over on resume if restored to original
            job.lastRefinedPlotPart = 0;
        } else {
            job.plotRefineFinished = true;
        }
    }

    if (AppState.stopRequested) return;

    try {
        assertCompletePlotOutline(plotOutline, job.totalChapters, 'Plot outline before novel generation');
    } catch (e) {
        setNovelStatus(`[Batch] Plot Error: ${e.message || e}`);
        showToast(`[Batch] Plot incomplete: ${e.message || e}`, 'error');
        AppState.stopRequested = true;
        AppState.isPaused = true;
        return;
    }

    let currentText = els.novelContent.value;
    if (!currentText) {
        els.novelContent.value = '';
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
        if (nextCh > job.totalChapters || AppState.stopRequested) break;
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
                    if (els.resumeCh) els.resumeCh.value = Math.min(ch + 1, job.totalChapters + 1);
                },
                onFilenameKnown: setActiveNovelFilename,
                stopSignal: () => AppState.stopRequested,
                plotSeed: job.seed
            });
            currentText = result.fullNovelText;
            novelFilename = result.novelFilename || novelFilename;
            completedNovelFilename = novelFilename;
            applyGeneratedNovelState(result);
            els.novelContent.value = currentText;
            els.novelContent.dispatchEvent(new CustomEvent('novel-content-updated', { bubbles: true }));
        } catch (e) {
            applyGeneratedNovelState(e.generationResult);
            setNovelStatus(`[Batch] Error: ${e.message}`);
            AppState.stopRequested = true;
            AppState.isPaused = true;
            break;
        }

        const nextAfter = await invoke('suggest_next_chapter', {
            text: currentText,
            language: lang,
            last_completed_ch: null
        });
        if (nextAfter <= nextCh && !AppState.stopRequested) {
            setNovelStatus(`[Batch] Error: Generation stalled at chapter ${nextCh}. No new chapter header detected in text.`);
            AppState.stopRequested = true;
            AppState.isPaused = true;
            break;
        }
    }

    if (!AppState.stopRequested && !AppState.isPaused) {
        if (job.autoRefineNovel && !job.novelRefineFinished && currentText.trim()) {
            try {
                setNovelStatus(`[Batch] Refining novel...`);
                const refined = await refineNovelTextInChapters({
                    originalNovel: currentText,
                    plotOutline,
                    lang,
                    totalChapters: job.totalChapters,
                    userInstructions: els.novelRefineInstructions?.value?.trim() || '',
                    chapterRange: (job.lastRefinedChapter && job.lastRefinedChapter < job.totalChapters)
                        ? { start: job.lastRefinedChapter + 1, end: null }
                        : null,
                    statusPrefix: '[Batch]',
                    detectNextChapter,
                    apiParams: {
                        apiBase: els.apiBase.value,
                        modelName: els.modelName.value,
                        apiKey: els.apiKeyBox.value || "lm-studio",
                    },
                    autoInstructionsPerChapter: job.autoRefineNovelInstructions,
                    onChapterFinished: (ch) => { job.lastRefinedChapter = ch; },
                });
                if (refined?.fullText) {
                    currentText = refined.fullText;
                    completedNovelFilename = refined.filename || completedNovelFilename;
                    setActiveNovelFilename(completedNovelFilename);
                    els.novelContent.value = currentText;
                    setNovelStatus(`[Batch] ✅ Novel refine done`);
                    schedulePreviewRender(els.novelContent.id, {
                        source: 'stream',
                        force: true,
                        immediate: true
                    });
                    job.novelRefineFinished = true;
                }
            } catch (e) {
                setNovelStatus(`[Batch] Novel Refine Error: ${e.message || e}`);
                AppState.stopRequested = true;
                AppState.isPaused = true;
                return;
            }
        }

        if (AppState.stopRequested || AppState.isPaused) {
            await detectNextChapter();
            return;
        }

        await reloadNovelList?.();
        els.resumeCh.value = 1;
    } else {
        await detectNextChapter();
    }
}
