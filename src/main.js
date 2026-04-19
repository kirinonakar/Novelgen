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

// Signal Flags for stopping generation
let stopRequested = false;

// System Prompt Presets
const PRESETS = {
    "Standard / Literary Fiction": `You are an award-winning, bestselling novelist known for elegant prose, deep psychological insight, and compelling character arcs. 
Your writing style is immersive and vivid. Strictly adhere to the "Show, Don't Tell" principle—describe sensory details, actions, and character reactions rather than simply stating emotions. 
Maintain a consistent tone, ensure natural-sounding dialogue, and pace the narrative to keep the reader deeply engaged. Never use meta-commentary or acknowledge that you are an AI.`,
    "Web Novel / Light Novel": `You are a top-ranking web novel author known for highly addictive pacing, dynamic character interactions, and gripping cliffhangers. 
Your writing style is accessible, fast-paced, and highly entertaining. 
Use frequent paragraph breaks to make the text easy to read on mobile devices. Focus heavily on punchy, expressive dialogue and characters' internal thoughts. Keep the plot moving forward dynamically, and avoid overly dense or tedious descriptions. Every chapter must end in a way that makes the reader desperate to read the next.`,
    "Epic / Dark Fantasy": `You are a master of epic and dark fantasy. You excel at intricate world-building, crafting gritty atmospheres, and writing high-stakes conflicts. 
Use rich, evocative, and sometimes archaic vocabulary to bring the fantasy world to life. Describe the environments, magic systems, and battles with visceral sensory details. Characters should be morally complex and face difficult dilemmas. The tone should be serious, atmospheric, and immersive.`,
    "Romance / Emotional Drama": `You are a bestselling romance and drama author. Your greatest strength lies in capturing the intricate emotional dynamics, chemistry, and romantic tension between characters. 
Focus deeply on micro-expressions, body language, and the unspoken feelings between characters. Write dialogue that is witty, passionate, or emotionally raw, depending on the scene. Build the emotional stakes gradually, making the readers deeply invested in the characters' relationships.`,
    "Sci-Fi / Thriller": `You are a master of science fiction and suspense thrillers. Your prose is sharp, precise, and gripping. 
Focus on building relentless suspense and a creeping sense of tension. Describe technology, environments, or action sequences with clear, logical, yet cinematic detail. Keep the sentences relatively punchy during action or tense scenes to accelerate the pacing. Leave the readers constantly guessing what will happen next.`
};

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
        els.btnClearNovel = document.getElementById('btn-clear-novel');
        els.btnStopNovel = document.getElementById('btn-stop-novel');
        els.novelStatus = document.getElementById('novel-status');
        els.novelContent = document.getElementById('novel-content');
        els.novelContentPreview = document.getElementById('novel-content-preview');
        els.plotSeedPreview = document.getElementById('plot-seed-preview');
        els.plotContentPreview = document.getElementById('plot-content-preview');

        els.batchCount = document.getElementById('batch-count');
        els.queueCount = document.getElementById('queue-count');
        els.batchStartBtn = document.getElementById('batch-start-btn');
        els.batchStopBtn = document.getElementById('batch-stop-btn');
        
        els.modalOverlay = document.getElementById('modal-overlay');
        els.modalTitle = document.getElementById('modal-title');
        els.modalMessage = document.getElementById('modal-message');
        els.modalConfirmBtn = document.getElementById('modal-confirm');
        els.modalCancelBtn = document.getElementById('modal-cancel');

        els.providerRadios = document.getElementsByName('provider');
        els.languageRadios = document.getElementsByName('language');
        
        els.sidebar = document.querySelector('.sidebar');
        els.resizer = document.getElementById('sidebar-resizer');
        
        console.log("[Frontend] Elements initialized successfully.");
    } catch (e) {
        alert("Element initialization failed: " + e.message);
    }
}

// Helpers
const getLang = () => document.querySelector('input[name="language"]:checked')?.value || "Korean";
const getProvider = () => document.querySelector('input[name="provider"]:checked')?.value || "LM Studio";

async function detectNextChapter() {
    try {
        const next = await invoke("suggest_next_chapter", { text: els.novelContent.value, language: getLang() });
        els.resumeCh.value = next;
    } catch (e) {
        console.error("[Frontend] Chapter detection failed:", e);
    }
}

