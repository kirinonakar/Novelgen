// Robust error reporting
window.onerror = function(msg, url, lineNo, columnNo, error) {
    const errorMsg = `Error: ${msg}\nLine: ${lineNo}\nColumn: ${columnNo}\nURL: ${url}`;
    console.error(errorMsg);
    alert("NovelGen Runtime Error:\n" + errorMsg);
    return false;
};

console.log("[Frontend] Script starting...");

// Tauri API access pattern for v2 global
let invoke, Channel;
try {
    if (window.__TAURI__ && window.__TAURI__.core) {
        invoke = window.__TAURI__.core.invoke;
        Channel = window.__TAURI__.core.Channel;
        console.log("[Frontend] Tauri API initialized from window.__TAURI__.core");
    } else {
        throw new Error("window.__TAURI__.core not found. Check tauri.conf.json withGlobalTauri.");
    }
} catch (e) {
    console.error("[Frontend] API Initialization failed", e);
    alert("API Initialization failed: " + e.message);
}

// DOM Elements
const els = {};

function initElements() {
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
        els.plotContent = document.getElementById('plot-content');
        
        els.btnGenNovel = document.getElementById('btn-gen-novel');
        els.btnStopNovel = document.getElementById('btn-stop-novel');
        els.novelStatus = document.getElementById('novel-status');
        els.novelContent = document.getElementById('novel-content');

        els.batchCount = document.getElementById('batch-count');
        els.queueCount = document.getElementById('queue-count');
        els.batchStartBtn = document.getElementById('batch-start-btn');
        els.batchStopBtn = document.getElementById('batch-stop-btn');
        
        console.log("[Frontend] Elements initialized successfully.");
    } catch (e) {
        alert("Element initialization failed: " + e.message);
    }
}

// Helpers
const getLang = () => document.querySelector('input[name="language"]:checked')?.value || "Korean";
const getProvider = () => document.querySelector('input[name="provider"]:checked')?.value || "LM Studio";

async function setProviderUI(skipModelFetch = false) {
    const provider = getProvider();
    console.log("[Frontend] Setting Provider UI for:", provider);
    
    if (provider === 'Google') {
        els.apiBase.value = "https://generativelanguage.googleapis.com/v1beta/openai/";
        els.apiKeyGroup.style.display = "flex";
        
        // Default Google models
        if (els.modelName.innerHTML.indexOf('gemini') === -1) {
            els.modelName.innerHTML = `
                <option value="gemini-2.0-flash-exp">gemini-2.0-flash-exp</option>
                <option value="gemini-1.5-flash">gemini-1.5-flash</option>
                <option value="gemini-1.5-pro">gemini-1.5-pro</option>
                <option value="gemini-1.0-pro">gemini-1.0-pro</option>
                <option value="gemini-3.1-flash-lite-preview">gemini-3.1-flash-lite-preview</option>
                <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
            `;
        }
        if (!skipModelFetch) await refreshModels();
    } else {
        els.apiBase.value = localStorage.getItem('api-base-lmstudio') || "http://localhost:1234/v1";
        els.apiKeyGroup.style.display = "none";
        if (!skipModelFetch) await refreshModels();
    }
    saveSettings();
}

async function refreshModels() {
    try {
        console.log("[Frontend] Refreshing models...");
        els.apiStatus.innerText = "⏳ Syncing...";
        els.refreshModelsBtn.disabled = true;
        
        const currentModel = els.modelName.value;
        const models = await invoke("fetch_models", { apiBase: els.apiBase.value });
        
        if (models && models.length > 0) {
            els.modelName.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
            if (models.includes(currentModel)) els.modelName.value = currentModel;
            els.apiStatus.innerText = "✅ Ready";
            console.log("[Frontend] Models updated.");
        } else {
            els.apiStatus.innerText = "⚠️ No models found";
        }
    } catch (e) {
        console.warn("[Frontend] Model fetch failed", e);
        els.apiStatus.innerText = "❌ Offline";
    } finally {
        els.refreshModelsBtn.disabled = false;
        setTimeout(() => { if (els.apiStatus.innerText.includes("Ready")) els.apiStatus.innerText = ""; }, 3000);
    }
}

function saveSettings() {
    localStorage.setItem('api-provider', getProvider());
    localStorage.setItem('api-base', els.apiBase.value);
    if (getProvider() === 'LM Studio') localStorage.setItem('api-base-lmstudio', els.apiBase.value);
    localStorage.setItem('api-model', els.modelName.value);
}

