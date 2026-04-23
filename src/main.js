// Robust error reporting
window.onerror = function(msg, url, lineNo, columnNo, error) {
    const errorMsg = `Error: ${msg}\nLine: ${lineNo}\nColumn: ${columnNo}\nURL: ${url}`;
    console.error(errorMsg);
    showToast("NovelGen Runtime Error", 'error');
    return false;
};

console.log("[Frontend] Script starting...");

// Tauri API access pattern for v2 global
let invoke, Channel;
if (window.marked) {
    const markedOptions = {
        breaks: true,
        gfm: true
    };
    
    // Add KaTeX extension if available
    if (window.markedKatex) {
        window.marked.use(window.markedKatex({
            throwOnError: false,
            displayMode: false,
            nonStandard: true // Allow rendering even if there are no spaces around $ or $$
        }));
    }
    
    window.marked.use(markedOptions);
}
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
    showToast("API Initialization failed: " + e.message, 'error');
}

// ──────────────────────────────────────────────────────────────
// STATE MANAGEMENT
// ──────────────────────────────────────────────────────────────
const AppState = {
    stopRequested: false,
    isPaused: false,
    isWorkerRunning: false,
    taskQueue: [],
    lastRanJobUid: null,

    // Reset for fresh start
    reset: function() {
        this.taskQueue = [];
        this.isPaused = false;
        this.lastRanJobUid = null;
        this.stopRequested = false;
    }
};

// ──────────────────────────────────────────────────────────────
// TOAST NOTIFICATION SYSTEM
// ──────────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = {
        success: '✅',
        error: '❌',
        info: 'ℹ️',
        warning: '⚠️'
    };

    toast.innerHTML = `
        <div class="toast-icon">${icons[type] || 'ℹ️'}</div>
        <div class="toast-message">${message}</div>
        <div class="toast-close">✕</div>
    `;

    container.appendChild(toast);

    const removeToast = () => {
        if (toast.parentElement) {
            toast.classList.add('removing');
            setTimeout(() => {
                if (toast.parentElement) container.removeChild(toast);
            }, 300);
        }
    };

    const timer = setTimeout(removeToast, duration);

    toast.querySelector('.toast-close').addEventListener('click', () => {
        clearTimeout(timer);
        removeToast();
    });
}

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
const CUSTOM_SYSTEM_PROMPT_PRESET = 'Custom (File Default)';
const DEFAULT_SYSTEM_PROMPT_PRESET = 'Standard / Literary Fiction';

// DOM Elements
const els = {};
const THEME_STORAGE_KEY = 'ui-theme';
const PREVIEW_ELEMENT_MAP = {
    seed: 'plotSeedPreview',
    plot: 'plotContentPreview',
    novel: 'novelContentPreview'
};

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

        els.savedNovels = document.getElementById('saved-novels');
        els.btnLoadNovel = document.getElementById('btn-load-novel');
        els.btnRefreshNovels = document.getElementById('btn-refresh-novels');

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
        els.themeToggle = document.getElementById('theme-toggle');
        
        els.sidebar = document.querySelector('.sidebar');
        els.resizer = document.getElementById('sidebar-resizer');
        
        els.seedFsSlider = document.getElementById('seed-fs-slider');
        els.seedFsVal = document.getElementById('seed-fs-val');
        els.seedComfortToggle = document.getElementById('seed-comfort-toggle');
        els.plotFsSlider = document.getElementById('plot-fs-slider');
        els.plotFsVal = document.getElementById('plot-fs-val');
        els.plotComfortToggle = document.getElementById('plot-comfort-toggle');
        els.novelFsSlider = document.getElementById('novel-fs-slider');
        els.novelFsVal = document.getElementById('novel-fs-val');
        els.novelComfortToggle = document.getElementById('novel-comfort-toggle');
        
        console.log("[Frontend] Elements initialized successfully.");
    } catch (e) {
        showToast("Element initialization failed: " + e.message, 'error');
    }
}

// Helpers
const getLang = () => document.querySelector('input[name="language"]:checked')?.value || "Korean";
const getProvider = () => document.querySelector('input[name="provider"]:checked')?.value || "LM Studio";

function getSavedTheme() {
    try {
        const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
        return savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : null;
    } catch (e) {
        console.warn("[Frontend] Failed to read saved theme:", e);
        return null;
    }
}

