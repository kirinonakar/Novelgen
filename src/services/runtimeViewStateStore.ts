import type {
    ApiSettingsViewState,
    BatchSettingsSnapshot,
    GenerationParamsViewState,
    RuntimeActivityViewState,
    RuntimeViewState,
    TypographyScope,
    TypographyViewState,
} from '../types/app.js';
import {
    DEFAULT_LM_STUDIO_BASE,
    DEFAULT_LM_STUDIO_MODEL,
} from './settingsService.js';

export const DEFAULT_LM_STUDIO_MODEL_OPTIONS = [
    DEFAULT_LM_STUDIO_MODEL,
    'unsloth/gemma-4-26b-a4b-it',
    'qwen/qwen3.5-35b-a3b',
    'qwen3.5-27b',
];

const initialApiSettings: ApiSettingsViewState = {
    provider: 'LM Studio',
    apiBase: DEFAULT_LM_STUDIO_BASE,
    apiKey: '',
    showApiKey: false,
    modelName: DEFAULT_LM_STUDIO_MODEL,
    modelOptions: DEFAULT_LM_STUDIO_MODEL_OPTIONS,
    apiStatus: '',
    isRefreshingModels: false,
};

const initialBatchSettings: BatchSettingsSnapshot = {
    autoRefinePlot: false,
    autoRefinePlotInstructions: false,
    autoRefineNovel: false,
    autoRefineNovelInstructions: false,
};

const initialGenerationParams: GenerationParamsViewState = {
    language: 'Korean',
    temperature: '1.0',
    topP: '0.95',
    repetitionPenalty: '1.1',
};

const initialTypography: TypographyViewState = {
    seed: { fontSize: '16', wrapWidth: '42', comfort: false },
    plot: { fontSize: '16', wrapWidth: '42', comfort: false },
    novel: { fontSize: '16', wrapWidth: '42', comfort: false },
};

const initialActivity: RuntimeActivityViewState = {
    isAutoPlotInstructionsRunning: false,
    isAutoNovelInstructionsRunning: false,
};

let state: RuntimeViewState = {
    apiSettings: initialApiSettings,
    activity: initialActivity,
    batchSettings: initialBatchSettings,
    generationParams: initialGenerationParams,
    typography: initialTypography,
};

const listeners = new Set<() => void>();

function emit() {
    listeners.forEach(listener => listener());
}

export const runtimeViewStateStore = {
    getSnapshot() {
        return state;
    },

    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },

    setApiSettings(update: Partial<ApiSettingsViewState>) {
        state = {
            ...state,
            apiSettings: {
                ...state.apiSettings,
                ...update,
            },
        };
        emit();
    },

    setActivity(update: Partial<RuntimeActivityViewState>) {
        state = {
            ...state,
            activity: {
                ...state.activity,
                ...update,
            },
        };
        emit();
    },

    setBatchSettings(update: Partial<BatchSettingsSnapshot>) {
        state = {
            ...state,
            batchSettings: {
                ...state.batchSettings,
                ...update,
            },
        };
        emit();
    },

    setGenerationParams(update: Partial<GenerationParamsViewState>) {
        state = {
            ...state,
            generationParams: {
                ...state.generationParams,
                ...update,
            },
        };
        emit();
    },

    setTypographyScope(scope: TypographyScope, update: Partial<TypographyViewState[TypographyScope]>) {
        state = {
            ...state,
            typography: {
                ...state.typography,
                [scope]: {
                    ...state.typography[scope],
                    ...update,
                },
            },
        };
        emit();
    },
};