async function saveKey() {
    try {
        await invoke("save_api_key", { key: els.apiKeyBox.value });
    } catch (e) { console.error("Failed to save API key", e); }
}

function setupEventListeners() {
    console.log("[Frontend] Setting up event listeners...");
    
    document.getElementsByName('provider').forEach(r => r.addEventListener('change', () => setProviderUI()));
    document.getElementsByName('language').forEach(r => r.addEventListener('change', saveSettings));
    
    els.refreshModelsBtn.addEventListener('click', refreshModels);
    els.apiBase.addEventListener('change', () => { refreshModels(); saveSettings(); });
    els.apiKeyBox.addEventListener('change', saveKey);
    els.modelName.addEventListener('change', saveSettings);
    
    els.preset.addEventListener('change', (e) => {
        if (PRESETS[e.target.value]) els.promptBox.value = PRESETS[e.target.value];
    });
    els.temp.addEventListener('input', e => els.tempVal.innerText = parseFloat(e.target.value).toFixed(1));
    els.topP.addEventListener('input', e => els.topPVal.innerText = parseFloat(e.target.value).toFixed(2));
    els.repetitionPenalty.addEventListener('input', e => els.rpVal.innerText = parseFloat(e.target.value).toFixed(2));
    els.openFolderBtn.addEventListener('click', () => {
        console.log("[Frontend] Open Folder clicked");
        invoke("open_output_folder").catch(e => alert("Failed to open folder: " + e));
    });

    els.savePromptBtn.addEventListener('click', async () => {
        try {
            els.promptStatus.innerText = "Saving...";
            const msg = await invoke("save_system_prompt", { content: els.promptBox.value });
            els.promptStatus.innerText = msg;
            setTimeout(() => els.promptStatus.innerText = "", 3000);
        } catch (e) {
            els.promptStatus.innerText = "❌ Error: " + e;
        }
    });

    els.autoSeedBtn.addEventListener('click', async () => {
        els.autoSeedBtn.disabled = true;
        els.seedBox.value = "⏳ Generating seed...";
        try {
            const seed = await invoke("generate_seed", {
                apiBase: els.apiBase.value,
                modelName: els.modelName.value,
                apiKey: els.apiKeyBox.value || "lm-studio",
                systemPrompt: els.promptBox.value,
                language: getLang(),
                temperature: parseFloat(els.temp.value),
                topP: parseFloat(els.topP.value)
            });
            els.seedBox.value = seed;
        } catch (e) {
            els.seedBox.value = `❌ Error: ${e}`;
        } finally {
            els.autoSeedBtn.disabled = false;
        }
    });

    els.btnStopPlot.addEventListener('click', () => { stopPlotRequested = true; });

    els.btnGenPlot.addEventListener('click', () => {
        const lang = getLang();
        const h = lang === 'Korean' ? [
            "1. 제목", "2. 핵심 주제의식과 소설 스타일", "3. 등장인물 이름, 설정", "4. 세계관 설정", "5. 각 장 제목과 내용, 핵심 포인트"
        ] : lang === 'Japanese' ? [
            "1. タイトル", "2. 核心となるテーマと小説のスタイル", "3. 登場人物の名前・設定", "4. 世界観設定", "5. 各章のタイトルと内容、重要ポイント"
        ] : [
            "1. Title", "2. Core Theme and Novel Style", "3. Character Names and Settings", "4. World Building/Setting", "5. Chapter Titles, Content, and Key Points"
        ];

        const prompt = `Based on the following seed, create a detailed plot outline for a ${els.numChap.value}-chapter novel in ${lang}.\nSeed: ${els.seedBox.value}\n\nFORMAT INSTRUCTIONS:\nPlease organize the output into the following 5 sections in ${lang}:\n${h.join('\n')}\nEnsure every section is detailed. Output ONLY the plot outline based on this format.`;
        
        streamPlot(prompt, els.plotContent);
    });

    els.btnRefinePlot.addEventListener('click', () => {
        const lang = getLang();
        const prompt = `You are a master story architect. Refine and elaborate on the following plot outline for a ${els.numChap.value}-chapter novel in ${lang}.\n\n[Current Plot Outline]\n${els.plotContent.value}\n\nMaintain the 5-section format and polish content for better emotional resonance and pacing.`;
        streamPlot(prompt, els.plotContent);
    });

    els.btnRefreshPlots.addEventListener('click', reloadPlotList);

    els.btnSavePlot.addEventListener('click', async () => {
        try {
            let titleMatch = els.plotContent.value.match(/(?:제목|Title|タイトル)[:\s]*(.*)/i);
            let title = titleMatch ? titleMatch[1].trim() : "untitled_plot";
            const saved = await invoke("save_plot", { filename: title, content: els.plotContent.value });
            els.plotStatusMsg.innerText = `✅ Saved: ${saved}`;
            reloadPlotList();
        } catch (e) {
            els.plotStatusMsg.innerText = `❌ Error: ${e}`;
        }
    });

    els.btnLoadPlot.addEventListener('click', async () => {
        if (!els.savedPlots.value) return;
        try {
            els.plotContent.value = await invoke("load_plot", { filename: els.savedPlots.value });
            els.plotStatusMsg.innerText = `✅ Loaded: ${els.savedPlots.value}`;
        } catch (e) {
            els.plotStatusMsg.innerText = `❌ Error: ${e}`;
        }
    });

    els.findChBtn.addEventListener('click', () => {
        const next = suggestNextChapter(els.novelContent.value, getLang());
        els.resumeCh.value = next;
    });

    els.btnStopNovel.addEventListener('click', () => { stopNovelRequested = true; });

    els.btnGenNovel.addEventListener('click', async () => {
        if (!els.plotContent.value.trim()) {
            alert('Plot is empty! Generate a plot outline first.');
            return;
        }

        stopNovelRequested = false;
        els.btnGenNovel.style.display  = 'none';
        els.btnStopNovel.style.display = 'inline-flex';

        const startChapter  = parseInt(els.resumeCh.value) || 1;
        const totalChapters = parseInt(els.numChap.value);
        const targetTokens  = parseInt(els.targetTokens.value);
        const lang          = getLang();
        const plotOutline   = els.plotContent.value;

        let initialText        = '';
        let chapterSummaries   = [];
        let grandSummary       = '';
        let novelFilename      = null;

        // ── Resumption: try to load saved metadata ──
        if (startChapter > 1) {
            els.novelStatus.innerText = 'Loading saved state...';
            try {
                const result = await invoke('get_latest_novel_metadata');
                if (result) {
                    const [fname, jsonStr] = result;
                    const meta = JSON.parse(jsonStr);
                    if (meta.current_chapter + 1 === startChapter) {
                        chapterSummaries = meta.chapter_summaries || [];
                        grandSummary     = meta.grand_summary     || '';
                        novelFilename    = fname;
                        // Load the text file as the starting content
                        try {
                            initialText = await invoke('load_plot', { filename: '../' + fname });
                        } catch (_) {
                            initialText = els.novelContent.value;
                        }
                        els.novelStatus.innerText = '✅ Metadata loaded. Resuming...';
                    } else {
                        initialText = els.novelContent.value;
                        els.novelStatus.innerText = '⚠️ Metadata mismatch, resuming from displayed text.';
                    }
                } else {
                    initialText = els.novelContent.value;
                }
            } catch (_) {
                initialText = els.novelContent.value;
            }
        }

        try {
            const { fullNovelText } = await generateNovel({
                startChapter, totalChapters, targetTokens, lang,
                plotOutline, initialText, novelFilename,
                chapterSummaries, grandSummary,
                onStatus: (msg) => { els.novelStatus.innerText = msg; },
                stopSignal: () => stopNovelRequested,
                plotSeed: els.seedBox.value
            });
            els.novelContent.value = fullNovelText;
        } catch (e) {
            els.novelStatus.innerText = `❌ Error: ${e}`;
        }

        els.novelStatus.innerText  = stopNovelRequested ? 'Stopped.' : '✅ Finished!';
        els.btnGenNovel.style.display  = 'inline-flex';
        els.btnStopNovel.style.display = 'none';
    });

    els.batchStartBtn.addEventListener('click', () => {
        const count = parseInt(els.batchCount.value) || 1;
        for (let i = 0; i < count; i++) {
            batchQueue.push({
                seed:          els.seedBox.value,
                totalChapters: parseInt(els.numChap.value),
                targetTokens:  parseInt(els.targetTokens.value),
                lang:          getLang(),
            });
        }
        els.queueCount.value = batchQueue.length;
        runBatchQueue();
    });

    els.batchStopBtn.addEventListener('click', () => {
        batchStop = true;
        stopNovelRequested = true;
    });
}

