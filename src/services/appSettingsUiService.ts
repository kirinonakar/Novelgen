import { showToast } from '../modules/toast.js';
import { saveUiSettings } from '../modules/ui_preferences.js';
import type { ApiProvider, ThinkingLevel } from '../types/app.js';
import { loadApiKey, saveApiKey } from './credentialService.js';
import { fetchModelNames } from './modelService.js';
import {
    DEFAULT_LM_STUDIO_MODEL_OPTIONS,
    runtimeViewStateStore,
} from './runtimeViewStateStore.js';
import {
    DEFAULT_GOOGLE_MODEL,
    DEFAULT_LM_STUDIO_MODEL,
    CEREBRAS_MODELS,
    GOOGLE_MODELS,
    OPENCODE_GO_MODELS,
    ZEN_MODELS,
    getProviderBase,
    getProviderModel,
    readSavedAppSettings,
    saveApiSettings,
    saveBatchSettings,
} from './settingsService.js';

interface AppSettingsControllerOptions {
    getProvider: () => ApiProvider;
}

export interface AppSettingsController {
    persistGoogleApiKey: () => Promise<void>;
    refreshModels: () => Promise<void>;
    saveSettings: () => Promise<void>;
    setProviderUI: (skipModelFetch?: boolean, options?: { persistSettings?: boolean }) => Promise<void>;
    updateApiBase: (apiBase: string) => void;
    updateApiKey: (apiKey: string) => void;
    updateBatchRefineUI: () => void;
    updateModelName: (modelName: string) => void;
    updateProvider: (provider: ApiProvider) => void;
    updateThinkingLevel: (thinkingLevel: ThinkingLevel) => void;
}

