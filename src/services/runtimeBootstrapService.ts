import { showToast } from '../modules/toast.js';
import type { ApiProvider } from '../types/app.js';
import type { AppSettingsController } from './appSettingsUiService.js';
import { initializeNovelgenRuntime } from './runtimeInitializationService.js';
import {
    reloadNovelList,
    reloadPlotList,
} from './savedContentService.js';
import {
    getDefaultSystemPrompt,
    loadCustomPromptIntoEditor,
    loadSystemPromptPresets,
} from './systemPromptUiService.js';
import { updatePlotTokenCount } from './textMetricsUiService.js';

interface RuntimeBootstrapOptions {
    appSettings: AppSettingsController;
    getProvider: () => ApiProvider;
    setupEventListeners: () => void;
}

export function createRuntimeBootstrap({
    appSettings,
    getProvider,
    setupEventListeners,
}: RuntimeBootstrapOptions) {
    let didInitialize = false;

    return async function initialize() {
        if (didInitialize) return;
        didInitialize = true;

        try {
            await initializeNovelgenRuntime({
                loadSystemPromptPresets,
                setupEventListeners,
                setProviderUI: appSettings.setProviderUI,
                refreshModels: appSettings.refreshModels,
                restorePlotTokenCount: updatePlotTokenCount,
                updateBatchRefineUI: appSettings.updateBatchRefineUI,
                reloadPlotList,
                reloadNovelList,
                loadCustomPromptIntoEditor,
                getProvider,
                getDefaultSystemPrompt,
            });
        } catch (error) {
            console.error('[Frontend] React runtime initialization failed:', error);
            showToast('Runtime initialization failed: ' + error, 'error');
        }
    };
}