async function setProviderUI(skipModelFetch = false) {
    try {
        const provider = getProvider();
        console.log("[Frontend] Setting Provider UI for:", provider);
        
        if (provider === 'Google') {
            els.apiBase.value = "https://generativelanguage.googleapis.com/v1beta/openai/";
            els.apiKeyGroup.style.display = "flex";
            
            // Populate stable Gemini models
            const GOOGLE_MODELS = [
                "gemini-3.1-flash-lite-preview", 
                "gemini-3-flash-preview", 
                "gemini-3.1-pro-preview",
                "gemini-2.5-flash",
                "gemini-2.5-flash-lite",
                "gemma-4-26b-a4b-it",
                "gemma-4-31b-it"
            ];
            els.modelName.innerHTML = GOOGLE_MODELS.map(m => `<option value="${m}">${m}</option>`).join('');
            const savedGoogleModel = localStorage.getItem('api-model-google') || "gemini-3.1-flash-lite-preview";
            els.modelName.value = savedGoogleModel;
        } else {
            // LM Studio
            const savedLMBase = localStorage.getItem('api-base-lmstudio') || "http://localhost:1234/v1";
            els.apiBase.value = savedLMBase;
            els.apiKeyGroup.style.display = "none";
            
            // Restore saved LM Studio model (might need refreshModels to populate options first)
            const savedLMModel = localStorage.getItem('api-model-lmstudio') || "";
            if (savedLMModel) {
                const exists = Array.from(els.modelName.options).some(o => o.value === savedLMModel);
                if (exists) {
                    els.modelName.value = savedLMModel;
                } else {
                    const opt = document.createElement('option');
                    opt.value = savedLMModel;
                    opt.innerText = savedLMModel;
                    els.modelName.appendChild(opt);
                    els.modelName.value = savedLMModel;
                }
            }
        }
        
        // Google is OpenAI-compatible proxy, so refreshModels might work if the key is valid,
        // but for now let's only auto-refresh for LM Studio or if specifically requested.
        if (!skipModelFetch && provider === 'LM Studio') {
            await refreshModels();
        }
        await saveSettings();
    } catch (e) {
        console.error("[Frontend] Error in setProviderUI:", e);
    }
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
            console.log("[Frontend] Models updated.");
        }
    } catch (e) {
        console.warn("[Frontend] Model fetch failed", e);
    } finally {
        els.refreshModelsBtn.disabled = false;
        setTimeout(() => { els.apiStatus.innerText = ""; }, 3000);
    }
}

async function saveSettings() {
    console.log("[Frontend] Saving settings...");
    const provider = getProvider();
    localStorage.setItem('api-provider', provider);
    localStorage.setItem('api-base', els.apiBase.value);
    if (provider === 'LM Studio') {
        localStorage.setItem('api-base-lmstudio', els.apiBase.value);
    }
    localStorage.setItem('api-model', els.modelName.value);
    if (provider === 'Google') {
        localStorage.setItem('api-model-google', els.modelName.value);
    } else {
        localStorage.setItem('api-model-lmstudio', els.modelName.value);
    }
    
    // Persist API key to disk for Google
    if (provider === 'Google' && els.apiKeyBox.value.trim()) {
        try {
            await invoke('save_api_key', { key: els.apiKeyBox.value.trim() });
        } catch (e) {
            console.error("[Frontend] Failed to save API key to disk:", e);
        }
    }
}

