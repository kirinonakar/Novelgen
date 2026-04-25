import { AppState } from './app_state.js';
import { els } from './dom_refs.js';
import { loadLatestNovelState, loadNovelState, metadataNextChapter } from './novel_storage.js';
import { refinePlotTextInChunks } from './plot_refine.js';
import { renderMarkdown, schedulePreviewRender } from './preview.js';
import { Channel, invoke } from './tauri_api.js';
import { showToast } from './toast.js';
import {
    getCleanedInitialText,
    getPlotArcInstruction,
    splitPlotIntoChapters,
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

export function requestNovelStop() {
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

export function startSingleNovelJob({ getLang, generateNovel, detectNextChapter, updatePlotTokenCount }) {
    if (!els.plotContent.value.trim()) {
        showToast('Plot is empty! Generate a plot outline first.', 'warning');
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
        totalChapters: parseInt(els.numChap.value),
        targetTokens: parseInt(els.targetTokens.value),
        lang: getLang(),
        plotSeed: els.seedBox.value
    });

    els.queueCount.value = AppState.taskQueue.length;
    processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount });
}

export async function startOrResumeBatchQueue({
    getLang,
    generateNovel,
    detectNextChapter,
    updatePlotTokenCount,
}) {
    if (AppState.isPaused) {
        AppState.isPaused = false;
        AppState.stopRequested = false;
        await invoke('resume_generation');

        updateBatchButtons();
        processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount });
        return;
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
        });
    }
    els.queueCount.value = AppState.taskQueue.length;
    processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount });
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

            els.plotContent.value = "";
            els.novelContent.value = "";
            updatePlotTokenCount();
            renderMarkdown(els.plotContent.id);
            renderMarkdown(els.novelContent.id);

            els.novelStatus.innerText = "Stopped job cleared.";
            els.queueCount.value = AppState.taskQueue.length;
            if (AppState.taskQueue.length === 0) {
                AppState.isPaused = false;
            }
        } else {
            AppState.reset();
            els.queueCount.value = 0;

            els.plotContent.value = "";
            els.novelContent.value = "";
            updatePlotTokenCount();
            renderMarkdown(els.plotContent.id);
            renderMarkdown(els.novelContent.id);

            els.novelStatus.innerText = "Queue cleared.";
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

async function processQueue({ generateNovel, detectNextChapter, updatePlotTokenCount }) {
    if (AppState.isWorkerRunning) return;
    AppState.isWorkerRunning = true;

    try {
        AppState.stopRequested = false;
        AppState.isPaused = false;
        updateBatchButtons();

        while (AppState.taskQueue.length > 0 && !AppState.stopRequested) {
            els.queueCount.value = AppState.taskQueue.length;
            const job = AppState.taskQueue[0];
            els.queueCount.value = AppState.taskQueue.length;

            if (job.type === 'batch') {
                await runBatchJob(job, { generateNovel, detectNextChapter, updatePlotTokenCount });
            } else if (job.type === 'single') {
                await runSingleJob(job, { generateNovel, detectNextChapter });
            }

            if (!AppState.stopRequested) {
                AppState.taskQueue.shift();
                AppState.lastRanJobUid = null;
            }
        }
    } catch (e) {
        console.error("[ProcessQueue] Error:", e);
        els.novelStatus.innerText = "❌ Fatal Error: " + e.message;
        AppState.isPaused = true;
    } finally {
        AppState.isWorkerRunning = false;
        els.queueCount.value = AppState.taskQueue.length;

        if (!AppState.isPaused) {
            if (!els.novelStatus.innerText.includes("Error")) {
                els.novelStatus.innerText = AppState.stopRequested ? '🛑 Stopped.' : '✅ Done';
            }
        } else if (!els.novelStatus.innerText.includes("Error")) {
            els.novelStatus.innerText = '⏸️ Paused.';
        }
        updateBatchButtons();
    }
}

async function runSingleJob(job, { generateNovel, detectNextChapter }) {
    const { plotOutline, startChapter, totalChapters, targetTokens, lang, plotSeed } = job;

    if (startChapter === 1) {
        els.novelContent.value = "";
        renderMarkdown(els.novelContent.id);
        AppState.clearLoadedNovel();
    }
    let initialText = "";
    let recentChapters = [];
    let storyState = '';
    let characterState = '';
    let currentArc = '';
    let currentArcKeywords = [];
    let currentArcStartChapter = 1;
    let closedArcs = [];
    let expressionCooldown = [];
    let needsMemoryRebuild = false;
    let continuityFallbackCount = 0;
    let novelFilename = null;

    if (startChapter > 1) {
        els.novelStatus.innerText = 'Loading saved state...';
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
                currentArc = state.meta.current_arc || '';
                currentArcKeywords = state.meta.current_arc_keywords || [];
                currentArcStartChapter = state.meta.current_arc_start_chapter || 1;
                closedArcs = state.meta.closed_arcs || [];
                expressionCooldown = state.meta.expression_cooldown || [];
                needsMemoryRebuild = state.meta.needs_memory_rebuild === true;
                continuityFallbackCount = state.meta.continuity_fallback_count || 0;
                novelFilename = state.filename;
                initialText = state.text || els.novelContent.value;
                AppState.setLoadedNovel(state.filename, state.meta);
                els.novelStatus.innerText = '✅ Metadata loaded. Resuming...';
            } else if (stateSource === 'loaded' && loadedState?.filename) {
                novelFilename = loadedState.filename;
                initialText = els.novelContent.value || loadedState.text || '';
                AppState.setLoadedNovel(loadedState.filename, loadedState.meta);
                els.novelStatus.innerText = '⚠️ Metadata mismatch, reconstructing from displayed text.';
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
            recentChapters, storyState, characterState, currentArc, currentArcKeywords, currentArcStartChapter, closedArcs, expressionCooldown, needsMemoryRebuild, continuityFallbackCount,
            onStatus: (msg) => { els.novelStatus.innerText = msg; },
            stopSignal: () => AppState.stopRequested,
            plotSeed: plotSeed
        });
        els.novelContent.value = result.fullNovelText;
        applyGeneratedNovelState(result);
    } catch (e) {
        applyGeneratedNovelState(e.generationResult);
        els.novelStatus.innerText = `❌ Error: ${e.message}`;
        AppState.stopRequested = true;
    }

    if (!AppState.stopRequested && !AppState.isPaused) {
        els.resumeCh.value = 1;
    } else {
        await detectNextChapter();
    }
}