export function createAppSettingsController({ getProvider }: AppSettingsControllerOptions): AppSettingsController {
    let modelRefreshId = 0;
    function getApiSettings() {
        return runtimeViewStateStore.getSnapshot().apiSettings;
    }

    function updateProvider(provider: ApiProvider) {
        runtimeViewStateStore.setApiSettings({ provider });
    }

    function updateApiBase(apiBase: string) {
        runtimeViewStateStore.setApiSettings({ apiBase });
    }

    function updateApiKey(apiKey: string) {
        runtimeViewStateStore.setApiSettings({ apiKey });
    }

    function updateModelName(modelName: string) {
        runtimeViewStateStore.setApiSettings({ modelName });
    }

    function updateThinkingLevel(thinkingLevel: ThinkingLevel) {
        runtimeViewStateStore.setApiSettings({ thinkingLevel });
    }

    async function persistGoogleApiKey() {
        try {
            const provider = getProvider();
            const apiKeyProviders: ApiProvider[] = ['Google', 'Unsloth Desktop', 'Ollama Cloud', 'OpenCode Go', 'Zen', 'Cerebras', 'OpenRouter'];
            if (!apiKeyProviders.includes(provider)) return;
            const apiKey = getApiSettings().apiKey;
            const savedKey = await saveApiKey(provider, apiKey);
            if (getProvider() !== provider || getApiSettings().apiKey !== apiKey) return;
            runtimeViewStateStore.setApiSettings({ apiKey: savedKey });

            if (savedKey) {
                showToast(`${provider} API Key saved to Windows Credential Manager.`, 'success');
            } else {
                showToast(`${provider} API Key removed from Windows Credential Manager.`, 'info');
            }
        } catch (e) {
            console.error('[Frontend] API Key save failed:', e);
            showToast('Failed to update Windows Credential Manager: ' + e, 'error');
        }
    }

    async function refreshModels() {
        const refreshId = ++modelRefreshId;
        try {
            console.log('[Frontend] Refreshing models...');
            runtimeViewStateStore.setApiSettings({
                apiStatus: '⏳ Syncing...',
                isRefreshingModels: true,
            });

            const { apiBase, apiKey, provider } = getApiSettings();
            const models = await fetchModelNames(apiBase, apiKey, provider);
            const current = getApiSettings();
            if (refreshId !== modelRefreshId || current.provider !== provider || current.apiBase !== apiBase) return;

            if (models && models.length > 0) {
                const currentModel = current.modelName;
                const modelOptions = provider === 'OpenRouter' && currentModel && !models.includes(currentModel)
                    ? [...models, currentModel]
                    : models;
                runtimeViewStateStore.setApiSettings({
                    modelOptions,
                    modelName: modelOptions.includes(currentModel) ? currentModel : modelOptions[0],
                });
                console.log('[Frontend] Models updated.');
            }
        } catch (e) {
            console.warn('[Frontend] Model fetch failed', e);
        } finally {
            if (refreshId === modelRefreshId) {
                runtimeViewStateStore.setApiSettings({ isRefreshingModels: false });
                setTimeout(() => {
                    if (refreshId === modelRefreshId) runtimeViewStateStore.setApiSettings({ apiStatus: '' });
                }, 3000);
            }
        }
    }

    async function saveSettings() {
        console.log('[Frontend] Saving settings...');
        const { apiBase, modelName, provider, thinkingLevel } = getApiSettings();
        saveApiSettings({
            provider,
            apiBase,
            modelName,
            thinkingLevel,
        });
        saveUiSettings(runtimeViewStateStore.getSnapshot().typography);
        saveBatchSettings(runtimeViewStateStore.getSnapshot().batchSettings);
    }

    async function setProviderUI(skipModelFetch = false, { persistSettings = true } = {}) {
        try {
            const provider = getProvider();
            console.log('[Frontend] Setting Provider UI for:', provider);
            const savedSettings = readSavedAppSettings();

            let loadedKey = '';
            const apiKeyProviders: ApiProvider[] = ['Google', 'Unsloth Desktop', 'Ollama Cloud', 'OpenCode Go', 'Zen', 'Cerebras', 'OpenRouter'];
            if (apiKeyProviders.includes(provider)) {
                try {
                    loadedKey = await loadApiKey(provider);
                } catch (error) {
                    console.warn(`[Frontend] Failed to load ${provider} API key:`, error);
                }
            }

            if (getProvider() !== provider) return;

            if (provider === 'Google') {
                runtimeViewStateStore.setApiSettings({
                    provider,
                    apiBase: getProviderBase(provider, savedSettings),
                    apiKey: loadedKey,
                    showApiKey: true,
                    modelOptions: GOOGLE_MODELS,
                    modelName: getProviderModel(provider, savedSettings) || DEFAULT_GOOGLE_MODEL,
                });
            } else if (provider === 'Unsloth Desktop') {
                const savedUnslothDesktopModel = getProviderModel(provider, savedSettings);
                const modelName = savedUnslothDesktopModel || '';
                runtimeViewStateStore.setApiSettings({
                    provider,
                    apiBase: getProviderBase(provider, savedSettings),
                    apiKey: loadedKey,
                    showApiKey: true,
                    modelOptions: modelName ? [modelName] : [],
                    modelName,
                });
            } else if (provider === 'Ollama Cloud') {
                const savedOllamaCloudModel = getProviderModel(provider, savedSettings);
                const modelName = savedOllamaCloudModel || '';
                runtimeViewStateStore.setApiSettings({
                    provider,
                    apiBase: getProviderBase(provider, savedSettings),
                    apiKey: loadedKey,
                    showApiKey: true,
                    modelOptions: modelName ? [modelName] : [],
                    modelName,
                });
            } else if (provider === 'OpenCode Go') {
                const savedOpenCodeGoModel = getProviderModel(provider, savedSettings);
                const modelName = savedOpenCodeGoModel || OPENCODE_GO_MODELS[0];
                runtimeViewStateStore.setApiSettings({
                    provider,
                    apiBase: getProviderBase(provider, savedSettings),
                    apiKey: loadedKey,
                    showApiKey: true,
                    modelOptions: OPENCODE_GO_MODELS.includes(modelName)
                        ? OPENCODE_GO_MODELS
                        : [...OPENCODE_GO_MODELS, modelName],
                    modelName,
                });
            } else if (provider === 'Zen') {
                const savedZenModel = getProviderModel(provider, savedSettings);
                const modelName = savedZenModel || ZEN_MODELS[0];
                runtimeViewStateStore.setApiSettings({
                    provider,
                    apiBase: getProviderBase(provider, savedSettings),
                    apiKey: loadedKey,
                    showApiKey: true,
                    modelOptions: ZEN_MODELS.includes(modelName)
                        ? ZEN_MODELS
                        : [...ZEN_MODELS, modelName],
                    modelName,
                });
            } else if (provider === 'Cerebras') {
                const savedCerebrasModel = getProviderModel(provider, savedSettings);
                const modelName = savedCerebrasModel || CEREBRAS_MODELS[0];
                runtimeViewStateStore.setApiSettings({
                    provider,
                    apiBase: getProviderBase(provider, savedSettings),
                    apiKey: loadedKey,
                    showApiKey: true,
                    modelOptions: CEREBRAS_MODELS.includes(modelName)
                        ? CEREBRAS_MODELS
                        : [...CEREBRAS_MODELS, modelName],
                    modelName,
                });
            } else if (provider === 'OpenRouter') {
                const modelName = getProviderModel(provider, savedSettings);
                runtimeViewStateStore.setApiSettings({
                    provider,
                    apiBase: getProviderBase(provider, savedSettings),
                    apiKey: loadedKey,
                    showApiKey: true,
                    modelOptions: [modelName],
                    modelName,
                });
            } else if (provider === 'Ollama') {
                const savedOllamaModel = getProviderModel(provider, savedSettings);
                const modelName = savedOllamaModel || '';
                runtimeViewStateStore.setApiSettings({
                    provider,
                    apiBase: getProviderBase(provider, savedSettings),
                    apiKey: '',
                    showApiKey: false,
                    modelOptions: modelName ? [modelName] : [],
                    modelName,
                });
            } else {
                const savedLMModel = getProviderModel(provider, savedSettings);
                const modelName = savedLMModel || DEFAULT_LM_STUDIO_MODEL;
                runtimeViewStateStore.setApiSettings({
                    provider,
                    apiBase: getProviderBase(provider, savedSettings),
                    apiKey: '',
                    showApiKey: false,
                    modelOptions: DEFAULT_LM_STUDIO_MODEL_OPTIONS.includes(modelName)
                        ? DEFAULT_LM_STUDIO_MODEL_OPTIONS
                        : [...DEFAULT_LM_STUDIO_MODEL_OPTIONS, modelName],
                    modelName,
                });
            }

            const fetchableProviders: ApiProvider[] = ['LM Studio', 'Unsloth Desktop', 'Ollama', 'Ollama Cloud', 'OpenCode Go', 'Zen', 'Cerebras', 'OpenRouter'];
            if (!skipModelFetch && fetchableProviders.includes(provider)) {
                await refreshModels();
            }
            if (persistSettings) {
                await saveSettings();
            }
        } catch (e) {
            console.error('[Frontend] Error in setProviderUI:', e);
        }
    }

    function updateBatchRefineUI() {
        runtimeViewStateStore.setBatchSettings(runtimeViewStateStore.getSnapshot().batchSettings);
    }

    return {
        persistGoogleApiKey,
        refreshModels,
        saveSettings,
        setProviderUI,
        updateApiBase,
        updateApiKey,
        updateBatchRefineUI,
        updateModelName,
        updateProvider,
        updateThinkingLevel,
    };
}
