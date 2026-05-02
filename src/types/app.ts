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

export interface PromptEditorViewState {
    presetOptions: string[];
    selectedPreset: string;
    systemPrompt: string;
    promptStatus: string;
}

export interface SavedContentViewState {
    plotFiles: string[];
    selectedPlot: string;
    novelFiles: string[];
    selectedNovel: string;
}

export interface RefineInstructionsViewState {
    plot: string;
    novel: string;
}

export interface RuntimeStatusViewState {
    state: GenerationStatus;
    message: string;
}

export interface ConfirmDialogViewState {
    isOpen: boolean;
    title: string;
    message: string;
}

export interface EditorViewState {
    seed: string;
    plot: string;
    novel: string;
    plotStatus: RuntimeStatusViewState;
    novelStatus: RuntimeStatusViewState;
    nextChapter: string;
    novelRefineStartChapter: string;
    novelRefineEndChapter: string;
}

export interface RuntimeViewState {
    apiSettings: ApiSettingsViewState;
    activity: RuntimeActivityViewState;
    batchSettings: BatchSettingsSnapshot;
    confirmDialog: ConfirmDialogViewState;
    editor: EditorViewState;
    generationParams: GenerationParamsViewState;
    promptEditor: PromptEditorViewState;
    refineInstructions: RefineInstructionsViewState;
    savedContent: SavedContentViewState;
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
    onSystemPromptChange: (systemPrompt: string) => void;
    onSavePrompt: () => void;
    onTemperatureChange: (temperature: string) => void;
    onTopPChange: (topP: string) => void;
    onRepetitionPenaltyChange: (repetitionPenalty: string) => void;
    onFontSizeChange: (scope: TypographyScope, fontSize: string) => void;
    onWrapWidthChange: (scope: TypographyScope, wrapWidth: string) => void;
    onComfortModeChange: (scope: TypographyScope, comfort: boolean) => void;
    onPlotRefineInstructionsChange: (instructions: string) => void;
    onNovelRefineInstructionsChange: (instructions: string) => void;
    onBatchAutoRefinePlotChange: (enabled: boolean) => void;
    onBatchAutoRefinePlotInstructionsChange: (enabled: boolean) => void;
    onBatchAutoRefineNovelChange: (enabled: boolean) => void;
    onBatchAutoRefineNovelInstructionsChange: (enabled: boolean) => void;
    onOpenOutputFolder: () => void;
    onSeedChange: (seed: string) => void;
    onPlotContentChange: (content: string) => void;
    onNovelContentChange: (content: string) => void;
    onNextChapterChange: (chapter: string) => void;
    onNovelRefineStartChapterChange: (chapter: string) => void;
    onNovelRefineEndChapterChange: (chapter: string) => void;
    onConfirmDialogConfirm: () => void;
    onConfirmDialogCancel: () => void;
    onAutoSeed: () => void;
    onGeneratePlot: () => void;
    onStopPlot: () => void;
    onRefinePlot: () => void;
    onAutoPlotInstructions: () => void;
    onSavedPlotChange: (filename: string) => void;
    onRefreshPlots: () => void;
    onSavePlot: () => void;
    onLoadPlot: () => void;
    onSavedNovelChange: (filename: string) => void;
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