function setupEventListeners() {
    console.log("[Frontend] Setting up event listeners...");
    
    document.getElementsByName('provider').forEach(r => r.addEventListener('change', () => setProviderUI()));
    document.getElementsByName('language').forEach(r => r.addEventListener('change', saveSettings));
    
    els.refreshModelsBtn.addEventListener('click', refreshModels);
    els.apiBase.addEventListener('change', () => { refreshModels(); saveSettings(); });
    els.apiKeyBox.addEventListener('change', saveSettings);
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
            let msg = e.toString();
            if (msg.includes("401")) msg += "\n\n💡 [Hint] Unauthorized. Check if your Google API Key is correctly entered.";
            else if (msg.includes("403")) msg += "\n\n💡 [Hint] Forbidden. Check your API key and project permissions.";
            else if (msg.includes("429")) msg += "\n\n💡 [Hint] Quota exceeded. You might have hit the free tier limit.";
            els.seedBox.value = `❌ Error: ${msg}`;
        } finally {
            els.autoSeedBtn.disabled = false;
        }
    });

    els.btnStopPlot.addEventListener('click', () => { 
        stopRequested = true; 
        invoke('stop_generation');
    });

    els.btnGenPlot.addEventListener('click', () => {
        if (getProvider() === 'Google' && !els.apiKeyBox.value.trim()) {
            alert("Please enter a Google API Key in the sidebar.");
            return;
        }
        if (!els.seedBox.value.trim()) {
            alert("Please enter a plot seed or use 'Auto Seed' first.");
            return;
        }

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
        if (getProvider() === 'Google' && !els.apiKeyBox.value.trim()) {
            alert("Please enter a Google API Key in the sidebar.");
            return;
        }
        const lang = getLang();
        const h = lang === 'Korean' ? [
            "1. 제목", "2. 핵심 주제의식과 소설 스타일", "3. 등장인물 이름, 설정", "4. 세계관 설정", "5. 각 장 제목과 내용, 핵심 포인트 (Ensure clear chapter markers like '제 1장', '제 2장', etc. are preserved)"
        ] : lang === 'Japanese' ? [
            "1. タイトル", "2. 核心となるテーマと小説のスタイル", "3. 登場人物の名前・設定", "4. 世界観設定", "5. 各章のタイトルと内容、重要ポイント (Ensure clear chapter markers like '第 1 章', '第 2 章', etc. are preserved)"
        ] : [
            "1. Title", "2. Core Theme and Novel Style", "3. Character Names and Settings", "4. World Building/Setting", "5. Chapter Titles, Content, and Key Points (Ensure clear chapter markers like 'Chapter 1', 'Chapter 2', etc. are preserved)"
        ];

        const prompt = `You are a master story architect. Your task is to refine and elaborate on the following plot outline for a ${els.numChap.value}-chapter novel in ${lang}.\n\n[Current Plot Outline]\n${els.plotContent.value}\n\nREFINEMENT INSTRUCTIONS:\nPlease refine the plot while STRICTLY maintaining the following 5-section format in ${lang}:\n${h.join('\n')}\n\nREFINEMENT GOALS:\n- Polish content for better emotional resonance and logical consistency.\n- Add vivid sensory details and deeper character motivations.\n- Ensure the ${els.numChap.value}-chapter pacing is dynamic and leading toward a powerful climax.\nOutput ONLY the refined plot text, without any greetings or meta-talk.`;
        
        streamPlot(prompt, els.plotContent);
    });

    els.btnRefreshPlots.addEventListener('click', reloadPlotList);

    els.btnSavePlot.addEventListener('click', async () => {
        try {
            await invoke("save_plot", { content: els.plotContent.value, language: getLang() });
            els.plotStatusMsg.innerText = "✅ Saved successfully";
            reloadPlotList();
            setTimeout(() => { els.plotStatusMsg.innerText = ""; }, 3000);
        } catch (e) {
            els.plotStatusMsg.innerText = `❌ Error: ${e}`;
        }
    });

    els.btnLoadPlot.addEventListener('click', async () => {
        if (!els.savedPlots.value) return;
        try {
            els.plotContent.value = await invoke("load_plot", { filename: els.savedPlots.value });
            els.plotStatusMsg.innerText = `✅ Loaded: ${els.savedPlots.value}`;
            setTimeout(() => { els.plotStatusMsg.innerText = ""; }, 3000);
        } catch (e) {
            els.plotStatusMsg.innerText = `❌ Error: ${e}`;
        }
    });

    els.findChBtn.addEventListener('click', detectNextChapter);

    els.btnStopNovel.addEventListener('click', () => { 
        stopRequested = true; 
        invoke('stop_generation');
    });

    els.btnGenNovel.addEventListener('click', () => {
        if (!els.plotContent.value.trim()) {
            alert('Plot is empty! Generate a plot outline first.');
            return;
        }

        taskQueue.push({
            type: 'single',
            plotOutline: els.plotContent.value,
            startChapter: parseInt(els.resumeCh.value) || 1,
            totalChapters: parseInt(els.numChap.value),
            targetTokens: parseInt(els.targetTokens.value),
            lang: getLang(),
            plotSeed: els.seedBox.value
        });
        
        els.queueCount.value = taskQueue.length;
        processQueue();
    });
    
    els.btnClearNovel.addEventListener('click', async () => {
        const confirmed = await showConfirm(
            "Clear Novel Content", 
            "Are you sure you want to clear the novel content? This action cannot be undone."
        );
        if (confirmed) {
            els.novelContent.value = "";
            renderMarkdown(els.novelContent.id);
            els.novelStatus.innerText = "Cleared.";
        }
    });

    els.batchStartBtn.addEventListener('click', () => {
        const count = parseInt(els.batchCount.value) || 1;
        for (let i = 0; i < count; i++) {
            taskQueue.push({
                type: 'batch',
                seed:          els.seedBox.value,
                totalChapters: parseInt(els.numChap.value),
                targetTokens:  parseInt(els.targetTokens.value),
                lang:          getLang(),
            });
        }
        els.queueCount.value = taskQueue.length;
        processQueue();
    });

    els.batchStopBtn.addEventListener('click', () => {
        stopRequested = true;
        invoke('stop_generation');
    });

    initTabs();
}

