import { AppState } from './modules/app_state.js';
import { els, initElements } from './modules/dom_refs.js';
import { showConfirm } from './modules/modal.js';
import { loadLatestNovelState, loadNovelState, metadataNextChapter } from './modules/novel_storage.js';
import { debouncedRenderMarkdown, renderMarkdown, schedulePreviewRender } from './modules/preview.js';
import { initSidebarResizer } from './modules/sidebar.js';
import { initTauriApi, invoke, Channel } from './modules/tauri_api.js';
import { showToast } from './modules/toast.js';
import {
    estimateTokenCount,
    eventHasFiles,
    fetchTextAsset,
    formatCompactNumber,
    getCleanedInitialText,
    getDroppedFile,
    getPlotArcInstruction,
    isSupportedTextFile,
    parseSystemPresetIndex,
    readTextFile,
    splitPlotIntoChapters,
} from './modules/text_utils.js';

// Robust error reporting
window.onerror = function(msg, url, lineNo, columnNo, error) {
    const errorMsg = `Error: ${msg}\nLine: ${lineNo}\nColumn: ${columnNo}\nURL: ${url}`;
    console.error(errorMsg);
    showToast("NovelGen Runtime Error", 'error');
    return false;
};

console.log("[Frontend] Script starting...");

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
initTauriApi(showToast);

const CUSTOM_SYSTEM_PROMPT_PRESET = 'Custom (File Default)';
const SYSTEM_PRESET_INDEX_URL = 'prompts/system_presets/index.txt';
let PRESETS = {};
let DEFAULT_SYSTEM_PROMPT_PRESET = '';

const THEME_STORAGE_KEY = 'ui-theme';
const PREVIEW_ELEMENT_MAP = {
    seed: 'plotSeedPreview',
    plot: 'plotContentPreview',
    novel: 'novelContentPreview'
};
const COMFORT_STORAGE_KEY_MAP = {
    seed: 'comfort-seed',
    plot: 'comfort-plot',
    novel: 'comfort-novel'
};

// Helpers
const getLang = () => document.querySelector('input[name="language"]:checked')?.value || "Korean";
const getProvider = () => document.querySelector('input[name="provider"]:checked')?.value || "LM Studio";

