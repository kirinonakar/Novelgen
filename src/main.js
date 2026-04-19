import { invoke, Channel } from "@tauri-apps/api/core";

// DOM Elements
const els = {
    providerRadios: document.getElementsByName('provider'),
    apiBase: document.getElementById('api-base'),
    apiKeyGroup: document.getElementById('group-api-key'),
    apiKeyBox: document.getElementById('api-key'),
    modelName: document.getElementById('model-name'),
    refreshModelsBtn: document.getElementById('refresh-models-btn'),
    
    preset: document.getElementById('system-preset'),
    promptBox: document.getElementById('system-prompt'),
    savePromptBtn: document.getElementById('save-prompt-btn'),
    promptStatus: document.getElementById('prompt-status-msg'),
    
    langRadios: document.getElementsByName('language'),
    numChap: document.getElementById('num-chapters'),
    targetTokens: document.getElementById('target-tokens'),
    temp: document.getElementById('temperature'),
    tempVal: document.getElementById('temp-val'),
    topP: document.getElementById('top-p'),
    topPVal: document.getElementById('topp-val'),
    resumeCh: document.getElementById('resume-chapter'),
    findChBtn: document.getElementById('find-ch-btn'),
    openFolderBtn: document.getElementById('open-out-folder-btn'),
    
    seedBox: document.getElementById('plot-seed'),
    autoSeedBtn: document.getElementById('auto-seed-btn'),
    btnGenPlot: document.getElementById('btn-gen-plot'),
    btnRefinePlot: document.getElementById('btn-refine-plot'),
    btnStopPlot: document.getElementById('btn-stop-plot'),
    
    savedPlots: document.getElementById('saved-plots'),
    btnLoadPlot: document.getElementById('btn-load-plot'),
    btnRefreshPlots: document.getElementById('btn-refresh-plots'),
    btnSavePlot: document.getElementById('btn-save-plot'),
    plotStatusMsg: document.getElementById('plot-status-msg'),
    plotContent: document.getElementById('plot-content'),
    
    btnGenNovel: document.getElementById('btn-gen-novel'),
    btnStopNovel: document.getElementById('btn-stop-novel'),
    novelStatus: document.getElementById('novel-status'),
    novelContent: document.getElementById('novel-content'),

    batchCount: document.getElementById('batch-count'),
    queueCount: document.getElementById('queue-count'),
    batchStartBtn: document.getElementById('batch-start-btn'),
    batchStopBtn: document.getElementById('batch-stop-btn')
};

const PRESETS = {
    "Standard / Literary Fiction": 'You are an award-winning, bestselling novelist known for elegant prose, deep psychological insight, and compelling character arcs. \nYour writing style is immersive and vivid. Strictly adhere to the "Show, Don\'t Tell" principle—describe sensory details, actions, and character reactions rather than simply stating emotions. \nMaintain a consistent tone, ensure natural-sounding dialogue, and pace the narrative to keep the reader deeply engaged. Never use meta-commentary or acknowledge that you are an AI.',
    "Web Novel / Light Novel": 'You are a top-ranking web novel author known for highly addictive pacing, dynamic character interactions, and gripping cliffhangers. \nYour writing style is accessible, fast-paced, and highly entertaining. \nUse frequent paragraph breaks to make the text easy to read on mobile devices. Focus heavily on punchy, expressive dialogue and characters\' internal thoughts. Keep the plot moving forward dynamically, and avoid overly dense or tedious descriptions. Every chapter must end in a way that makes the reader desperate to read the next.',
    "Epic / Dark Fantasy": 'You are a master of epic and dark fantasy. You excel at intricate world-building, crafting gritty atmospheres, and writing high-stakes conflicts. \nUse rich, evocative, and sometimes archaic vocabulary to bring the fantasy world to life. Describe the environments, magic systems, and battles with visceral sensory details. Characters should be morally complex and face difficult dilemmas. The tone should be serious, atmospheric, and immersive.',
    "Romance / Emotional Drama": 'You are a bestselling romance and drama author. Your greatest strength lies in capturing the intricate emotional dynamics, chemistry, and romantic tension between characters. \nFocus deeply on micro-expressions, body language, and the unspoken feelings between characters. Write dialogue that is witty, passionate, or emotionally raw, depending on the scene. Build the emotional stakes gradually, making the readers deeply invested in the characters\' relationships.',
    "Sci-Fi / Thriller": 'You are a master of science fiction and suspense thrillers. Your prose is sharp, precise, and gripping. \nFocus on building relentless suspense and a creeping sense of tension. Describe technology, environments, or action sequences with clear, logical, yet cinematic detail. Keep the sentences relatively punchy during action or tense scenes to accelerate the pacing. Leave the readers constantly guessing what will happen next.'
};