function initTabs() {
    document.querySelectorAll('.tabs-container').forEach(container => {
        const targetId = container.getAttribute('data-for');
        const textarea = document.getElementById(targetId);
        const preview = document.getElementById(`${targetId}-preview`);
        const tabBtns = container.querySelectorAll('.tab-btn');
        const panes = container.querySelectorAll('.tab-pane');

        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');
                
                // Update buttons
                tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Update panes
                panes.forEach(p => {
                    if (p.getAttribute('data-pane') === tab) p.classList.add('active');
                    else p.classList.remove('active');
                });

                // Render if switching to preview
                if (tab === 'preview') {
                    renderMarkdown(targetId);
                }
            });
        });

        // Live update preview if focused (optional, but good for manual edits)
        textarea.addEventListener('input', () => {
            if (preview.parentElement.classList.contains('active')) {
                renderMarkdown(targetId);
            }
        });
    });
}

function renderMarkdown(id) {
    const textarea = document.getElementById(id);
    const preview = document.getElementById(`${id}-preview`);
    if (textarea && preview && window.marked) {
        preview.innerHTML = marked.parse(textarea.value);
    }
}

// Custom Modal Helper
function showConfirm(title, message) {
    return new Promise((resolve) => {
        els.modalTitle.innerText = title;
        els.modalMessage.innerText = message;
        els.modalOverlay.style.display = 'flex';

        const onConfirm = () => {
            cleanup();
            resolve(true);
        };
        const onCancel = () => {
            cleanup();
            resolve(false);
        };
        const cleanup = () => {
            els.modalOverlay.style.display = 'none';
            els.modalConfirmBtn.removeEventListener('click', onConfirm);
            els.modalCancelBtn.removeEventListener('click', onCancel);
        };

        els.modalConfirmBtn.addEventListener('click', onConfirm);
        els.modalCancelBtn.addEventListener('click', onCancel);
    });
}