async function runBatchJob(job, { generateNovel, detectNextChapter, updatePlotTokenCount }) {
    const isSameJob = job.uid === AppState.lastRanJobUid;
    AppState.lastRanJobUid = job.uid;

    let plotOutline = els.plotContent.value.trim();
    const chaptersMap = splitPlotIntoChapters(plotOutline);
    const plotActuallyComplete = Object.keys(chaptersMap).length >= job.totalChapters;

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

    const plotPrompt = `Based on the following seed, create a detailed plot outline for a ${job.totalChapters}-chapter novel in ${lang}.\nSeed: ${job.seed}\n\nFORMAT INSTRUCTIONS:\nPlease organize the output into the following 5 sections in ${lang}:\n${h.join('\n')}\n${arcInstruction}\nEnsure every section is detailed. Output ONLY the plot outline based on this format, without any greetings, meta-commentary.`;

    if (!isSameJob || !plotOutline || !plotActuallyComplete) {
        if (!isSameJob || !plotActuallyComplete) {
            console.log("[Batch] New or incomplete job detected, clearing UI fields.");
            els.plotContent.value = "";
            els.novelContent.value = "";
            updatePlotTokenCount();
            renderMarkdown(els.plotContent.id);
            renderMarkdown(els.novelContent.id);
        }

        els.novelStatus.innerText = `[Batch] Generating plot (${AppState.taskQueue.length} remaining)...`;
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

        if (plotError) {
            els.novelStatus.innerText = `[Batch] Plot Error: ${plotError}`;
            AppState.stopRequested = true;
            AppState.isPaused = true;
            return;
        }

        if (job.autoRefinePlot && generatedPlotThisRun && !AppState.stopRequested) {
            try {
                els.novelStatus.innerText = `[Batch] Refining plot before novel generation...`;
                plotOutline = await refinePlotTextInChunks({
                    originalPlot: plotOutline,
                    lang,
                    totalChapters: job.totalChapters,
                    refineInstructions: els.plotRefineInstructions?.value?.trim() || '',
                    onStatus: (msg) => {
                        els.novelStatus.innerText = `[Batch] ${msg.replace(/^⏳\s*/, '')}`;
                        if (msg === "✅ Done") {
                            els.plotStatusMsg.innerText = "✅ Done";
                        }
                    },
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
                els.plotStatusMsg.innerText = "✅ Done";
                els.novelStatus.innerText = `[Batch] ✅ Plot refine done`;
            } catch (e) {
                els.plotStatusMsg.innerText = "❌ Error";
                els.novelStatus.innerText = `[Batch] Plot Refine Error: ${e.message || e}`;
                AppState.stopRequested = true;
                AppState.isPaused = true;
                return;
            }
        }
    } else {
        els.novelStatus.innerText = `[Batch] Resuming from existing plot (${AppState.taskQueue.length} remaining)...`;
    }

    if (AppState.stopRequested) return;

    let currentText = els.novelContent.value;
    if (!currentText) {
        els.novelContent.value = '';
    }
    let safetyLimit = 0;

    while (true) {
        let lastCompleted = null;
        let recentChapters = [];
        let storyState = '';
        let characterState = '';
        let currentArc = '';
        let currentArcKeywords = [];
        let currentArcStartChapter = 1;
        let closedArcs = [];
        let expressionCooldown = [];
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
                    currentArc = meta.current_arc || '';
                    currentArcKeywords = meta.current_arc_keywords || [];
                    currentArcStartChapter = meta.current_arc_start_chapter || 1;
                    closedArcs = meta.closed_arcs || [];
                    expressionCooldown = meta.expression_cooldown || [];
                    needsMemoryRebuild = meta.needs_memory_rebuild === true;
                    continuityFallbackCount = meta.continuity_fallback_count || 0;
                    novelFilename = fname;
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
                recentChapters, storyState, characterState, currentArc, currentArcKeywords, currentArcStartChapter, closedArcs, expressionCooldown, needsMemoryRebuild, continuityFallbackCount,
                onStatus: (msg) => { els.novelStatus.innerText = `[Batch] ${msg}`; },
                stopSignal: () => AppState.stopRequested,
                plotSeed: job.seed
            });
            currentText = result.fullNovelText;
            novelFilename = result.novelFilename || novelFilename;
            applyGeneratedNovelState(result);
            els.novelContent.value = currentText;
        } catch (e) {
            applyGeneratedNovelState(e.generationResult);
            els.novelStatus.innerText = `[Batch] Error: ${e.message}`;
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
            els.novelStatus.innerText = `[Batch] Error: Generation stalled at chapter ${nextCh}. No new chapter header detected in text.`;
            AppState.stopRequested = true;
            AppState.isPaused = true;
            break;
        }
    }

    if (!AppState.stopRequested && !AppState.isPaused) {
        els.resumeCh.value = 1;
    } else {
        await detectNextChapter();
    }
}
