import { setEditorFontFamily, toggleTheme } from '../modules/ui_preferences.js';
import type { ApiProvider, Language, NovelgenRuntimeActions, ThinkingLevel } from '../types/app.js';
import type { AppSettingsController } from './appSettingsUiService.js';
import type { PlotActionController } from './plotActionService.js';
import type { RuntimeWorkflowActions } from './runtimeWorkflowActionsService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';
import { saveGenerationSettings } from './settingsService.js';
import { deleteSystemPrompt, resetSystemPrompts, saveSystemPrompt, selectSystemPromptPreset } from './systemPromptUiService.js';

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
            saveGenerationSettings({ language });
        },
        onTotalChaptersChange: (totalChapters: string) => {
            runtimeViewStateStore.setGenerationParams({ totalChapters });
            saveGenerationSettings({ totalChapters });
        },
        onTargetTokensChange: (targetTokens: string) => {
            runtimeViewStateStore.setGenerationParams({ targetTokens });
            saveGenerationSettings({ targetTokens });
        },
        onThemeToggle: () => {
            runtimeViewStateStore.setUiPreferences({ theme: toggleTheme() });
        },
        onEditorFontFamilyChange: (fontFamily) => {
            runtimeViewStateStore.setUiPreferences({ editorFontFamily: setEditorFontFamily(fontFamily) });
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
        onThinkingLevelChange: (thinkingLevel: ThinkingLevel) => {
            appSettings.updateThinkingLevel(thinkingLevel);
            void appSettings.saveSettings();
        },
        onSystemPromptChange: (systemPrompt: string) => {
            runtimeViewStateStore.setPromptEditor({ systemPrompt });
        },
        onSystemPresetChange: selectSystemPromptPreset,
        onSavePrompt: saveSystemPrompt,
        onDeletePrompt: deleteSystemPrompt,
        onResetPrompts: resetSystemPrompts,
        onAutoSeed: () => void plotActions.autoGenerateSeed(),
        onGeneratePlot: plotActions.generatePlotOutline,
        onStopPlot: plotActions.stopPlotGeneration,
        ...workflowActions,
    };
}