// Stream function
async function streamPlot(prompt, textarea) {
    stopRequested = false;
    els.btnGenPlot.disabled = true;
    els.btnRefinePlot.disabled = true;
    els.plotStatusMsg.innerText = "⏳ Generating...";
    
    textarea.value = "";
    
    const onEvent = new Channel();
    onEvent.onmessage = (event) => {
        // If stopped, only allow final result or error to update UI
        if (stopRequested && !event.is_finished && !event.error) return;
        
        textarea.value = event.content;
        renderMarkdown(textarea.id); // Live update preview
        
        if (event.error) {
            let msg = event.error;
            if (msg.includes("401")) msg += "\n\n💡 [Hint] Unauthorized. Check your API key.";
            else if (msg.includes("403")) msg += "\n\n💡 [Hint] Forbidden. This might be a safety filter block or permission issue.";
            else if (msg.includes("429")) msg += "\n\n💡 [Hint] Quota exceeded. Wait a moment or check your billing.";
            
            textarea.value += `\n\n[Error]: ${msg}`;
            if (msg.includes("Failed to parse input at pos 0")) {
                textarea.value += `\n\n💡 [Hint] Model mismatch detected. Ensure LM Studio chat template is correctly set for models like Gemma 4.`;
            }
            els.plotStatusMsg.innerText = "❌ Error";
        }

        if (event.is_finished) {
            els.plotStatusMsg.innerText = stopRequested ? "🛑 Stopped" : "✅ Done";
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
        els.plotStatusMsg.innerText = "❌ Error";
    } finally {
        els.btnGenPlot.disabled = false;
        els.btnRefinePlot.disabled = false;
    }
}

function initSidebarResizer() {
    const resizer = els.resizer;
    const sidebar = els.sidebar;
    if (!resizer || !sidebar) return;

    // Load saved width
    const savedWidth = localStorage.getItem('sidebar-width');
    if (savedWidth && !isNaN(parseInt(savedWidth))) {
        sidebar.style.width = savedWidth + 'px';
    }

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.classList.add('is-resizing');
        resizer.classList.add('dragging');
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        let newWidth = e.clientX;
        if (newWidth < 250) newWidth = 250;
        if (newWidth > 600) newWidth = 600;
        
        sidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        isResizing = false;
        document.body.style.cursor = 'default';
        document.body.classList.remove('is-resizing');
        resizer.classList.remove('dragging');
        
        const currentWidth = parseInt(sidebar.style.width) || sidebar.offsetWidth;
        localStorage.setItem('sidebar-width', currentWidth);
    });
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
    if (lang === "Korean") pattern = /(?:^|\n)#?\s*제?\s*(\d+)\s*[장]/gi;
    else if (lang === "Japanese") pattern = /(?:^|\n)#?\s*第?\s*(\d+)\s*[章]/gi;
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
    try {
        const onEvent = new Channel();
        onEvent.onmessage = (event) => {
            // If stopped, only allow final result or error to update UI
            if (stopSignal() && !event.is_finished && !event.error) return;
            
            onStatus(event.error ? `❌ Error: ${event.error}` : (event.status || (event.is_finished ? "✅ Done" : `Writing...`)));
            
            // Smart scroll: only scroll to bottom if already at the bottom
            const threshold = 50; 
            const isAtBottom = els.novelContent.scrollHeight - els.novelContent.clientHeight <= els.novelContent.scrollTop + threshold;
            
            els.novelContent.value = event.content;
            renderMarkdown(els.novelContent.id); // Live update preview
            
            if (isAtBottom) {
                els.novelContent.scrollTop = els.novelContent.scrollHeight;
            }
        };

        await invoke("generate_novel", {
            params: {
                api_base: els.apiBase.value,
                model_name: els.modelName.value,
                api_key: els.apiKeyBox.value || "lm-studio",
                system_prompt: els.promptBox.value,
                plot_outline: plotOutline,
                initial_text: initialText,
                start_chapter: startChapter,
                total_chapters: totalChapters,
                target_tokens: targetTokens,
                language: lang,
                temperature: parseFloat(els.temp.value),
                top_p: parseFloat(els.topP.value),
                repetition_penalty: parseFloat(els.repetitionPenalty.value),
                plot_seed: plotSeed,
                novel_filename: novelFilename
            },
            onEvent
        });
        onStatus("Done");
    } catch (e) {
        onStatus(`❌ Error: ${e}`);
    }

    return { fullNovelText: els.novelContent.value, novelFilename };
}

// ──────────────────────────────────────────────────────────────
// UNIFIED TASK QUEUE
// ──────────────────────────────────────────────────────────────
let taskQueue     = [];
let isWorkerRunning = false;

async function processQueue() {
    if (isWorkerRunning) return;
    isWorkerRunning = true;
    stopRequested = false;

    while (taskQueue.length > 0 && !stopRequested) {
        els.queueCount.value = taskQueue.length;
        const job = taskQueue.shift();
        els.queueCount.value = taskQueue.length;

        if (job.type === 'batch') {
            await runBatchJob(job);
        } else if (job.type === 'single') {
            await runSingleJob(job);
        }
    }

    isWorkerRunning = false;
    els.queueCount.value = taskQueue.length;
    els.novelStatus.innerText = stopRequested ? '🛑 Stopped.' : '✅ Done';
}