// Stream function
async function streamPlot(prompt, textarea) {
    stopPlotRequested = false;
    els.btnGenPlot.style.display = 'none';
    els.btnRefinePlot.style.display = 'none';
    els.btnStopPlot.style.display = 'inline-flex';
    
    textarea.value = "";
    
    const onEvent = new Channel();
    onEvent.onmessage = (event) => {
        if (stopPlotRequested) return;
        textarea.value = event.content;
        if (event.error) {
            textarea.value += `\n[Error]: ${event.error}`;
        }
    };

    try {
        await invoke("generate_plot", {
            params: {
                api_base: els.apiBase.value,
                model_name: els.modelName.value,
                api_key: els.apiKeyBox.value || "lm-studio",
                system_prompt: els.promptBox.value,
                prompt: prompt,
                temperature: parseFloat(els.temp.value),
                top_p: parseFloat(els.topP.value),
                repetition_penalty: parseFloat(els.repetitionPenalty.value),
                max_tokens: 8192
            },
            onEvent
        });
    } catch (e) {
        textarea.value += `\n[Error]: ${e}`;
    }

    els.btnGenPlot.style.display = 'inline-flex';
    els.btnRefinePlot.style.display = 'inline-flex';
    els.btnStopPlot.style.display = 'none';
}

// Plot Save/Load
async function reloadPlotList() {
    try {
        const plots = await invoke("get_saved_plots");
        els.savedPlots.innerHTML = '<option value="" disabled selected>Select a saved plot...</option>' + 
            plots.map(p => `<option value="${p}">${p}</option>`).join('');
    } catch (e) {}
}