let stopPlotRequested = false;
let stopNovelRequested = false;

// Helpers
const getLang = () => Array.from(els.langRadios).find(r => r.checked).value;
const getProvider = () => Array.from(els.providerRadios).find(r => r.checked).value;

function setProviderUI() {
    if (getProvider() === 'Google') {
        els.apiBase.value = "https://generativelanguage.googleapis.com/v1beta/openai/";
        els.apiKeyGroup.style.display = "flex";
        els.modelName.innerHTML = `
            <option value="gemini-3.1-flash-lite-preview">gemini-3.1-flash-lite-preview</option>
            <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
            <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
            <option value="gemini-2.5-flash">gemini-2.5-flash</option>
            <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</option>
        `;
    } else {
        els.apiBase.value = "http://localhost:1234/v1";
        els.apiKeyGroup.style.display = "none";
        refreshModels();
    }
}

async function refreshModels() {
    try {
        const models = await invoke("fetch_models", { apiBase: els.apiBase.value });
        if (models && models.length > 0) {
            els.modelName.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
        }
    } catch (e) {
        console.warn("Could not fetch models", e);
    }
}

// Events
Array.from(els.providerRadios).forEach(r => r.addEventListener('change', setProviderUI));
els.refreshModelsBtn.addEventListener('click', refreshModels);
els.preset.addEventListener('change', (e) => {
    if (PRESETS[e.target.value]) els.promptBox.value = PRESETS[e.target.value];
});
els.temp.addEventListener('input', e => els.tempVal.innerText = parseFloat(e.target.value).toFixed(1));
els.topP.addEventListener('input', e => els.topPVal.innerText = parseFloat(e.target.value).toFixed(2));
els.openFolderBtn.addEventListener('click', () => invoke("open_output_folder"));

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

// Generate Seed
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
                top_p: parseFloat(els.topP.value)
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

els.btnStopPlot.addEventListener('click', () => { stopPlotRequested = true; });

// Generate Plot
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

// Refine Plot
els.btnRefinePlot.addEventListener('click', () => {
    const lang = getLang();
    const prompt = `You are a master story architect. Refine and elaborate on the following plot outline for a ${els.numChap.value}-chapter novel in ${lang}.\n\n[Current Plot Outline]\n${els.plotContent.value}\n\nMaintain the 5-section format and polish content for better emotional resonance and pacing.`;
    streamPlot(prompt, els.plotContent);
});

// Plot Save/Load
async function reloadPlotList() {
    try {
        const plots = await invoke("get_saved_plots");
        els.savedPlots.innerHTML = '<option value="" disabled selected>Select a saved plot...</option>' + 
            plots.map(p => `<option value="${p}">${p}</option>`).join('');
    } catch (e) {}
}

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

// ──────────────────────────────────────────────────────────────
// REGEX UTILITIES  (ported from app.py)
// ──────────────────────────────────────────────────────────────

/**
 * Split a master plot outline into a map of { chapterNumber: outlineText }.
 * Recognises Chapter N / 제 N장 / 第 N 章 markers.
 */
