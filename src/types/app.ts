export type ApiProvider = 'LM Studio' | 'Google';
export type Language = 'Korean' | 'Japanese' | 'English';

export type GenerationStatus =
    | 'idle'
    | 'generating'
    | 'refining'
    | 'saving'
    | 'loading'
    | 'stopping'
    | 'completed'
    | 'cancelled'
    | 'error';

export interface ApiSettingsSnapshot {
    provider: ApiProvider;
    apiBase: string;
    modelName: string;
}

export interface BatchSettingsSnapshot {
    autoRefinePlot: boolean;
    autoRefinePlotInstructions: boolean;
    autoRefineNovel: boolean;
    autoRefineNovelInstructions: boolean;
}

export interface SavedAppSettings {
    provider: ApiProvider | null;
    apiBase: string | null;
    model: string | null;
    lmStudioBase: string | null;
    lmStudioModel: string | null;
    googleModel: string | null;
    batch: BatchSettingsSnapshot;
}

export interface SystemPresetCatalog {
    presets: Record<string, string>;
    defaultPreset: string;
}

export interface PlotPromptInput {
    seed: string;
    language: Language;
    totalChapters: number;
}

export interface ApiSettingsViewState {
    provider: ApiProvider;
    apiBase: string;
    apiKey: string;
    showApiKey: boolean;
    modelName: string;
    modelOptions: string[];
    apiStatus: string;
    isRefreshingModels: boolean;
}

export interface GenerationParamsViewState {
    language: Language;
    temperature: string;
    topP: string;
    repetitionPenalty: string;
}

export type TypographyScope = 'seed' | 'plot' | 'novel';

export interface TypographyScopeViewState {
    fontSize: string;
    wrapWidth: string;
    comfort: boolean;
}

export type TypographyViewState = Record<TypographyScope, TypographyScopeViewState>;

export interface RuntimeActivityViewState {
    isAutoPlotInstructionsRunning: boolean;
    isAutoNovelInstructionsRunning: boolean;
}

export interface RuntimeViewState {
    apiSettings: ApiSettingsViewState;
    activity: RuntimeActivityViewState;
    batchSettings: BatchSettingsSnapshot;
    generationParams: GenerationParamsViewState;
    typography: TypographyViewState;
}

export interface NovelgenRuntimeActions {
    onProviderChange: (provider: ApiProvider) => void;
    onLanguageChange: (language: Language) => void;
    onThemeToggle: () => void;
    onRefreshModels: () => void;
    onApiBaseChange: (apiBase: string) => void;
    onApiKeyChange: (apiKey: string) => void;
    onModelChange: (modelName: string) => void;
    onSystemPresetChange: (presetName: string) => void;
    onSavePrompt: () => void;
    onTemperatureChange: (temperature: string) => void;
    onTopPChange: (topP: string) => void;
    onRepetitionPenaltyChange: (repetitionPenalty: string) => void;
    onFontSizeChange: (scope: TypographyScope, fontSize: string) => void;
    onWrapWidthChange: (scope: TypographyScope, wrapWidth: string) => void;
    onComfortModeChange: (scope: TypographyScope, comfort: boolean) => void;
    onPlotRefineInstructionsChange: () => void;
    onNovelRefineInstructionsChange: () => void;
    onBatchAutoRefinePlotChange: (enabled: boolean) => void;
    onBatchAutoRefinePlotInstructionsChange: (enabled: boolean) => void;
    onBatchAutoRefineNovelChange: (enabled: boolean) => void;
    onBatchAutoRefineNovelInstructionsChange: (enabled: boolean) => void;
    onOpenOutputFolder: () => void;
    onAutoSeed: () => void;
    onGeneratePlot: () => void;
    onStopPlot: () => void;
    onRefinePlot: () => void;
    onAutoPlotInstructions: () => void;
    onRefreshPlots: () => void;
    onSavePlot: () => void;
    onLoadPlot: () => void;
    onRefreshNovels: () => void;
    onLoadNovel: () => void;
    onSaveNovel: () => void;
    onFindNextChapter: () => void;
    onGenerateNovel: () => void;
    onRefineNovel: () => void;
    onStopNovel: () => void;
    onClearNovel: () => void;
    onAutoNovelInstructions: () => void;
    onBatchStart: () => void;
    onBatchStop: () => void;
}