// ──────────────────────────────────────────────────────────────
// REGEX UTILITIES  (ported from app.py)
// ──────────────────────────────────────────────────────────────

/**
 * Split a master plot outline into a map of { chapterNumber: outlineText }.
 */
function splitPlotIntoChapters(plotText) {
    const pattern = /(?:Chapter\s*(\d+)|제?\s*(\d+)\s*장|第?\s*(\d+)\s*章)/gi;
    const matches = [...plotText.matchAll(pattern)];
    const map = {};
    for (let i = 0; i < matches.length; i++) {
        const num = parseInt(matches[i][1] || matches[i][2] || matches[i][3]);
        const start = matches[i].index + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : plotText.length;
        map[num] = plotText.slice(start, end).trim();
    }
    return map;
}

/**
 * Ported from app.py: Split full novel text into specific chapters.
 */
function splitFullTextIntoChapters(text, lang) {
    let pattern;
    if (lang === "Korean") pattern = /(?:^|\n)#?\s*제?\s*(\d+)\s*장/gi;
    else if (lang === "Japanese") pattern = /(?:^|\n)#?\s*第?\s*(\d+)\s*章/gi;
    else pattern = /(?:^|\n)#?\s*Chapter\s*(\d+)/gi;

    const matches = [...text.matchAll(pattern)];
    const chapters = {};
    for (let i = 0; i < matches.length; i++) {
        const chNum = parseInt(matches[i][1]);
        const start = matches[i].index + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        chapters[chNum] = text.slice(start, end).trim();
    }
    return chapters;
}

/**
 * Scan existing novel text and return the next chapter number that should be written.
 * A chapter is only counted if it has >= 300 characters of body text.
 */
function suggestNextChapter(novelText, lang) {
    const chapters = splitFullTextIntoChapters(novelText, lang);
    let maxValid = 0;
    for (const [num, content] of Object.entries(chapters)) {
        if (content.length >= 300) {
            maxValid = Math.max(maxValid, parseInt(num));
        }
    }
    return maxValid + 1;
}

// Wire up the "Detect" button