async function runSingleJob(job) {
    const { plotOutline, startChapter, totalChapters, targetTokens, lang, plotSeed } = job;
    
    // Clear existing content and start fresh
    els.novelContent.value = "";
    renderMarkdown(els.novelContent.id);
    let initialText        = "";
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
            stopSignal: () => stopRequested,
            plotSeed: plotSeed
        });
        els.novelContent.value = fullNovelText;
    } catch (e) {
        els.novelStatus.innerText = `❌ Error: ${e}`;
    }

    await detectNextChapter();
}

async function runBatchJob(job) {
    els.novelStatus.innerText = `[Batch] Generating plot (${taskQueue.length + 1} remaining)...`;

    const lang = job.lang;
    const h = lang === 'Korean' ? [
        '1. 제목', '2. 핵심 주제의식과 소설 스타일', '3. 등장인물 이름, 설정', '4. 세계관 설정',
        '5. 각 장 제목과 내용, 핵심 포인트 (Include clear markers like \'제 1장\', \'제 2장\', etc.)'
    ] : lang === 'Japanese' ? [
        '1. タイトル', '2. 核心となるテーマと小説のスタイル', '3. 登場人物の名前・設定', '4. 세계관 설정',
        '5. 각 장의 제목과 내용, 중요 포인트 (Include clear markers like \'第 1 章\', \'第 2 章\', etc.)'
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

    if (stopRequested) return;

    // 2. Generate novel from that plot
    els.novelContent.value = '';
    let currentText = '';
    let safetyLimit = 0;

    while (true) {
        const nextCh = suggestNextChapter(currentText, lang);
        if (nextCh > job.totalChapters || stopRequested) break;
        if (safetyLimit++ > job.totalChapters + 3) break;

        try {
            const result = await generateNovel({
                startChapter: nextCh, totalChapters: job.totalChapters,
                targetTokens: job.targetTokens, lang,
                plotOutline, initialText: currentText,
                onStatus: (msg) => { els.novelStatus.innerText = `[Batch] ${msg}`; },
                stopSignal: () => stopRequested,
                plotSeed: job.seed
            });
            currentText = result.fullNovelText;
            els.novelContent.value = currentText;
        } catch (e) {
            els.novelStatus.innerText = `[Batch] Error: ${e}`;
            break;
        }

        const nextAfter = suggestNextChapter(currentText, lang);
        if (nextAfter <= nextCh) break; 
    }
    
    await detectNextChapter();
}


// ──────────────────────────────────────────────────────────────
// ON LOAD
// ──────────────────────────────────────────────────────────────
async function init() {
    initElements();
    setupEventListeners();
    initSidebarResizer();

    // 1. Load API Key from gemini.txt
    try {
        console.log("[Frontend] Requesting API key load...");
        const key = await invoke('load_api_key');
        if (key) {
            console.log("[Frontend] API Key loaded from disk.");
            els.apiKeyBox.value = key;
        } else {
            console.log("[Frontend] No API Key found on disk (or empty).");
        }
    } catch (e) {
        console.error("[Frontend] API Key load failed:", e);
    }

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
    } else if (getProvider() === 'LM Studio') {
        els.modelName.value = "unsloth/gemma-4-31b-it";
    }

    reloadPlotList();

    try {
        console.log("[Frontend] Requesting system prompt load...");
        const customPrompt = await invoke('load_system_prompt');
        console.log("[Frontend] System prompt loaded:", customPrompt?.substring(0, 50) + "...");
        if (customPrompt && customPrompt.trim().length > 0) {
            els.promptBox.value = customPrompt;
            els.preset.value = 'Custom (File Default)';
        } else {
            els.promptBox.value = PRESETS['Standard / Literary Fiction'];
            els.preset.value = 'Standard / Literary Fiction';
        }
    } catch (e) {
        console.error("[Frontend] System prompt load failed:", e);
        els.promptBox.value = PRESETS['Standard / Literary Fiction'];
    }
}

// Ensure DOM is ready before init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