function updatePlotTokenCount() {
    if (!els.plotTokenCount || !els.plotContent) return;
    const tokens = estimateTokenCount(els.plotContent.value);
    els.plotTokenCount.innerText = `~${formatCompactNumber(tokens)} tokens`;
    els.plotTokenCount.title = `Estimated plot outline tokens: ${tokens.toLocaleString()}`;
}

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
        if (AppState.loadedNovelFilename) {
            try {
                const state = await loadNovelState(AppState.loadedNovelFilename);
                AppState.setLoadedNovel(state.filename, state.meta);
                if (state.meta?.current_chapter) {
                    lastCompleted = state.meta.current_chapter;
                }
            } catch (e) {
                console.warn("[Frontend] Failed to fetch loaded novel metadata for detection:", e);
            }
        }

        if (!lastCompleted) {
            if (AppState.loadedNovelMetadata?.current_chapter) {
                lastCompleted = AppState.loadedNovelMetadata.current_chapter;
            } else {
                try {
                    const metaResult = await invoke('get_latest_novel_metadata');
                    if (metaResult) {
                        const meta = JSON.parse(metaResult[1]);
                        lastCompleted = meta.current_chapter;
                    }
                } catch (e) {
                    console.warn("[Frontend] Failed to fetch metadata for detection:", e);
                }
            }
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

async function setProviderUI(skipModelFetch = false, { persistSettings = true } = {}) {
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
        if (persistSettings) {
            await saveSettings();
        }
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
    localStorage.setItem('plot-refine-instructions', els.plotRefineInstructions?.value || '');
    localStorage.setItem('batch-auto-refine-plot', String(els.batchAutoRefinePlot?.checked || false));
    localStorage.setItem(COMFORT_STORAGE_KEY_MAP.seed, String(els.seedComfortToggle.checked));
    localStorage.setItem(COMFORT_STORAGE_KEY_MAP.plot, String(els.plotComfortToggle.checked));
    localStorage.setItem(COMFORT_STORAGE_KEY_MAP.novel, String(els.novelComfortToggle.checked));
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

function setComfortMode(type, enabled, { persist = false } = {}) {
    const previewKey = PREVIEW_ELEMENT_MAP[type];
    const previewEl = previewKey ? els[previewKey] : null;
    const toggleEl = els[`${type}ComfortToggle`];
    const isEnabled = Boolean(enabled);

    if (toggleEl) toggleEl.checked = isEnabled;
    if (previewEl) previewEl.classList.toggle('comfort-mode', isEnabled);
    if (persist && COMFORT_STORAGE_KEY_MAP[type]) {
        localStorage.setItem(COMFORT_STORAGE_KEY_MAP[type], String(isEnabled));
    }
}

function populateSystemPresetSelect() {
    if (!els.preset) return;

    els.preset.replaceChildren();

    const customOption = document.createElement('option');
    customOption.value = CUSTOM_SYSTEM_PROMPT_PRESET;
    customOption.innerText = CUSTOM_SYSTEM_PROMPT_PRESET;
    els.preset.appendChild(customOption);

    for (const name of Object.keys(PRESETS)) {
        const option = document.createElement('option');
        option.value = name;
        option.innerText = name;
        els.preset.appendChild(option);
    }
}

async function loadSystemPromptPresets() {
    try {
        const indexText = await fetchTextAsset(SYSTEM_PRESET_INDEX_URL);
        const entries = parseSystemPresetIndex(indexText);
        const loaded = {};
        let defaultPreset = '';

        for (const entry of entries) {
            const prompt = await fetchTextAsset(`prompts/system_presets/${entry.file}`);
            if (!prompt.trim()) continue;

            loaded[entry.name] = prompt.trimEnd();
            if (entry.isDefault) defaultPreset = entry.name;
        }

        PRESETS = loaded;
        DEFAULT_SYSTEM_PROMPT_PRESET = loaded[defaultPreset]
            ? defaultPreset
            : Object.keys(loaded)[0] || '';
    } catch (e) {
        console.error("[Frontend] Failed to load system prompt presets:", e);
        PRESETS = {};
        DEFAULT_SYSTEM_PROMPT_PRESET = '';
        showToast("Failed to load system prompt presets.", 'warning');
    }

    populateSystemPresetSelect();
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
        const defaultPrompt = PRESETS[DEFAULT_SYSTEM_PROMPT_PRESET] || '';
        els.promptBox.value = defaultPrompt;
        if (els.preset) {
            els.preset.value = defaultPrompt
                ? DEFAULT_SYSTEM_PROMPT_PRESET
                : CUSTOM_SYSTEM_PROMPT_PRESET;
        }
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

function setupTextDropTarget(element, { targetId, label }) {
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

        if (!isSupportedTextFile(file)) {
            showToast(`Only .txt or .md files can be dropped into ${label}.`, 'warning');
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

            if (targetId === els.plotContent?.id) {
                updatePlotTokenCount();
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
    setupTextDropTarget(els.promptBox.closest('.input-group') || els.promptBox, {
        targetId: els.promptBox.id,
        label: 'System Prompt Details'
    });
    
    els.preset.addEventListener('change', async (e) => {
        if (e.target.value === CUSTOM_SYSTEM_PROMPT_PRESET) {
            await loadCustomPromptIntoEditor();
            return;
        }

        if (Object.prototype.hasOwnProperty.call(PRESETS, e.target.value)) {
            els.promptBox.value = PRESETS[e.target.value];
        }
    });
    els.temp.addEventListener('input', e => els.tempVal.innerText = parseFloat(e.target.value).toFixed(1));
    els.topP.addEventListener('input', e => els.topPVal.innerText = parseFloat(e.target.value).toFixed(2));

    // Font Size Listeners
    els.seedFsSlider.addEventListener('input', e => { setFontSize('seed', e.target.value); saveSettings(); });
    els.plotFsSlider.addEventListener('input', e => { setFontSize('plot', e.target.value); saveSettings(); });
    els.novelFsSlider.addEventListener('input', e => { setFontSize('novel', e.target.value); saveSettings(); });
    els.seedComfortToggle.addEventListener('change', e => setComfortMode('seed', e.target.checked, { persist: true }));
    els.plotComfortToggle.addEventListener('change', e => setComfortMode('plot', e.target.checked, { persist: true }));
    els.novelComfortToggle.addEventListener('change', e => setComfortMode('novel', e.target.checked, { persist: true }));
    els.plotRefineInstructions?.addEventListener('change', saveSettings);
    els.batchAutoRefinePlot?.addEventListener('change', saveSettings);
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
        const arcInstruction = getPlotArcInstruction(lang);

        const prompt = `Based on the following seed, create a detailed plot outline for a ${els.numChap.value}-chapter novel in ${lang}.\nSeed: ${els.seedBox.value}\n\nFORMAT INSTRUCTIONS:\nPlease organize the output into the following 5 sections in ${lang}:\n${h.join('\n')}\n${arcInstruction}\nEnsure every section is detailed. Output ONLY the plot outline based on this format.`;
        
        streamPlot(prompt, els.plotContent);
    });

    els.btnRefinePlot.addEventListener('click', async () => {
        if (getProvider() === 'Google' && !els.apiKeyBox.value.trim()) {
            showToast("Please enter a Google API Key in the sidebar.", 'warning');
            return;
        }
        if (!els.plotContent.value.trim()) {
            showToast("Plot is empty! Load or generate a plot first.", 'warning');
            return;
        }

        await refinePlotInChunks();
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
            updatePlotTokenCount();
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
            AppState.clearLoadedNovel();
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
                autoRefinePlot: els.batchAutoRefinePlot?.checked === true,
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
                updatePlotTokenCount();
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
                updatePlotTokenCount();
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
            if (targetId === 'plot-content') {
                updatePlotTokenCount();
            }
            if (preview.parentElement.classList.contains('active')) {
                schedulePreviewRender(targetId, { source: 'manual' });
            }
        });

        setupTextDropTarget(dropTarget, { targetId, label });
    });
}

// Stream function
async function streamPlot(prompt, textarea) {
    AppState.stopRequested = false;
    els.btnGenPlot.disabled = true;
    els.btnRefinePlot.disabled = true;
    els.plotStatusMsg.innerText = "⏳ Generating...";
    
    textarea.value = "";
    updatePlotTokenCount();
    
    const onEvent = new Channel();
    onEvent.onmessage = (event) => {
        // If stopped, only allow final result or error to update UI
        if (AppState.stopRequested && !event.is_finished && !event.error) return;
        
        textarea.value = event.content;
        if (textarea.id === 'plot-content') {
            updatePlotTokenCount();
        }
        
        if (event.error) {
            let msg = event.error;
            if (msg.includes("401")) msg += "\n\n💡 [Hint] Unauthorized. Check your API key.";
            else if (msg.includes("403")) msg += "\n\n💡 [Hint] Forbidden. This might be a safety filter block or permission issue.";
            else if (msg.includes("429")) msg += "\n\n💡 [Hint] Quota exceeded. Wait a moment or check your billing.";
            
            textarea.value += `\n\n[Error]: ${msg}`;
            if (textarea.id === 'plot-content') {
                updatePlotTokenCount();
            }
            if (msg.includes("Failed to parse input at pos 0")) {
                textarea.value += `\n\n💡 [Hint] Model mismatch detected. Ensure LM Studio chat template is correctly set for models like Gemma 4.`;
            }
            els.plotStatusMsg.innerText = "❌ Error";
        }

        schedulePreviewRender(textarea.id, {
            source: 'stream',
            force: event.is_finished || Boolean(event.error),
            immediate: event.is_finished || Boolean(event.error)
        });

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

function getPlotRefineHeaders(lang) {
    return lang === 'Korean' ? {
        settings: [
            "1. 제목",
            "2. 핵심 주제의식과 소설 스타일",
            "3. 등장인물 이름, 설정",
            "4. 세계관 설정"
        ],
        chapter: "5. 각 장 제목과 내용, 핵심 포인트"
    } : lang === 'Japanese' ? {
        settings: [
            "1. タイトル",
            "2. 核心となるテーマと小説のスタイル",
            "3. 登場人物の名前・設定",
            "4. 世界観設定"
        ],
        chapter: "5. 各章のタイトルと内容、重要ポイント"
    } : {
        settings: [
            "1. Title",
            "2. Core Theme and Novel Style",
            "3. Character Names and Settings",
            "4. World Building/Setting"
        ],
        chapter: "5. Chapter Titles, Content, and Key Points"
    };
}

function splitPlotForChunkedRefine(plotText, lang) {
    const lines = plotText.replace(/\r\n/g, '\n').split('\n');
    const sectionFiveIndex = lines.findIndex(line => /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*5\s*[.)．。]\s*/i.test(line));

    if (sectionFiveIndex < 0) {
        return {
            settingsText: plotText.trim(),
            chapterHeader: getPlotRefineHeaders(lang).chapter,
            parts: []
        };
    }

    const settingsText = lines.slice(0, sectionFiveIndex).join('\n').trim();
    const chapterHeader = lines[sectionFiveIndex].trim() || getPlotRefineHeaders(lang).chapter;
    const chapterBody = lines.slice(sectionFiveIndex + 1).join('\n').trim();
    const partHeadingRegex = /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\[?\s*(?:(?:제\s*)?(?:\d+|[０-９]+|[일이삼사오육칠팔구십]+|[ivxlcdm]+)\s*부|第\s*[0-9０-９一二三四五六七八九十百]+\s*部|part\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))(?:\s*[\]:：.)、\-–—].*|\s*(?:\*\*)?\s*)$/i;
    const bodyLines = chapterBody.split('\n');
    const partStartIndexes = bodyLines
        .map((line, index) => partHeadingRegex.test(line) ? index : -1)
        .filter(index => index >= 0);

    if (partStartIndexes.length === 0) {
        return {
            settingsText,
            chapterHeader,
            parts: splitChapterBodyIntoFallbackParts(chapterBody, lang)
        };
    }

    const parts = [];
    if (partStartIndexes[0] > 0) {
        const prelude = bodyLines.slice(0, partStartIndexes[0]).join('\n').trim();
        if (prelude) parts.push(prelude);
    }
    for (let i = 0; i < partStartIndexes.length; i++) {
        const start = partStartIndexes[i];
        const end = partStartIndexes[i + 1] ?? bodyLines.length;
        const partText = bodyLines.slice(start, end).join('\n').trim();
        if (partText) parts.push(partText);
    }

    return {
        settingsText,
        chapterHeader,
        parts: parts.length > 1 ? parts : splitChapterBodyIntoFallbackParts(chapterBody, lang)
    };
}

