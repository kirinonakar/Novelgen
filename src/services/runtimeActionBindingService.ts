import { toggleTheme } from '../modules/ui_preferences.js';
import type { ApiProvider, Language, NovelgenRuntimeActions } from '../types/app.js';
import type { AppSettingsController } from './appSettingsUiService.js';
import type { PlotActionController } from './plotActionService.js';
import type { RuntimeWorkflowActions } from './runtimeWorkflowActionsService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';
import { saveSystemPrompt } from './systemPromptUiService.js';

interface RuntimeActionBindingOptions {
    appSettings: AppSettingsController;
    plotActions: PlotActionController;
    workflowActions: RuntimeWorkflowActions;
}

export function createRuntimeActions({
    appSettings,
    plotActions,
    workflowActions,
}: RuntimeActionBindingOptions): Omit<NovelgenRuntimeActions, 'onDroppedTextLoaded'> {
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
        onTotalChaptersChange: (totalChapters: string) => {
            runtimeViewStateStore.setGenerationParams({ totalChapters });
        },
        onTargetTokensChange: (targetTokens: string) => {
            runtimeViewStateStore.setGenerationParams({ targetTokens });
        },
        onThemeToggle: () => {
            runtimeViewStateStore.setUiPreferences({ theme: toggleTheme() });
        },
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
        onSystemPromptChange: (systemPrompt: string) => {
            runtimeViewStateStore.setPromptEditor({ systemPrompt });
        },
        onSavePrompt: () => void saveSystemPrompt(),
        onAutoSeed: () => void plotActions.autoGenerateSeed(),
        onGeneratePlot: plotActions.generatePlotOutline,
        onStopPlot: plotActions.stopPlotGeneration,
        ...workflowActions,
    };
}
