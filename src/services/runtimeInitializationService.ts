import {
    initTheme,
    restoreUiSettings,
} from '../modules/ui_preferences.js';
import { loadApiKey } from './credentialService.js';
import {
    DEFAULT_LM_STUDIO_MODEL,
    DEFAULT_OPENCODE_GO_BASE,
    DEFAULT_ZEN_BASE,
    OPENCODE_GO_MODELS,
    ZEN_MODELS,
    readSavedAppSettings,
} from './settingsService.js';
import { initializeRuntimeServices } from './runtimeService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';

interface InitializeNovelgenRuntimeOptions {
    loadSystemPromptPresets: () => Promise<void>;
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
    runtimeViewStateStore.setUiPreferences({ theme: initTheme() });
    await loadSystemPromptPresets();

    const savedSettings = readSavedAppSettings();
    const savedProvider = savedSettings.provider || 'LM Studio';
    const savedBase = savedSettings.apiBase;
    const savedModel = savedSettings.model;

    if (savedSettings.provider) {
        runtimeViewStateStore.setApiSettings({ provider: savedSettings.provider });
    }

    try {
        console.log('[Frontend] Requesting API key load for provider:', savedProvider);
        let key = '';
        const apiKeyProviders = ['Google', 'Ollama Cloud', 'OpenCode Go', 'Zen'];
        if (apiKeyProviders.includes(savedProvider)) {
            key = await loadApiKey(savedProvider);
        }
        if (key) {
            console.log('[Frontend] API Key loaded from disk.');
            runtimeViewStateStore.setApiSettings({ apiKey: key });
        } else {
            console.log('[Frontend] No API Key found on disk (or empty).');
        }
    } catch (e) {
        console.error('[Frontend] API Key load failed:', e);
    }

    await setProviderUI(true, { persistSettings: false });

    if (savedBase) runtimeViewStateStore.setApiSettings({ apiBase: savedBase });

    const fetchableProviders = ['LM Studio', 'Ollama', 'Ollama Cloud', 'OpenCode Go', 'Zen'];
    if (fetchableProviders.includes(savedProvider)) {
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
    } else if (savedProvider === 'LM Studio') {
        runtimeViewStateStore.setApiSettings({ modelName: DEFAULT_LM_STUDIO_MODEL });
    } else if (savedProvider === 'OpenCode Go') {
        runtimeViewStateStore.setApiSettings({
            modelName: OPENCODE_GO_MODELS[0],
            modelOptions: OPENCODE_GO_MODELS,
            apiBase: savedSettings.opencodeGoBase || DEFAULT_OPENCODE_GO_BASE,
        });
    } else if (savedProvider === 'Zen') {
        runtimeViewStateStore.setApiSettings({
            modelName: ZEN_MODELS[0],
            modelOptions: ZEN_MODELS,
            apiBase: savedSettings.zenBase || DEFAULT_ZEN_BASE,
        });
    } else if (savedProvider === 'Ollama' || savedProvider === 'Ollama Cloud') {
        runtimeViewStateStore.setApiSettings({ modelName: '' });
    }

    runtimeViewStateStore.setBatchSettings(savedSettings.batch);

    const restoredTypography = restoreUiSettings();
    runtimeViewStateStore.setTypographyScope('seed', restoredTypography.seed);
    runtimeViewStateStore.setTypographyScope('plot', restoredTypography.plot);
    runtimeViewStateStore.setTypographyScope('novel', restoredTypography.novel);
    restorePlotTokenCount();
    updateBatchRefineUI();

    void reloadPlotList();
    void reloadNovelList();

    try {
        console.log('[Frontend] Requesting system prompt load...');
        await loadCustomPromptIntoEditor();
    } catch (e) {
        console.error('[Frontend] System prompt load failed:', e);
        runtimeViewStateStore.setPromptEditor({ systemPrompt: getDefaultSystemPrompt() });
    }
}