function splitChapterBodyIntoFallbackParts(chapterBody, lang) {
    if (!chapterBody.trim()) return [];

    const chapterRegex = lang === 'Korean'
        ? /(?:^|\n)(?=\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*제?\s*\d+\s*장(?:\s|[:：.)、\-–—]|\*\*|$))/gi
        : lang === 'Japanese'
            ? /(?:^|\n)(?=\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*第?\s*[0-9０-９一二三四五六七八九十百]+\s*章(?:\s|[:：.)、\-–—]|\*\*|$))/gi
            : /(?:^|\n)(?=\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*chapter\s*\d+(?:\s|[:：.)、\-–—]|\*\*|$))/gi;

    const chunks = chapterBody
        .split(chapterRegex)
        .map(chunk => chunk.trim())
        .filter(Boolean);

    if (chunks.length <= 1) {
        return [chapterBody.trim()];
    }

    const chaptersPerPart = 8;
    const fallbackParts = [];
    for (let i = 0; i < chunks.length; i += chaptersPerPart) {
        fallbackParts.push(chunks.slice(i, i + chaptersPerPart).join('\n\n'));
    }
    return fallbackParts;
}

function formatRefineInstructions(refineInstructions) {
    return refineInstructions?.trim()
        ? `[User Refine Instructions]\n${refineInstructions.trim()}\n`
        : `[User Refine Instructions]\nNone.\n`;
}