function splitPlotIntoChapters(plotText) {
    const pattern = /(?:Chapter\s*(\d+)|제\s*(\d+)\s*장|第\s*(\d+)\s*章)/gi;
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
 * Scan existing novel text and return the next chapter number that should be written.
 * A chapter is only counted if it has >= 300 characters of body text.
 */
function suggestNextChapter(novelText, lang) {
    let pattern;
    if (lang === 'Korean')    pattern = /(?:^|\n)#?\s*제?\s*(\d+)\s*장/gi;
    else if (lang === 'Japanese') pattern = /(?:^|\n)#?\s*第?\s*(\d+)\s*章/gi;
    else                      pattern = /(?:^|\n)#?\s*Chapter\s*(\d+)/gi;

    const matches = [...novelText.matchAll(pattern)];
    let maxValid = 0;
    for (let i = 0; i < matches.length; i++) {
        const num = parseInt(matches[i][1]);
        const bodyStart = matches[i].index + matches[i][0].length;
        const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : novelText.length;
        const body = novelText.slice(bodyStart, bodyEnd).trim();
        if (body.length >= 300) maxValid = Math.max(maxValid, num);
    }
    return maxValid + 1;
}

// Wire up the "Detect" button
els.findChBtn.addEventListener('click', () => {
    const next = suggestNextChapter(els.novelContent.value, getLang());
    els.resumeCh.value = next;
});

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
}) {
    const apiBase       = els.apiBase.value;
    const modelName     = els.modelName.value;
    const apiKey        = els.apiKeyBox.value || 'lm-studio';
    const systemPrompt  = els.promptBox.value;
    const temp          = parseFloat(els.temp.value);
    const topP          = parseFloat(els.topP.value);

    // Determine a save-file name for this novel session
    if (!novelFilename) {
        novelFilename = await invoke('get_next_novel_filename');
    }

    const chapterPlots = splitPlotIntoChapters(plotOutline);
    let fullNovelText  = initialText;

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

        await invoke('generate_plot', {
            params: { api_base: apiBase, model_name: modelName, api_key: apiKey,
                      system_prompt: systemPrompt, prompt, temperature: temp, top_p: topP },
            onEvent
        });

        if (stopSignal()) break;

        fullNovelText += chTitle + chapterText + '\n';

        // ── POST-CHAPTER: summarize ──
        onStatus(`Summarizing Chapter ${ch}...`);
        let summary = '';
        try {
            summary = await invoke('chat_completion', {
                apiBase, modelName, apiKey,
                systemPrompt: 'You are a helpful assistant.',
                prompt: `Summarize the following chapter in 3-4 sentences in ${lang}.\n\nChapter:\n${chapterText.substring(0, 4000)}`,
                temperature: 0.5, topP: 0.95, maxTokens: 500
            });
        } catch (_) { /* best-effort */ }

        chapterSummaries.push(summary);

        // ── Sliding-window merge (> 5 → merge oldest into grand summary) ──
        if (chapterSummaries.length > 5) {
            const oldest = chapterSummaries.shift();
            if (oldest) {
                onStatus('Compressing older summaries...');
                try {
                    grandSummary = await invoke('chat_completion', {
                        apiBase, modelName, apiKey,
                        systemPrompt: 'You are a helpful assistant.',
                        prompt: `Update the 'Grand Summary' by incorporating the 'New Chapter Summary'.\n`
                              + `Keep it concise (5-8 sentences), chronological. Write in ${lang}.\n\n`
                              + `Current Grand Summary:\n${grandSummary}\n\n`
                              + `New Chapter Summary:\n${oldest}`,
                        temperature: 0.5, topP: 0.95, maxTokens: 800
                    });
                } catch (_) {
                    grandSummary = grandSummary ? grandSummary + '\n' + oldest : oldest;
                }
            }
        }

        // ── Checkpoint: save txt + json to disk ──
        const metaJson = JSON.stringify({
            language: lang, num_chapters: totalChapters,
            current_chapter: ch, grand_summary: grandSummary,
            chapter_summaries: chapterSummaries
        }, null, 2);
        try {
            await invoke('save_novel_state', {
                filename: novelFilename,
                textContent: fullNovelText,
                metadataJson: metaJson
            });
        } catch (_) { /* non-fatal */ }

        els.resumeCh.value = ch + 1;
    }

    return { fullNovelText, novelFilename };
}

// ──────────────────────────────────────────────────────────────
// SINGLE NOVEL BUTTON
// ──────────────────────────────────────────────────────────────
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
        });
        els.novelContent.value = fullNovelText;
    } catch (e) {
        els.novelStatus.innerText = `❌ Error: ${e}`;
    }

    els.novelStatus.innerText  = stopNovelRequested ? 'Stopped.' : '✅ Finished!';
    els.btnGenNovel.style.display  = 'inline-flex';
    els.btnStopNovel.style.display = 'none';
});

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
                temperature: parseFloat(els.temp.value), top_p: parseFloat(els.topP.value)
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

// ──────────────────────────────────────────────────────────────
// ON LOAD
// ──────────────────────────────────────────────────────────────
async function init() {
    setProviderUI();
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
init();
