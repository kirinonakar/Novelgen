import { AppState } from './modules/app_state.js';
import {
    requestNovelStop,
    startOrResumeBatchQueue,
    startSingleNovelJob,
    stopOrClearBatchQueue,
    updateBatchButtons,
} from './modules/batch_queue.js';
import { els, initElements } from './modules/dom_refs.js';
import { showConfirm } from './modules/modal.js';
import { generateNovel } from './modules/novel_generation.js';
import { refineNovelByChapters } from './modules/novel_refine.js';
import { loadNovelState } from './modules/novel_storage.js';
import { refinePlotInChunks } from './modules/plot_refine.js';
import { debouncedRenderMarkdown, renderMarkdown, schedulePreviewRender } from './modules/preview.js';
import { initSidebarResizer } from './modules/sidebar.js';
import { initTauriApi, invoke, Channel } from './modules/tauri_api.js';
import { showToast } from './modules/toast.js';
import {
    estimateTokenCount,
    eventHasFiles,
    fetchTextAsset,
    formatCompactNumber,
    getDroppedFile,
    getPlotArcInstruction,
    isSupportedTextFile,
    parseSystemPresetIndex,
    readTextFile,
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
    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const renderer = new window.marked.Renderer();
    renderer.html = ({ text }) => escapeHtml(text);

    const markedOptions = {
        breaks: true,
        gfm: true,
        renderer
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

function replaceSelectOptions(select, items, placeholderText = null) {
    if (!select) return;

    const fragment = document.createDocumentFragment();
    if (placeholderText) {
        const option = document.createElement('option');
        option.value = '';
        option.disabled = true;
        option.selected = true;
        option.textContent = placeholderText;
        fragment.appendChild(option);
    }

    for (const item of items) {
        const option = document.createElement('option');
        option.value = item;
        option.textContent = item;
        fragment.appendChild(option);
    }

    select.replaceChildren(fragment);
}

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
            replaceSelectOptions(els.modelName, GOOGLE_MODELS);
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
            replaceSelectOptions(els.modelName, models);
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
    localStorage.setItem('novel-refine-instructions', els.novelRefineInstructions?.value || '');
    localStorage.setItem('batch-auto-refine-plot', String(els.batchAutoRefinePlot?.checked || false));
    localStorage.setItem('batch-auto-refine-novel', String(els.batchAutoRefineNovel?.checked || false));
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
    els.novelRefineInstructions?.addEventListener('change', saveSettings);
    els.batchAutoRefinePlot?.addEventListener('change', saveSettings);
    els.batchAutoRefineNovel?.addEventListener('change', saveSettings);
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
        const totalChapters = parseInt(els.numChap.value, 10) || 1;
        const arcInstruction = getPlotArcInstruction(lang, totalChapters);

        const prompt = `Based on the following seed, create a detailed plot outline for a ${totalChapters}-chapter novel in ${lang}.\nSeed: ${els.seedBox.value}\n\nFORMAT INSTRUCTIONS:\nPlease organize the output into the following 5 sections in ${lang}:\n${h.join('\n')}\n${arcInstruction}\nEnsure every section is detailed. Output ONLY the plot outline based on this format.`;
        
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

        await refinePlotInChunks({ getLang, updatePlotTokenCount });
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

    els.btnStopNovel.addEventListener('click', requestNovelStop);

    els.btnGenNovel.addEventListener('click', () => {
        startSingleNovelJob({ getLang, generateNovel, detectNextChapter, updatePlotTokenCount });
    });

    els.btnRefineNovel.addEventListener('click', async () => {
        if (getProvider() === 'Google' && !els.apiKeyBox.value.trim()) {
            showToast("Please enter a Google API Key in the sidebar.", 'warning');
            return;
        }

        await refineNovelByChapters({ getLang, detectNextChapter, reloadNovelList });
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

    els.batchStartBtn.addEventListener('click', () => {
        startOrResumeBatchQueue({ getLang, generateNovel, detectNextChapter, updatePlotTokenCount });
    });

    els.batchStopBtn.addEventListener('click', () => {
        stopOrClearBatchQueue({ updatePlotTokenCount });
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

// Plot Save/Load
async function reloadPlotList() {
    try {
        const plots = await invoke("get_saved_plots");
        replaceSelectOptions(els.savedPlots, plots, 'Select a saved plot...');
    } catch (e) {}
}

async function reloadNovelList() {
    try {
        const novels = await invoke("get_saved_novels");
        replaceSelectOptions(els.savedNovels, novels, 'Select a novel...');
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
    if (els.novelRefineInstructions) {
        els.novelRefineInstructions.value = localStorage.getItem('novel-refine-instructions') || '';
    }
    if (els.batchAutoRefinePlot) {
        els.batchAutoRefinePlot.checked = localStorage.getItem('batch-auto-refine-plot') === 'true';
    }
    if (els.batchAutoRefineNovel) {
        els.batchAutoRefineNovel.checked = localStorage.getItem('batch-auto-refine-novel') === 'true';
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