// ──────────────────────────────────────────────────────────────
// CORE NOVEL GENERATION FUNCTION
// Returns the completed novel text, or throws on unrecoverable error.
// ──────────────────────────────────────────────────────────────
async function generateNovel({
    startChapter = 1,
    totalChapters,
    targetTokens,
    lang,
    plotOutline,
    initialText = '',
    novelFilename = null,
    chapterSummaries = [],
    grandSummary = '',
    onStatus = () => {},
    stopSignal = () => false,
    plotSeed = "",
}) {
    const apiBase       = els.apiBase.value;
    const modelName     = els.modelName.value;
    const apiKey        = els.apiKeyBox.value || 'lm-studio';
    const systemPrompt  = els.promptBox.value;
    const temp          = parseFloat(els.temp.value);
    const topP          = parseFloat(els.topP.value);
    const repPenalty    = parseFloat(els.repetitionPenalty.value);

    // Determine a save-file name for this novel session
    if (!novelFilename) {
        novelFilename = await invoke('get_next_novel_filename');
    }

    const chapterPlots = splitPlotIntoChapters(plotOutline);
    let fullNovelText  = initialText;

    // --- CONTEXT RECONSTRUCTION (Ported from app.py) ---
    if (startChapter > 1 && chapterSummaries.length === 0) {
        onStatus("Reconstructing context from previous chapters...");
        const chaptersMap = splitFullTextIntoChapters(fullNovelText, lang);
        
        for (let i = 1; i < startChapter; i++) {
            if (stopSignal()) break;
            const content = chaptersMap[i] || "";
            if (content.length >= 100) {
                onStatus(`Summarizing Chapter ${i}...`);
                try {
                    const summary = await invoke('chat_completion', {
                        apiBase, modelName, apiKey,
                        systemPrompt: 'You are a professional novelist.',
                        prompt: `Summarize the following chapter in 3-4 sentences in ${lang}. Focus on plot events.\n\nContent:\n${content.substring(0, 4000)}`,
                        temperature: 0.5, topP: 0.95, maxTokens: 500, repetition_penalty: 1.0
                    });
                    chapterSummaries.push(summary);
                } catch (e) {
                    chapterSummaries.push("");
                }
            } else {
                chapterSummaries.push("");
            }
        }
        
        // Sliding window compression for reconstructed summaries
        if (chapterSummaries.length > 5) {
            onStatus("Compressing reconstructed summaries...");
            const toMerge = chapterSummaries.splice(0, chapterSummaries.length - 5);
            for (const s of toMerge) {
                if (!s) continue;
                try {
                    grandSummary = await invoke('chat_completion', {
                        apiBase, modelName, apiKey,
                        systemPrompt: 'You are a professional novelist.',
                        prompt: `Update Grand Summary with New Chapter Summary. Write in ${lang}.\n\nCurrent Grand Summary:\n${grandSummary}\n\nNew Summary:\n${s}`,
                        temperature: 0.5, topP: 0.95, maxTokens: 800, repetition_penalty: 1.0
                    });
                } catch (_) {
                    grandSummary += "\n" + s;
                }
            }
        }
    }

    for (let ch = startChapter; ch <= totalChapters; ch++) {
        if (stopSignal()) break;
        onStatus(`Writing Chapter ${ch} / ${totalChapters}...`);

        // Build prompt (mirrors app.py generate_novel())
        let prompt = `You are a professional novelist writing a novel in ${lang}.\n\n`;
        prompt += `[Book Information]\n- Total Chapters: ${totalChapters}\n`;
        prompt += `- Master Plot Outline:\n${plotOutline}\n\n`;
        prompt += `CRITICAL INSTRUCTION:\n`;
        prompt += `1. Write ONLY Chapter ${ch}. Do not rush into future chapters.\n`;
        prompt += `2. Target length: ~${targetTokens} tokens.\n`;
        prompt += `3. Output ONLY the story text. No meta-talk.\n`;
        prompt += `4. NEVER use internal reasoning tags or <|channel>thought tokens.\n\n`;
        prompt += `### CURRENT FOCUS: Chapter ${ch} ###\n`;

        if (chapterPlots[ch]) {
            prompt += `- Current Chapter Plot: ${chapterPlots[ch]}\n\n`;
        }

        // Hierarchical context: grand summary + recent sliding window
        if (grandSummary) {
            const coveredUpTo = ch - chapterSummaries.length - 1;
            prompt += `[Grand Summary (Chapters 1 to ${coveredUpTo})]\n${grandSummary}\n\n`;
        }
        if (chapterSummaries.length > 0) {
            prompt += `[Recent Chapter Summaries]\n`;
            const startIdx = ch - chapterSummaries.length;
            chapterSummaries.forEach((s, i) => {
                if (s) prompt += `Chapter ${startIdx + i}: ${s}\n`;
            });
            prompt += '\n';

            // Preceding context tail (last 1200 chars)
            const lastChNum = ch - 1;
            const patterns = [
                `\n\n# 제 ${lastChNum}장`, `\n\n# 第 ${lastChNum} 章`, `\n\n# Chapter ${lastChNum}`
            ];
            let tail = '';
            for (const p of patterns) {
                const idx = fullNovelText.lastIndexOf(p);
                if (idx !== -1) { tail = fullNovelText.slice(idx); break; }
            }
            if (!tail) tail = fullNovelText;
            prompt += `[Directly Preceding Content (End of Chapter ${lastChNum})]\n"${tail.slice(-1200)}"\n\n`;
        }
        prompt += 'Please begin writing the chapter now.';

        // Chapter title header
        let chTitle = '';
        if (lang === 'Korean')    chTitle = `\n\n# 제 ${ch}장\n\n`;
        else if (lang === 'Japanese') chTitle = `\n\n# 第 ${ch} 章\n\n`;
        else                      chTitle = `\n\n# Chapter ${ch}\n\n`;

        let chapterText = '';
        const onEvent = new Channel();
        onEvent.onmessage = (event) => {
            if (stopSignal()) return;
            chapterText = event.content;
            els.novelContent.value = fullNovelText + chTitle + chapterText;
            els.novelContent.scrollTop = els.novelContent.scrollHeight;
        };

        const maxTok = parseInt(targetTokens) + 1000;
        await invoke('generate_plot', {
            params: { 
                api_base: apiBase, model_name: modelName, api_key: apiKey,
                system_prompt: systemPrompt, prompt, 
                temperature: temp, top_p: topP, 
                repetition_penalty: repPenalty, max_tokens: maxTok 
            },
            onEvent
        });

        if (stopSignal()) break;

        fullNovelText += chTitle + chapterText + '\n';

        // ── POST-CHAPTER: summarize ──
        let summary = "";
        try {
            summary = await invoke('chat_completion', {
                apiBase, modelName, apiKey,
                systemPrompt: 'You are a professional novelist.',
                prompt: `Summarize the following chapter in 3-4 sentences in ${lang}. Focus on plot events.\n\nContent:\n${chapterText.substring(0, 4000)}`,
                temperature: 0.5, topP: 0.95, maxTokens: 500, repetition_penalty: 1.0
            });
        } catch (e) {
            summary = "";
        }
        chapterSummaries.push(summary);

        // ── Sliding-window merge (> 5 → merge oldest into grand summary) ──
        if (chapterSummaries.length > 5) {
            const oldest = chapterSummaries.shift();
            if (oldest) {
                onStatus('Compressing older summaries...');
                try {
                    grandSummary = await invoke('chat_completion', {
                        apiBase, modelName, apiKey,
                        systemPrompt: 'You are a professional novelist.',
                        prompt: `Update Grand Summary with New Chapter Summary. Write in ${lang}.\n\nCurrent Grand Summary:\n${grandSummary}\n\nNew Summary:\n${oldest}`,
                        temperature: 0.5, topP: 0.95, maxTokens: 800, repetition_penalty: 1.0
                    });
                } catch (_) {
                    grandSummary = grandSummary ? grandSummary + '\n' + oldest : oldest;
                }
            }
        }

        // ── Checkpoint: save txt + json to disk ──
        try {
            await invoke('save_novel_state', {
                filename: novelFilename,
                textContent: fullNovelText,
                metadataJson: JSON.stringify({
                    title: "Novel",
                    language: lang,
                    num_chapters: totalChapters,
                    current_chapter: ch,
                    plot_seed: plotSeed,
                    grand_summary: grandSummary,
                    chapter_summaries: chapterSummaries
                }, null, 4)
            });
        } catch (_) { /* non-fatal */ }

        els.resumeCh.value = ch + 1;
    }

    return { fullNovelText, novelFilename };
}