function buildSettingsRefinePrompt({ lang, totalChapters, plotText, refineInstructions }) {
    const headers = getPlotRefineHeaders(lang);
    return `You are a master story architect. Refine ONLY the setting/setup sections of this ${totalChapters}-chapter novel plot in ${lang}.

[Current Full Plot Outline]
${plotText}

${formatRefineInstructions(refineInstructions)}
OUTPUT RULES:
- Output ONLY sections 1-4.
- Do NOT write section 5 or any chapter/part content yet.
- Preserve the same language: ${lang}.
- Strictly maintain these section headings:
${headers.settings.join('\n')}

REFINEMENT GOALS:
- Polish the title, theme, style, character settings, and worldbuilding.
- Improve emotional stakes, character motivations, story logic, and long-form consistency.
- Keep details compatible with the chapter/part outline that will be refined later.
- No greetings, explanations, or meta-talk.`;
}

function buildPartRefinePrompt({
    lang,
    totalChapters,
    chapterHeader,
    refinedSettings,
    refinedPreviousParts,
    originalRemainingParts,
    partNumber,
    partCount,
    refineInstructions,
}) {
    const previousSection = refinedPreviousParts.length
        ? `\n[Already Refined Earlier Chapter Content]\n${refinedPreviousParts.join('\n\n')}\n`
        : '';
    const arcInstruction = getPlotArcInstruction(lang);

    return `You are a master story architect. Refine ONLY part ${partNumber} of ${partCount} of the chapter-content section for this ${totalChapters}-chapter novel plot in ${lang}.

[Refined Setting Sections]
${refinedSettings}
${previousSection}
[Original Remaining Chapter Content Starting From Part ${partNumber}]
${originalRemainingParts.join('\n\n')}

${formatRefineInstructions(refineInstructions)}
OUTPUT RULES:
- Output ONLY the refined text for part ${partNumber}.
- Do NOT rewrite the setting sections.
- Do NOT rewrite earlier parts.
- Do NOT write future parts.
- Use the remaining original chapter content as boundary/context so part ${partNumber} ends in the right place before part ${partNumber + 1}.
- Preserve clear part markers and chapter markers exactly where appropriate.
- Preserve coverage for all chapters included in this part; do not skip or merge chapters.
- Keep the outline compatible with the refined setting sections and earlier refined parts.
- Follow this section-5 structure rule: ${arcInstruction}
- No greetings, explanations, or meta-talk.

The final assembled plot will place your output under this section heading:
${chapterHeader}`;
}