function getSystemTheme() {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncThemeToggle(theme) {
    if (!els.themeToggle) return;

    const isDark = theme === 'dark';
    const nextThemeLabel = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    const icon = isDark ? '☀️' : '🌙';
    const iconEl = els.themeToggle.querySelector('.theme-toggle-icon');

    els.themeToggle.dataset.theme = theme;
    els.themeToggle.setAttribute('aria-pressed', String(isDark));
    els.themeToggle.setAttribute('aria-label', nextThemeLabel);
    els.themeToggle.setAttribute('title', nextThemeLabel);
    if (iconEl) iconEl.textContent = icon;
}

function syncNativeWindowTheme(theme) {
    if (typeof invoke !== 'function') return;

    invoke('set_window_theme', { theme }).catch((e) => {
        console.warn("[Frontend] Failed to sync native window theme:", e);
    });
}

function applyTheme(theme, { persist = true } = {}) {
    const resolvedTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = resolvedTheme;
    syncThemeToggle(resolvedTheme);
    syncNativeWindowTheme(resolvedTheme);

    if (!persist) return;

    try {
        localStorage.setItem(THEME_STORAGE_KEY, resolvedTheme);
    } catch (e) {
        console.warn("[Frontend] Failed to persist theme:", e);
    }
}

function toggleTheme() {
    const currentTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

function initTheme() {
    const currentTheme = document.documentElement.dataset.theme;
    const resolvedTheme =
        getSavedTheme() ||
        (currentTheme === 'dark' || currentTheme === 'light' ? currentTheme : null) ||
        getSystemTheme();

    applyTheme(resolvedTheme, { persist: false });
}

async function detectNextChapter() {
    try {
        let lastCompleted = null;
        try {
            const metaResult = await invoke('get_latest_novel_metadata');
            if (metaResult) {
                const meta = JSON.parse(metaResult[1]);
                lastCompleted = meta.current_chapter;
            }
        } catch (e) {
            console.warn("[Frontend] Failed to fetch metadata for detection:", e);
        }

        let next = await invoke("suggest_next_chapter", { 
            text: els.novelContent.value, 
            language: getLang(),
            last_completed_ch: lastCompleted
        });

        const total = parseInt(els.numChap.value) || 0;
        if (total > 0 && next > total) {
            next = 1;
        }
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
    
    // Persist settings to local storage only.
    // Disk persistence for API key via save_api_key is removed per user request.

    localStorage.setItem('fs-seed', els.seedFsSlider.value);
    localStorage.setItem('fs-plot', els.plotFsSlider.value);
    localStorage.setItem('fs-novel', els.novelFsSlider.value);
    localStorage.setItem('comfort-seed', String(els.seedComfortToggle.checked));
    localStorage.setItem('comfort-plot', String(els.plotComfortToggle.checked));
    localStorage.setItem('comfort-novel', String(els.novelComfortToggle.checked));
}

/**
 * Update font size for a specific section
 * @param {string} type - 'seed', 'plot', or 'novel'
 * @param {number|string} size - size in px
 */
function setFontSize(type, size) {
    const valEl = els[`${type}FsVal`];
    if (valEl) valEl.innerText = size;
    document.documentElement.style.setProperty(`--${type}-font-size`, `${size}px`);
}

function setComfortMode(type, enabled) {
    const previewKey = PREVIEW_ELEMENT_MAP[type];
    const previewEl = previewKey ? els[previewKey] : null;
    const toggleEl = els[`${type}ComfortToggle`];
    const isEnabled = Boolean(enabled);

    if (toggleEl) toggleEl.checked = isEnabled;
    if (previewEl) previewEl.classList.toggle('comfort-mode', isEnabled);
}

function isTxtFile(file) {
    return Boolean(file?.name?.toLowerCase().endsWith('.txt'));
}

function eventHasFiles(event) {
    const types = event.dataTransfer?.types;
    if (types) {
        if (typeof types.includes === 'function' && types.includes('Files')) return true;
        if (typeof types.contains === 'function' && types.contains('Files')) return true;
    }

    if (event.dataTransfer?.files?.length) return true;
    return Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file');
}

function getDroppedFile(event) {
    if (event.dataTransfer?.files?.length) {
        return event.dataTransfer.files[0];
    }

    const fileItem = Array.from(event.dataTransfer?.items || []).find(item => item.kind === 'file');
    return fileItem?.getAsFile() || null;
}

function readTextFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
        reader.readAsText(file);
    });
}

