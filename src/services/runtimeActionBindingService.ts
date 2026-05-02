import { toggleTheme } from '../modules/ui_preferences.js';
import type { ApiProvider, Language, NovelgenRuntimeActions } from '../types/app.js';
import type { AppSettingsController } from './appSettingsUiService.js';
import type { LegacyRuntimeActions } from './legacyEventService.js';
import type { PlotActionController } from './plotActionService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';
import { saveSystemPrompt } from './systemPromptUiService.js';

interface RuntimeActionBindingOptions {
    appSettings: AppSettingsController;
    legacyActions: LegacyRuntimeActions;
    plotActions: PlotActionController;
}

export function createRuntimeActions({
    appSettings,
    legacyActions,
    plotActions,
}: RuntimeActionBindingOptions): NovelgenRuntimeActions {
    async function persistApiKeyAndSaveSettings() {
        await appSettings.persistGoogleApiKey();
        await appSettings.saveSettings();
    }

    function refreshModelsAndSaveSettings() {
        void appSettings.refreshModels();
        void appSettings.saveSettings();
    }

    return {
        onProviderChange: (provider: ApiProvider) => {
            appSettings.updateProvider(provider);
            void appSettings.setProviderUI();
        },
        onLanguageChange: (language: Language) => {
            runtimeViewStateStore.setGenerationParams({ language });
            void appSettings.saveSettings();
        },
        onThemeToggle: toggleTheme,
        onRefreshModels: () => void appSettings.refreshModels(),
        onApiBaseChange: (apiBase: string) => {
            appSettings.updateApiBase(apiBase);
            refreshModelsAndSaveSettings();
        },
        onApiKeyChange: (apiKey: string) => {
            appSettings.updateApiKey(apiKey);
            void persistApiKeyAndSaveSettings();
        },
        onModelChange: (modelName: string) => {
            appSettings.updateModelName(modelName);
            void appSettings.saveSettings();
        },
        onSavePrompt: () => void saveSystemPrompt(),
        onAutoSeed: () => void plotActions.autoGenerateSeed(),
        onGeneratePlot: plotActions.generatePlotOutline,
        onStopPlot: plotActions.stopPlotGeneration,
        ...legacyActions,
    };
}