async function generatePlotChunk(prompt, { statusText, onDelta, onStatus = null }) {
    let latestContent = "";
    let streamError = null;
    const onEvent = new Channel();
    onEvent.onmessage = (event) => {
        if (AppState.stopRequested && !event.is_finished && !event.error) return;
        latestContent = event.content || latestContent;
        onDelta(latestContent, event);

        if (event.error) {
            let msg = event.error;
            if (msg.includes("401")) msg += "\n\n💡 [Hint] Unauthorized. Check your API key.";
            else if (msg.includes("403")) msg += "\n\n💡 [Hint] Forbidden. This might be a safety filter block or permission issue.";
            else if (msg.includes("429")) msg += "\n\n💡 [Hint] Quota exceeded. Wait a moment or check your billing.";
            streamError = msg;
        }
    };

    els.plotStatusMsg.innerText = statusText;
    if (onStatus) onStatus(statusText);
    await invoke("generate_plot", {
        params: {
            api_base: els.apiBase.value,
            model_name: els.modelName.value,
            api_key: els.apiKeyBox.value || "lm-studio",
            system_prompt: els.promptBox.value,
            prompt,
            temperature: parseFloat(els.temp.value),
            top_p: parseFloat(els.topP.value),
            repetition_penalty: parseFloat(els.repetitionPenalty.value),
            max_tokens: 8192
        },
        onEvent
    });
    if (streamError) {
        throw new Error(streamError);
    }

    return latestContent.trim();
}