async function loadCustomPromptIntoEditor({ fallbackToDefault = true } = {}) {
    try {
        const customPrompt = await invoke('load_system_prompt');
        console.log("[Frontend] System prompt loaded:", customPrompt?.substring(0, 50) + "...");

        if (customPrompt && customPrompt.trim().length > 0) {
            els.promptBox.value = customPrompt;
            if (els.preset) els.preset.value = CUSTOM_SYSTEM_PROMPT_PRESET;
            return true;
        }
    } catch (e) {
        console.error("[Frontend] System prompt load failed:", e);
    }

    if (fallbackToDefault) {
        els.promptBox.value = PRESETS[DEFAULT_SYSTEM_PROMPT_PRESET];
        if (els.preset) els.preset.value = DEFAULT_SYSTEM_PROMPT_PRESET;
    }

    return false;
}

function installGlobalFileDropGuards() {
    ['dragenter', 'dragover', 'drop'].forEach(eventName => {
        document.addEventListener(eventName, (event) => {
            if (!eventHasFiles(event)) return;
            event.preventDefault();
        });
    });
}

function setupTxtDropTarget(element, { targetId, label }) {
    if (!element) return;
    let dragDepth = 0;

    element.addEventListener('dragenter', (event) => {
        if (!eventHasFiles(event)) return;
        event.preventDefault();
        dragDepth += 1;
        element.classList.add('file-drop-active');
    });

    element.addEventListener('dragover', (event) => {
        if (!eventHasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        element.classList.add('file-drop-active');
    });

    element.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            element.classList.remove('file-drop-active');
        }
    });

    element.addEventListener('drop', async (event) => {
        if (!eventHasFiles(event)) return;
        event.preventDefault();
        dragDepth = 0;
        element.classList.remove('file-drop-active');

        const file = getDroppedFile(event);
        if (!file) return;

        if (!isTxtFile(file)) {
            showToast(`Only .txt files can be dropped into ${label}.`, 'warning');
            return;
        }

        const textarea = document.getElementById(targetId);
        if (!textarea) return;

        try {
            const text = await readTextFile(file);
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            renderMarkdown(targetId);

            if (targetId === els.promptBox?.id && els.preset) {
                els.preset.value = CUSTOM_SYSTEM_PROMPT_PRESET;
            }

            if (targetId === els.novelContent?.id) {
                await detectNextChapter();
            }

            showToast(`Loaded ${file.name} into ${label}.`, 'success');
        } catch (e) {
            console.error(`[Frontend] Failed to read dropped file for ${label}:`, e);
            showToast(`Failed to load ${file.name}.`, 'error');
        }
    });
}