// ──────────────────────────────────────────────────────────────
// SINGLE NOVEL BUTTON
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
// BATCH PROCESSING QUEUE
// ──────────────────────────────────────────────────────────────
let batchQueue     = [];
let batchRunning   = false;
let batchStop      = false;

async function runBatchQueue() {
    if (batchRunning) return;
    batchRunning = true;
    batchStop    = false;

    els.batchStartBtn.style.display = 'none';
    els.batchStopBtn.style.display  = 'inline-flex';

    while (batchQueue.length > 0 && !batchStop) {
        els.queueCount.value = batchQueue.length;
        const job = batchQueue.shift();

        // 1. Generate plot for this batch item
        els.novelStatus.innerText = `[Batch] Generating plot (${batchQueue.length + 1} remaining)...`;

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

        const plotPrompt = `Based on the following seed, create a detailed plot outline for a ${job.totalChapters}-chapter novel in ${lang}.\nSeed: ${job.seed}\n\nFORMAT INSTRUCTIONS:\nPlease organize the output into the following 5 sections in ${lang}:\n${h.join('\n')}\nEnsure every section is detailed. Output ONLY the plot outline based on this format, without any greetings, meta-commentary.`;

        let plotOutline = '';
        const plotChannel = new Channel();
        plotChannel.onmessage = (ev) => {
            plotOutline = ev.content;
            els.plotContent.value = plotOutline;
        };
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

        if (batchStop) break;

        // 2. Generate novel from that plot (with auto-resume on error/incompletion)
        els.novelContent.value = '';
        let currentText = '';
        let safetyLimit = 0;

        while (true) {
            const nextCh = suggestNextChapter(currentText, lang);
            if (nextCh > job.totalChapters || batchStop) break;
            if (safetyLimit++ > job.totalChapters + 3) break; // anti-infinite-loop

            try {
                const result = await generateNovel({
                    startChapter: nextCh, totalChapters: job.totalChapters,
                    targetTokens: job.targetTokens, lang,
                    plotOutline, initialText: currentText,
                    onStatus: (msg) => { els.novelStatus.innerText = `[Batch] ${msg}`; },
                    stopSignal: () => batchStop,
                    plotSeed: job.seed
                });
                currentText = result.fullNovelText;
            } catch (e) {
                els.novelStatus.innerText = `[Batch] Error: ${e}`;
                break;
            }

            const nextAfter = suggestNextChapter(currentText, lang);
            if (nextAfter <= nextCh) break; // no progress
        }
    }

    batchRunning = false;
    els.queueCount.value = 0;
    els.batchStartBtn.style.display = 'inline-flex';
    els.batchStopBtn.style.display  = 'none';
    els.novelStatus.innerText = batchStop ? '🛑 Batch stopped.' : '✅ Batch complete!';
}


