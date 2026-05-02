import { els, initElements } from '../modules/dom_refs.js';
import { initSidebarResizer } from '../modules/sidebar.js';
import {
    initTheme,
    restoreUiSettings,
} from '../modules/ui_preferences.js';
import { loadApiKey } from './credentialService.js';
import {
    DEFAULT_LM_STUDIO_MODEL,
    readSavedAppSettings,
} from './settingsService.js';
import { initializeRuntimeServices } from './runtimeService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';

interface InitializeNovelgenRuntimeOptions {
    loadSystemPromptPresets: () => Promise<void>;
    setupEventListeners: () => void;
    setProviderUI: (skipModelFetch?: boolean, options?: { persistSettings?: boolean }) => Promise<void>;
    refreshModels: () => Promise<void>;
    restorePlotTokenCount: () => void;
    updateBatchRefineUI: () => void;
    reloadPlotList: () => Promise<void>;
    reloadNovelList: () => Promise<void>;
    loadCustomPromptIntoEditor: () => Promise<boolean>;
    getProvider: () => string;
    getDefaultSystemPrompt: () => string;
}

export async function initializeNovelgenRuntime({
    loadSystemPromptPresets,
    setupEventListeners,
    setProviderUI,
    refreshModels,
    restorePlotTokenCount,
    updateBatchRefineUI,
    reloadPlotList,
    reloadNovelList,
    loadCustomPromptIntoEditor,
    getProvider,
    getDefaultSystemPrompt,
}: InitializeNovelgenRuntimeOptions) {
    initializeRuntimeServices();
    initElements();
    initTheme();
    await loadSystemPromptPresets();
    setupEventListeners();
    initSidebarResizer();

    try {
        console.log('[Frontend] Requesting API key load...');
        const key = await loadApiKey();
        if (key) {
            console.log('[Frontend] API Key loaded from disk.');
            runtimeViewStateStore.setApiSettings({ apiKey: key });
        } else {
            console.log('[Frontend] No API Key found on disk (or empty).');
        }
    } catch (e) {
        console.error('[Frontend] API Key load failed:', e);
    }

    const savedSettings = readSavedAppSettings();
    const savedProvider = savedSettings.provider;
    const savedBase = savedSettings.apiBase;
    const savedModel = savedSettings.model;

    if (savedProvider) {
        runtimeViewStateStore.setApiSettings({ provider: savedProvider });
    }

    await setProviderUI(true, { persistSettings: false });

    if (savedBase) runtimeViewStateStore.setApiSettings({ apiBase: savedBase });

    if (getProvider() === 'LM Studio') {
        await refreshModels();
    }

    if (savedModel) {
        const { modelOptions } = runtimeViewStateStore.getSnapshot().apiSettings;
        runtimeViewStateStore.setApiSettings({
            modelName: savedModel,
            modelOptions: modelOptions.includes(savedModel)
                ? modelOptions
                : [...modelOptions, savedModel],
        });
    } else if (getProvider() === 'LM Studio') {
        runtimeViewStateStore.setApiSettings({ modelName: DEFAULT_LM_STUDIO_MODEL });
    }

    runtimeViewStateStore.setBatchSettings(savedSettings.batch);

    restoreUiSettings();
    runtimeViewStateStore.setTypographyScope('seed', {
        fontSize: els.seedFsSlider?.value || '16',
        wrapWidth: els.seedWrapSlider?.value || '42',
        comfort: localStorage.getItem('comfort-seed') === 'true',
    });
    runtimeViewStateStore.setTypographyScope('plot', {
        fontSize: els.plotFsSlider?.value || '16',
        wrapWidth: els.plotWrapSlider?.value || '42',
        comfort: localStorage.getItem('comfort-plot') === 'true',
    });
    runtimeViewStateStore.setTypographyScope('novel', {
        fontSize: els.novelFsSlider?.value || '16',
        wrapWidth: els.novelWrapSlider?.value || '42',
        comfort: localStorage.getItem('comfort-novel') === 'true',
    });
    restorePlotTokenCount();
    updateBatchRefineUI();

    void reloadPlotList();
    void reloadNovelList();

    try {
        console.log('[Frontend] Requesting system prompt load...');
        await loadCustomPromptIntoEditor();
    } catch (e) {
        console.error('[Frontend] System prompt load failed:', e);
        els.promptBox.value = getDefaultSystemPrompt();
    }
}