async function refinePlotInChunks() {
    const originalPlot = els.plotContent.value.trim();
    const lang = getLang();
    const totalChapters = parseInt(els.numChap.value) || 0;
    const refineInstructions = els.plotRefineInstructions?.value?.trim() || '';
    const { parts } = splitPlotForChunkedRefine(originalPlot, lang);

    AppState.stopRequested = false;
    els.btnGenPlot.disabled = true;
    els.btnRefinePlot.disabled = true;
    els.plotStatusMsg.innerText = `⏳ Preparing chunked refine (${parts.length} part${parts.length === 1 ? '' : 's'} detected)...`;
    els.plotContent.value = "";
    updatePlotTokenCount();

    try {
        const refinedPlot = await refinePlotTextInChunks({
            originalPlot,
            lang,
            totalChapters,
            refineInstructions,
            onStatus: (msg) => { els.plotStatusMsg.innerText = msg; },
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
        if (!AppState.stopRequested) {
            els.plotContent.value = refinedPlot;
            updatePlotTokenCount();
            schedulePreviewRender(els.plotContent.id, { source: 'stream', force: true, immediate: true });
            els.plotStatusMsg.innerText = "✅ Done";
        }
    } catch (e) {
        els.plotContent.value += `\n\n[Error]: ${e.message || e}`;
        updatePlotTokenCount();
        schedulePreviewRender(els.plotContent.id, { source: 'stream', force: true, immediate: true });
        els.plotStatusMsg.innerText = "❌ Error";
    } finally {
        els.btnGenPlot.disabled = false;
        els.btnRefinePlot.disabled = false;
    }
}

async function refinePlotTextInChunks({
    originalPlot,
    lang,
    totalChapters,
    refineInstructions,
    onUpdate,
    onStatus,
}) {
    const { chapterHeader, parts } = splitPlotForChunkedRefine(originalPlot, lang);
    const updatePlotOutput = (text, event) => {
        onUpdate?.(text, event);
    };

    onStatus?.(`⏳ Preparing chunked refine (${parts.length} part${parts.length === 1 ? '' : 's'} detected)...`);

    const settingsPrompt = buildSettingsRefinePrompt({ lang, totalChapters, plotText: originalPlot, refineInstructions });
    const refinedSettings = await generatePlotChunk(settingsPrompt, {
        statusText: "⏳ Refining settings...",
        onStatus,
        onDelta: (chunk, event) => updatePlotOutput(chunk, event)
    });
    if (AppState.stopRequested) {
        onStatus?.("🛑 Stopped");
        return refinedSettings;
    }

    if (parts.length === 0) {
        updatePlotOutput(refinedSettings, { is_finished: true });
        return refinedSettings;
    }

    const refinedParts = [];
    let assembled = `${refinedSettings}\n\n${chapterHeader}`;
    updatePlotOutput(assembled, { is_finished: false });

    for (let i = 0; i < parts.length; i++) {
        const partPrompt = buildPartRefinePrompt({
            lang,
            totalChapters,
            chapterHeader,
            refinedSettings,
            refinedPreviousParts: refinedParts,
            originalRemainingParts: parts.slice(i),
            partNumber: i + 1,
            partCount: parts.length,
            refineInstructions,
        });
        const part = await generatePlotChunk(partPrompt, {
            statusText: `⏳ Refining plot part ${i + 1}/${parts.length}...`,
            onStatus,
            onDelta: (chunk, event) => updatePlotOutput(`${assembled}\n\n${chunk}`, event)
        });
        if (AppState.stopRequested) {
            onStatus?.("🛑 Stopped");
            return assembled;
        }

        refinedParts.push(part);
        assembled = `${refinedSettings}\n\n${chapterHeader}\n${refinedParts.join('\n\n')}`;
        updatePlotOutput(assembled, { is_finished: false });
    }

    updatePlotOutput(assembled, { is_finished: true });
    return assembled;
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
            AppState.setLoadedNovel(filename, meta);
            if (meta.num_chapters) els.numChap.value = meta.num_chapters;
            if (meta.target_tokens) els.targetTokens.value = meta.target_tokens;
            if (meta.language) {
                Array.from(els.languageRadios).forEach(r => {
                    if (r.value === meta.language) r.checked = true;
                });
            }
            if (meta.plot_seed) els.seedBox.value = meta.plot_seed;
            if (meta.plot_outline) {
                els.plotContent.value = meta.plot_outline;
                updatePlotTokenCount();
                renderMarkdown(els.plotContent.id);
            }
            await saveSettings();
            
            showToast(`Loaded novel: ${filename}`, 'success');
        } else {
            AppState.setLoadedNovel(filename, null);
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
    characterState = '',
    currentArc = '',
    currentArcKeywords = [],
    currentArcStartChapter = 1,
    closedArcs = [],
    expressionCooldown = [],
    needsMemoryRebuild = false,
    continuityFallbackCount = 0,
    onStatus = () => {},
    stopSignal = () => false,
    plotSeed = "",
}) {
    let hasError = false;
    let errMsg = "";
    let chapterStreamBaseText = null;
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
            
            if (event.is_chapter_preview) {
                if (chapterStreamBaseText === null) {
                    chapterStreamBaseText = els.novelContent.value;
                }
                els.novelContent.value = chapterStreamBaseText + event.content;
            } else {
                chapterStreamBaseText = null;
                els.novelContent.value = event.content;
            }
            schedulePreviewRender(els.novelContent.id, {
                source: 'stream',
                force: event.is_finished || Boolean(event.error),
                immediate: event.is_finished || Boolean(event.error)
            });
            
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
                character_state: characterState,
                current_arc: currentArc,
                current_arc_keywords: currentArcKeywords,
                current_arc_start_chapter: currentArcStartChapter,
                closed_arcs: closedArcs,
                expression_cooldown: expressionCooldown,
                needs_memory_rebuild: needsMemoryRebuild,
                continuity_fallback_count: continuityFallbackCount
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

    // ── Resumption: try to load saved metadata ──
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
        const { fullNovelText } = await generateNovel({
            startChapter, totalChapters, targetTokens, lang,
            plotOutline, initialText, novelFilename,
            recentChapters, storyState, characterState, currentArc, currentArcKeywords, currentArcStartChapter, closedArcs, expressionCooldown, needsMemoryRebuild, continuityFallbackCount,
            onStatus: (msg) => { els.novelStatus.innerText = msg; },
            stopSignal: () => AppState.stopRequested,
            plotSeed: plotSeed
        });
        els.novelContent.value = fullNovelText;
        if (novelFilename) {
            AppState.setLoadedNovel(novelFilename, null);
        }
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
        '1. タイトル', '2. 核心となるテーマと小説のスタイル', '3. 登場人物の名前・設定', '4. 世界観設定',
        '5. 各章のタイトルと内容、重要ポイント (Include clear markers like \'第 1 章\', \'第 2 章\', etc.)'
    ] : [
        '1. Title', '2. Core Theme and Novel Style', '3. Character Names and Settings',
        '4. World Building/Setting',
        '5. Chapter Titles, Content, and Key Points (Include clear markers like \'Chapter 1\', \'Chapter 2\', etc.)'
    ];
    const arcInstruction = getPlotArcInstruction(lang);

    const plotPrompt = `Based on the following seed, create a detailed plot outline for a ${job.totalChapters}-chapter novel in ${lang}.\nSeed: ${job.seed}\n\nFORMAT INSTRUCTIONS:\nPlease organize the output into the following 5 sections in ${lang}:\n${h.join('\n')}\n${arcInstruction}\nEnsure every section is detailed. Output ONLY the plot outline based on this format, without any greetings, meta-commentary.`;

    if (!isSameJob || !plotOutline || !plotActuallyComplete) {
        // Clear for new/incomplete job
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
            } catch (e) {
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
        let characterState = '';
        let currentArc = '';
        let currentArcKeywords = [];
        let currentArcStartChapter = 1;
        let closedArcs = [];
        let expressionCooldown = [];
        let needsMemoryRebuild = false;
        let continuityFallbackCount = 0;
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

        // Ensure we don't pass a trailing incomplete chapter header to the backend
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
    await loadSystemPromptPresets();
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
    await setProviderUI(true, { persistSettings: false });

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
    const comfortSeed = localStorage.getItem(COMFORT_STORAGE_KEY_MAP.seed) === 'true';
    const comfortPlot = localStorage.getItem(COMFORT_STORAGE_KEY_MAP.plot) === 'true';
    const comfortNovel = localStorage.getItem(COMFORT_STORAGE_KEY_MAP.novel) === 'true';
    if (els.plotRefineInstructions) {
        els.plotRefineInstructions.value = localStorage.getItem('plot-refine-instructions') || '';
    }
    if (els.batchAutoRefinePlot) {
        els.batchAutoRefinePlot.checked = localStorage.getItem('batch-auto-refine-plot') === 'true';
    }
    
    els.seedFsSlider.value = fsSeed;
    els.plotFsSlider.value = fsPlot;
    els.novelFsSlider.value = fsNovel;
    
    setFontSize('seed', fsSeed);
    setFontSize('plot', fsPlot);
    setFontSize('novel', fsNovel);
    setComfortMode('seed', comfortSeed);
    setComfortMode('plot', comfortPlot);
    setComfortMode('novel', comfortNovel);
    updatePlotTokenCount();

    reloadPlotList();
    reloadNovelList();

    try {
        console.log("[Frontend] Requesting system prompt load...");
        await loadCustomPromptIntoEditor();
    } catch (e) {
        console.error("[Frontend] System prompt load failed:", e);
        els.promptBox.value = PRESETS[DEFAULT_SYSTEM_PROMPT_PRESET] || '';
    }
}

// Ensure DOM is ready before init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