// ──────────────────────────────────────────────────────────────
// ON LOAD
// ──────────────────────────────────────────────────────────────
async function init() {
    initElements();
    setupEventListeners();

    // 1. Load API Key from gemini.txt
    try {
        const key = await invoke('load_api_key');
        if (key) els.apiKeyBox.value = key;
    } catch (_) {}

    // 2. Restore settings from localStorage
    const savedProvider = localStorage.getItem('api-provider');
    const savedBase = localStorage.getItem('api-base');
    const savedModel = localStorage.getItem('api-model');

    if (savedProvider) {
        Array.from(els.providerRadios).forEach(r => {
            if (r.value === savedProvider) r.checked = true;
        });
    }

    // Set UI according to provider (skip auto-fetch if we have a saved model to avoid overkill)
    await setProviderUI(true);

    if (savedBase) els.apiBase.value = savedBase;
    
    // If we have a saved model, try to fetch models first to ensure it's in the list
    if (getProvider() === 'LM Studio') {
        await refreshModels();
    }
    
    if (savedModel) {
        // Only set if the option exists
        const exists = Array.from(els.modelName.options).some(o => o.value === savedModel);
        if (exists) els.modelName.value = savedModel;
        else if (savedModel && savedModel.includes("gemini")) {
            // Special case for gemini if the list was refreshed
            const opt = document.createElement('option');
            opt.value = savedModel;
            opt.innerText = savedModel;
            els.modelName.appendChild(opt);
            els.modelName.value = savedModel;
        }
    }

    reloadPlotList();

    try {
        const customPrompt = await invoke('load_system_prompt');
        if (customPrompt && customPrompt.trim().length > 0) {
            els.promptBox.value = customPrompt;
            els.preset.value = 'Custom (File Default)';
        } else {
            els.promptBox.value = PRESETS['Standard / Literary Fiction'];
            els.preset.value = 'Standard / Literary Fiction';
        }
    } catch (_) {
        els.promptBox.value = PRESETS['Standard / Literary Fiction'];
    }
}

// Ensure DOM is ready before init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