function setupEventListeners() {
    console.log("[Frontend] Setting up event listeners...");
    installGlobalFileDropGuards();
    
    document.getElementsByName('provider').forEach(r => r.addEventListener('change', () => setProviderUI()));
    document.getElementsByName('language').forEach(r => r.addEventListener('change', saveSettings));
    els.themeToggle?.addEventListener('click', toggleTheme);
    
    els.refreshModelsBtn.addEventListener('click', refreshModels);
    els.apiBase.addEventListener('change', () => { refreshModels(); saveSettings(); });
    els.apiKeyBox.addEventListener('change', saveSettings);
    els.modelName.addEventListener('change', saveSettings);
    setupTxtDropTarget(els.promptBox.closest('.input-group') || els.promptBox, {
        targetId: els.promptBox.id,
        label: 'System Prompt Details'
    });
    
    els.preset.addEventListener('change', async (e) => {
        if (e.target.value === CUSTOM_SYSTEM_PROMPT_PRESET) {
            await loadCustomPromptIntoEditor();
            return;
        }

        if (PRESETS[e.target.value]) els.promptBox.value = PRESETS[e.target.value];
    });
    els.temp.addEventListener('input', e => els.tempVal.innerText = parseFloat(e.target.value).toFixed(1));
    els.topP.addEventListener('input', e => els.topPVal.innerText = parseFloat(e.target.value).toFixed(2));

    // Font Size Listeners
    els.seedFsSlider.addEventListener('input', e => { setFontSize('seed', e.target.value); saveSettings(); });
    els.plotFsSlider.addEventListener('input', e => { setFontSize('plot', e.target.value); saveSettings(); });
    els.novelFsSlider.addEventListener('input', e => { setFontSize('novel', e.target.value); saveSettings(); });
    els.seedComfortToggle.addEventListener('change', e => { setComfortMode('seed', e.target.checked); saveSettings(); });
    els.plotComfortToggle.addEventListener('change', e => { setComfortMode('plot', e.target.checked); saveSettings(); });
    els.novelComfortToggle.addEventListener('change', e => { setComfortMode('novel', e.target.checked); saveSettings(); });
    els.repetitionPenalty.addEventListener('input', e => els.rpVal.innerText = parseFloat(e.target.value).toFixed(2));
    els.openFolderBtn.addEventListener('click', () => {
        console.log("[Frontend] Open Folder clicked");
        invoke("open_output_folder").catch(e => showToast("Failed to open folder: " + e, 'error'));
    });

    els.btnRefreshNovels.addEventListener('click', reloadNovelList);
    els.btnLoadNovel.addEventListener('click', loadNovel);

    els.savePromptBtn.addEventListener('click', async () => {
        try {
            els.promptStatus.innerText = "Saving...";
            const msg = await invoke("save_system_prompt", { content: els.promptBox.value });
            els.promptStatus.innerText = msg;
            setTimeout(() => els.promptStatus.innerText = "Idle", 3000);
        } catch (e) {
            els.promptStatus.innerText = "❌ Error: " + e;
        }
    });

    els.autoSeedBtn.addEventListener('click', async () => {
        const currentSeed = els.seedBox.value;
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
                topP: parseFloat(els.topP.value),
                inputSeed: currentSeed
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
        if (AppState.isWorkerRunning && !AppState.stopRequested) {
            AppState.stopRequested = true;
            AppState.isPaused = true;
            invoke('stop_generation');
            updateBatchButtons();
        } else {
            AppState.stopRequested = true; 
            invoke('stop_generation');
        }
    });

    els.btnGenPlot.addEventListener('click', () => {
        if (getProvider() === 'Google' && !els.apiKeyBox.value.trim()) {
            showToast("Please enter a Google API Key in the sidebar.", 'warning');
            return;
        }
        if (!els.seedBox.value.trim()) {
            showToast("Please enter a plot seed or use 'Auto Seed' first.", 'info');
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
            showToast("Please enter a Google API Key in the sidebar.", 'warning');
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
            setTimeout(() => { els.plotStatusMsg.innerText = "Idle"; }, 3000);
        } catch (e) {
            els.plotStatusMsg.innerText = `❌ Error: ${e}`;
        }
    });

    els.btnLoadPlot.addEventListener('click', async () => {
        if (!els.savedPlots.value) return;
        try {
            els.plotContent.value = await invoke("load_plot", { filename: els.savedPlots.value });
            els.plotStatusMsg.innerText = `✅ Loaded: ${els.savedPlots.value}`;
            setTimeout(() => { els.plotStatusMsg.innerText = "Idle"; }, 3000);
        } catch (e) {
            els.plotStatusMsg.innerText = `❌ Error: ${e}`;
        }
    });

    els.findChBtn.addEventListener('click', detectNextChapter);

    els.btnStopNovel.addEventListener('click', () => { 
        if (AppState.isWorkerRunning && !AppState.stopRequested) {
            AppState.stopRequested = true;
            AppState.isPaused = true;
            invoke('stop_generation');
            updateBatchButtons();
        } else {
            AppState.stopRequested = true; 
            invoke('stop_generation');
        }
    });

    els.btnGenNovel.addEventListener('click', () => {
        if (!els.plotContent.value.trim()) {
            showToast('Plot is empty! Generate a plot outline first.', 'warning');
            return;
        }

        // If we were paused or stopped, clear the old queue/state first 
        // to ensure THIS novel starts fresh and isn't blocked by a stale queue.
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

    els.batchStartBtn.addEventListener('click', async () => {
        if (AppState.isPaused) {
            // Resume
            AppState.isPaused = false;
            AppState.stopRequested = false; 
            await invoke('resume_generation');
            
            updateBatchButtons();
            processQueue();
            return;
        }

        const count = parseInt(els.batchCount.value) || 1;
        for (let i = 0; i < count; i++) {
            AppState.taskQueue.push({
                uid: Date.now() + Math.random(),
                type: 'batch',
                seed:          els.seedBox.value,
                totalChapters: parseInt(els.numChap.value),
                targetTokens:  parseInt(els.targetTokens.value),
                lang:          getLang(),
            });
        }
        els.queueCount.value = AppState.taskQueue.length;
        processQueue();
    });

    els.batchStopBtn.addEventListener('click', () => {
        if (AppState.isWorkerRunning && !AppState.stopRequested) {
            // First click: Stop/Pause
            AppState.stopRequested = true;
            AppState.isPaused = true;
            invoke('stop_generation');
            updateBatchButtons();
        } else if (AppState.isPaused || AppState.taskQueue.length > 0) {
            // Second click or clicked while paused
            if (AppState.taskQueue.length > 0 && AppState.taskQueue[0].uid === AppState.lastRanJobUid) {
                // Clear the stopped job ONLY
                AppState.taskQueue.shift();
                AppState.lastRanJobUid = null;
                
                // Clear UI content for this job
                els.plotContent.value = "";
                els.novelContent.value = "";
                renderMarkdown(els.plotContent.id);
                renderMarkdown(els.novelContent.id);
                
                els.novelStatus.innerText = "Stopped job cleared.";
                els.queueCount.value = AppState.taskQueue.length;
                if (AppState.taskQueue.length === 0) {
                    AppState.isPaused = false;
                }
            } else {
                // All Clear
                AppState.reset();
                els.queueCount.value = 0;
                
                // Clear UI content
                els.plotContent.value = "";
                els.novelContent.value = "";
                renderMarkdown(els.plotContent.id);
                renderMarkdown(els.novelContent.id);
                
                els.novelStatus.innerText = "Queue cleared.";
            }
            updateBatchButtons();
        } else {
            // Fallback for plot/single gen stop if needed
            AppState.stopRequested = true;
            invoke('stop_generation');
        }
    });

    initTabs();
}

function initTabs() {
    document.querySelectorAll('.tabs-container').forEach(container => {
        const targetId = container.getAttribute('data-for');
        const textarea = document.getElementById(targetId);
        const preview = document.getElementById(`${targetId}-preview`);
        const label = container.querySelector('.tab-label')?.innerText?.trim() || targetId;
        const dropTarget = container.querySelector('.tab-content') || textarea || preview;
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
                debouncedRenderMarkdown(targetId);
            }
        });

        setupTxtDropTarget(dropTarget, { targetId, label });
    });
}

