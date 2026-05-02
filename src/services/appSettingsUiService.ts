import { els } from '../modules/dom_refs.js';
import { showToast } from '../modules/toast.js';
import { saveUiSettings } from '../modules/ui_preferences.js';
import type { ApiProvider } from '../types/app.js';
import { saveApiKey } from './credentialService.js';
import { fetchModelNames } from './modelService.js';
import {
    DEFAULT_LM_STUDIO_MODEL_OPTIONS,
    runtimeViewStateStore,
} from './runtimeViewStateStore.js';
import {
    DEFAULT_GOOGLE_MODEL,
    DEFAULT_LM_STUDIO_MODEL,
    GOOGLE_MODELS,
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
}

export function createAppSettingsController({ getProvider }: AppSettingsControllerOptions): AppSettingsController {
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

    async function persistGoogleApiKey() {
        try {
            const savedKey = await saveApiKey(getApiSettings().apiKey);
            runtimeViewStateStore.setApiSettings({ apiKey: savedKey });

            if (savedKey) {
                showToast('Google API Key saved to Windows Credential Manager.', 'success');
            } else {
                showToast('Google API Key removed from Windows Credential Manager.', 'info');
            }
        } catch (e) {
            console.error('[Frontend] API Key save failed:', e);
            showToast('Failed to update Windows Credential Manager: ' + e, 'error');
        }
    }

    async function refreshModels() {
        try {
            console.log('[Frontend] Refreshing models...');
            runtimeViewStateStore.setApiSettings({
                apiStatus: '⏳ Syncing...',
                isRefreshingModels: true,
            });

            const { apiBase, modelName: currentModel } = getApiSettings();
            const models = await fetchModelNames(apiBase);

            if (models && models.length > 0) {
                runtimeViewStateStore.setApiSettings({
                    modelOptions: models,
                    modelName: models.includes(currentModel) ? currentModel : models[0],
                });
                console.log('[Frontend] Models updated.');
            }
        } catch (e) {
            console.warn('[Frontend] Model fetch failed', e);
        } finally {
            runtimeViewStateStore.setApiSettings({ isRefreshingModels: false });
            setTimeout(() => {
                runtimeViewStateStore.setApiSettings({ apiStatus: '' });
            }, 3000);
        }
    }

    async function saveSettings() {
        console.log('[Frontend] Saving settings...');
        const { apiBase, modelName, provider } = getApiSettings();
        saveApiSettings({
            provider,
            apiBase,
            modelName,
        });
        saveUiSettings();
        saveBatchSettings(runtimeViewStateStore.getSnapshot().batchSettings);
    }

    async function setProviderUI(skipModelFetch = false, { persistSettings = true } = {}) {
        try {
            const provider = getProvider();
            console.log('[Frontend] Setting Provider UI for:', provider);
            const savedSettings = readSavedAppSettings();

            if (provider === 'Google') {
                runtimeViewStateStore.setApiSettings({
                    apiBase: getProviderBase(provider, savedSettings),
                    showApiKey: true,
                    modelOptions: GOOGLE_MODELS,
                    modelName: getProviderModel(provider, savedSettings) || DEFAULT_GOOGLE_MODEL,
                });
            } else {
                const savedLMModel = getProviderModel(provider, savedSettings);
                const modelName = savedLMModel || DEFAULT_LM_STUDIO_MODEL;
                runtimeViewStateStore.setApiSettings({
                    apiBase: getProviderBase(provider, savedSettings),
                    showApiKey: false,
                    modelOptions: DEFAULT_LM_STUDIO_MODEL_OPTIONS.includes(modelName)
                        ? DEFAULT_LM_STUDIO_MODEL_OPTIONS
                        : [...DEFAULT_LM_STUDIO_MODEL_OPTIONS, modelName],
                    modelName,
                });
            }

            if (!skipModelFetch && provider === 'LM Studio') {
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
    };
}