function renderMarkdown(id) {
    const textarea = document.getElementById(id);
    const preview = document.getElementById(`${id}-preview`);
    if (textarea && preview && window.marked) {
        let text = textarea.value;

        // [Fix] Bold LaTeX rendering: **$...$** or **$$...$$**
        // In GFM, ** followed by $ and preceded by a Korean character is not recognized as a bold start
        // because $ is punctuation and Korean is not. We manually wrap them in <strong> tags.
        text = text.replace(/\*\*(\$\$?[\s\S]+?\$\$?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/__(\$\$?[\s\S]+?\$\$?)__/g, '<strong>$1</strong>');

        // Escape tilde (~) so it doesn't get parsed as strikethrough in novels
        const processedText = text.replace(/~/g, '\\~');
        preview.innerHTML = window.marked.parse(processedText);
    }
}

let renderTimeout;
function debouncedRenderMarkdown(id) {
    clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => {
        renderMarkdown(id);
    }, 500); 
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
    AppState.stopRequested = false;
    els.btnGenPlot.disabled = true;
    els.btnRefinePlot.disabled = true;
    els.plotStatusMsg.innerText = "⏳ Generating...";
    
    textarea.value = "";
    
    const onEvent = new Channel();
    onEvent.onmessage = (event) => {
        // If stopped, only allow final result or error to update UI
        if (AppState.stopRequested && !event.is_finished && !event.error) return;
        
        textarea.value = event.content;
        debouncedRenderMarkdown(textarea.id); // Live update preview
        
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
            els.plotStatusMsg.innerText = AppState.stopRequested ? "🛑 Stopped" : "✅ Done";
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

async function reloadNovelList() {
    try {
        const novels = await invoke("get_saved_novels");
        els.savedNovels.innerHTML = '<option value="" disabled selected>Select a novel...</option>' + 
            novels.map(n => `<option value="${n}">${n}</option>`).join('');
    } catch (e) {
        console.warn("[Frontend] Failed to reload novel list:", e);
    }
}

async function loadNovel() {
    const filename = els.savedNovels.value;
    if (!filename) {
        showToast("Please select a novel from the list first.", 'warning');
        return;
    }
    
    try {
        els.novelStatus.innerText = "⏳ Loading novel...";
        const [text, metaJson] = await invoke("load_novel", { filename });
        
        els.novelContent.value = text;
        renderMarkdown(els.novelContent.id);
        
        if (metaJson) {
            const meta = JSON.parse(metaJson);
            if (meta.num_chapters) els.numChap.value = meta.num_chapters;
            if (meta.language) {
                Array.from(els.languageRadios).forEach(r => {
                    if (r.value === meta.language) r.checked = true;
                });
            }
            if (meta.plot_seed) els.seedBox.value = meta.plot_seed;
            if (meta.plot_outline) {
                els.plotContent.value = meta.plot_outline;
                renderMarkdown(els.plotContent.id);
            }
            
            showToast(`Loaded novel: ${filename}`, 'success');
        } else {
            showToast(`Loaded novel text: ${filename} (No metadata found)`, 'info');
        }
        
        await detectNextChapter();
        els.novelStatus.innerText = "✅ Loaded: " + filename;
        setTimeout(() => { 
            if (els.novelStatus.innerText.includes("Loaded")) {
                els.novelStatus.innerText = "Idle"; 
            }
        }, 3000);
    } catch (e) {
        showToast("Failed to load novel: " + e, 'error');
        els.novelStatus.innerText = "❌ Load Error";
    }
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
    if (lang === "Korean") pattern = /(?:^|\n)[#\s*]*제?\s*(\d+)\s*[장]/gi;
    else if (lang === "Japanese") pattern = /(?:^|\n)[#\s*]*第?\s*(\d+)\s*[장章]/gi;
    else pattern = /(?:^|\n)[#\s*]*Chapter\s*(\d+)/gi;

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


/**
 * Removes any partial (incomplete) chapter from the end of the text
 * so the backend can generate it cleanly without inserting a duplicate header.
 */
function getCleanedInitialText(novelText, lang, nextCh) {
    let pattern;
    if (lang === "Korean") pattern = /(?:^|\n)[#\s*]*제?\s*(\d+)\s*[장]/gi;
    else if (lang === "Japanese") pattern = /(?:^|\n)[#\s*]*第?\s*(\d+)\s*[장章]/gi;
    else pattern = /(?:^|\n)[#\s*]*Chapter\s*(\d+)/gi;

    const matches = [...novelText.matchAll(pattern)];
    for (let i = matches.length - 1; i >= 0; i--) {
        const chNum = parseInt(matches[i][1]);
        if (chNum === nextCh) {
            // Cut text RIGHT BEFORE this chapter header
            return novelText.slice(0, matches[i].index).trim();
        }
    }
    return novelText;
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
    recentChapters = [],
    storyState = '',
    currentArc = '',
    currentArcKeywords = [],
    currentArcStartChapter = 1,
    closedArcs = [],
    needsMemoryRebuild = false,
    onStatus = () => {},
    stopSignal = () => false,
    plotSeed = "",
}) {
    let hasError = false;
    let errMsg = "";
    try {
        const onEvent = new Channel();
        onEvent.onmessage = (event) => {
            // Signal detected: ignore partial stream updates, but ALWAYS allow final or error results
            if (stopSignal() && !event.is_finished && !event.error) {
                return;
            }
            
            if (stopSignal() && event.is_finished) {
                console.log("[Frontend] Stop signal active, processing final rolled-back content.");
            }

            if (event.error) {
                hasError = true;
                errMsg = event.error;
            }

            onStatus(event.error ? `❌ Error: ${event.error}` : (event.status || (event.is_finished ? "✅ Done" : `Writing...`)));
            
            // Smart scroll: only scroll to bottom if already at the bottom
            const threshold = 50; 
            const isAtBottom = els.novelContent.scrollHeight - els.novelContent.clientHeight <= els.novelContent.scrollTop + threshold;
            
            els.novelContent.value = event.content;
            debouncedRenderMarkdown(els.novelContent.id); // Live update preview
            
            if (isAtBottom) {
                els.novelContent.scrollTop = els.novelContent.scrollHeight;
            }
        };

        const finalText = await invoke("generate_novel", {
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
                novel_filename: novelFilename,
                recent_chapters: recentChapters,
                story_state: storyState,
                current_arc: currentArc,
                current_arc_keywords: currentArcKeywords,
                current_arc_start_chapter: currentArcStartChapter,
                closed_arcs: closedArcs,
                needs_memory_rebuild: needsMemoryRebuild
            },
            onEvent
        });
        if (hasError) {
            throw new Error(errMsg);
        }
        onStatus("Done");
        els.novelContent.value = finalText;
        renderMarkdown(els.novelContent.id);
        return { fullNovelText: finalText, novelFilename };
    } catch (e) {
        onStatus(`❌ Error: ${e}`);
        throw e;
    }
}

// ──────────────────────────────────────────────────────────────
// UNIFIED TASK QUEUE
// ──────────────────────────────────────────────────────────────

async function processQueue() {
    if (AppState.isWorkerRunning) return;
    AppState.isWorkerRunning = true;
    
    try {
        AppState.stopRequested = false;
        AppState.isPaused = false; 
        updateBatchButtons();

        while (AppState.taskQueue.length > 0 && !AppState.stopRequested) {
            els.queueCount.value = AppState.taskQueue.length;
            const job = AppState.taskQueue[0]; // Peek instead of shift
            els.queueCount.value = AppState.taskQueue.length;

            if (job.type === 'batch') {
                await runBatchJob(job);
            } else if (job.type === 'single') {
                await runSingleJob(job);
            }

            // Only remove from queue and reset tracker if not stopped (success)
            if (!AppState.stopRequested) {
                AppState.taskQueue.shift();
                AppState.lastRanJobUid = null; // Reset to ensure next job starts fresh
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
        } else {
            if (!els.novelStatus.innerText.includes("Error")) {
                els.novelStatus.innerText = '⏸️ Paused.';
            }
        }    
        updateBatchButtons();
    }
}

function updateBatchButtons() {
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

async function runSingleJob(job) {
    const { plotOutline, startChapter, totalChapters, targetTokens, lang, plotSeed } = job;
    
    // Clear existing content and start fresh if starting from Ch 1
    if (startChapter === 1) {
        els.novelContent.value = "";
        renderMarkdown(els.novelContent.id);
    }
    let initialText = "";
    let recentChapters = [];
    let storyState = '';
    let currentArc = '';
    let currentArcKeywords = [];
    let currentArcStartChapter = 1;
    let closedArcs = [];
    let needsMemoryRebuild = false;
    let novelFilename = null;

    // ── Resumption: try to load saved metadata ──
    if (startChapter > 1) {
        els.novelStatus.innerText = 'Loading saved state...';
        try {
            const result = await invoke('get_latest_novel_metadata');
            if (result) {
                const [fname, jsonStr] = result;
                const meta = JSON.parse(jsonStr);
                if (meta.current_chapter + 1 === startChapter) {
                    recentChapters = meta.recent_chapters || [];
                    storyState = meta.story_state || '';
                    currentArc = meta.current_arc || '';
                    currentArcKeywords = meta.current_arc_keywords || [];
                    currentArcStartChapter = meta.current_arc_start_chapter || 1;
                    closedArcs = meta.closed_arcs || [];
                    needsMemoryRebuild = meta.needs_memory_rebuild === true;
                    novelFilename = fname;
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

    initialText = getCleanedInitialText(initialText, lang, startChapter);

    try {
        const { fullNovelText } = await generateNovel({
            startChapter, totalChapters, targetTokens, lang,
            plotOutline, initialText, novelFilename,
            recentChapters, storyState, currentArc, currentArcKeywords, currentArcStartChapter, closedArcs, needsMemoryRebuild,
            onStatus: (msg) => { els.novelStatus.innerText = msg; },
            stopSignal: () => AppState.stopRequested,
            plotSeed: plotSeed
        });
        els.novelContent.value = fullNovelText;
    } catch (e) {
        els.novelStatus.innerText = `❌ Error: ${e.message}`;
        AppState.stopRequested = true;
    }

    if (!AppState.stopRequested && !AppState.isPaused) {
        els.resumeCh.value = 1;
    } else {
        await detectNextChapter();
    }
}

async function runBatchJob(job) {
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
        '1. タイトル', '2. 核心となるテーマと小説のスタイル', '3. 登場人物の名前・設定', '4. 세계관 설정',
        '5. 각 장의 제목과 내용, 중요 포인트 (Include clear markers like \'第 1 章\', \'第 2 章\', etc.)'
    ] : [
        '1. Title', '2. Core Theme and Novel Style', '3. Character Names and Settings',
        '4. World Building/Setting',
        '5. Chapter Titles, Content, and Key Points (Include clear markers like \'Chapter 1\', \'Chapter 2\', etc.)'
    ];

    const plotPrompt = `Based on the following seed, create a detailed plot outline for a ${job.totalChapters}-chapter novel in ${lang}.\nSeed: ${job.seed}\n\nFORMAT INSTRUCTIONS:\nPlease organize the output into the following 5 sections in ${lang}:\n${h.join('\n')}\nEnsure every section is detailed. Output ONLY the plot outline based on this format, without any greetings, meta-commentary.`;

    if (!isSameJob || !plotOutline || !plotActuallyComplete) {
        // Clear for new/incomplete job
        if (!isSameJob || !plotActuallyComplete) {
            console.log("[Batch] New or incomplete job detected, clearing UI fields.");
            els.plotContent.value = "";
            els.novelContent.value = "";
            renderMarkdown(els.plotContent.id);
            renderMarkdown(els.novelContent.id);
        }
        
        els.novelStatus.innerText = `[Batch] Generating plot (${AppState.taskQueue.length} remaining)...`;
        let plotError = null;
        const plotChannel = new Channel();
        plotChannel.onmessage = (ev) => {
            if (ev.error) plotError = ev.error;
            plotOutline = ev.content;
            els.plotContent.value = plotOutline;
            debouncedRenderMarkdown(els.plotContent.id);
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
        } catch (e) {
            plotError = e.message || e.toString();
        }

        if (plotError) {
            els.novelStatus.innerText = `[Batch] Plot Error: ${plotError}`;
            AppState.stopRequested = true;
            AppState.isPaused = true;
            return;
        }
    } else {
        els.novelStatus.innerText = `[Batch] Resuming from existing plot (${AppState.taskQueue.length} remaining)...`;
    }

    if (AppState.stopRequested) return;

    // 2. Generate novel from that plot
    let currentText = els.novelContent.value;
    if (!currentText) {
       els.novelContent.value = '';
    }
    let safetyLimit = 0;

    while (true) {
        let lastCompleted = null;
        let recentChapters = [];
        let storyState = '';
        let currentArc = '';
        let currentArcKeywords = [];
        let currentArcStartChapter = 1;
        let closedArcs = [];
        let needsMemoryRebuild = false;
        let novelFilename = null;

        // ── Metadata Loading: Only load latest if resuming the same job ──
        if (isSameJob) {
            try {
                const metaResult = await invoke('get_latest_novel_metadata');
                if (metaResult) {
                    const [fname, jsonStr] = metaResult;
                    const meta = JSON.parse(jsonStr);
                    lastCompleted = meta.current_chapter;
                    recentChapters = meta.recent_chapters || [];
                    storyState = meta.story_state || '';
                    currentArc = meta.current_arc || '';
                    currentArcKeywords = meta.current_arc_keywords || [];
                    currentArcStartChapter = meta.current_arc_start_chapter || 1;
                    closedArcs = meta.closed_arcs || [];
                    needsMemoryRebuild = meta.needs_memory_rebuild === true;
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

        // Ensure we don't pass a trailing incomplete chapter header to the backend
        currentText = getCleanedInitialText(currentText, lang, nextCh);

        try {
            const result = await generateNovel({
                startChapter: nextCh, totalChapters: job.totalChapters,
                targetTokens: job.targetTokens, lang,
                plotOutline, initialText: currentText,
                novelFilename,
                recentChapters, storyState, currentArc, currentArcKeywords, currentArcStartChapter, closedArcs, needsMemoryRebuild,
                onStatus: (msg) => { els.novelStatus.innerText = `[Batch] ${msg}`; },
                stopSignal: () => AppState.stopRequested,
                plotSeed: job.seed
            });
            currentText = result.fullNovelText;
            els.novelContent.value = currentText;
        } catch (e) {
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
        if (nextAfter <= nextCh) break; 
    }
    
    if (!AppState.stopRequested && !AppState.isPaused) {
        els.resumeCh.value = 1;
    } else {
        await detectNextChapter();
    }
}


// ──────────────────────────────────────────────────────────────
// ON LOAD
// ──────────────────────────────────────────────────────────────
async function init() {
    initElements();
    initTheme();
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

    // 3. UI Settings (Individual Font Sizes)
    const fsSeed = localStorage.getItem('fs-seed') || "16";
    const fsPlot = localStorage.getItem('fs-plot') || "16";
    const fsNovel = localStorage.getItem('fs-novel') || "16";
    const comfortSeed = localStorage.getItem('comfort-seed') === 'true';
    const comfortPlot = localStorage.getItem('comfort-plot') === 'true';
    const comfortNovel = localStorage.getItem('comfort-novel') === 'true';
    
    els.seedFsSlider.value = fsSeed;
    els.plotFsSlider.value = fsPlot;
    els.novelFsSlider.value = fsNovel;
    
    setFontSize('seed', fsSeed);
    setFontSize('plot', fsPlot);
    setFontSize('novel', fsNovel);
    setComfortMode('seed', comfortSeed);
    setComfortMode('plot', comfortPlot);
    setComfortMode('novel', comfortNovel);

    reloadPlotList();
    reloadNovelList();

    try {
        console.log("[Frontend] Requesting system prompt load...");
        await loadCustomPromptIntoEditor();
    } catch (e) {
        console.error("[Frontend] System prompt load failed:", e);
        els.promptBox.value = PRESETS[DEFAULT_SYSTEM_PROMPT_PRESET];
    }
}

// Ensure DOM is ready before init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
