import type { ApiProvider, ApiSettingsSnapshot, BatchSettingsSnapshot, SavedAppSettings } from '../types/app.js';

export const DEFAULT_LM_STUDIO_BASE = 'http://localhost:1234/v1';
export const DEFAULT_LM_STUDIO_MODEL = 'unsloth/gemma-4-31b-it';
export const DEFAULT_GOOGLE_MODEL = 'gemini-3.1-flash-lite-preview';

export const GOOGLE_MODELS = [
    DEFAULT_GOOGLE_MODEL,
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemma-4-26b-a4b-it',
    'gemma-4-31b-it'
];

const DEFAULT_BATCH_SETTINGS: BatchSettingsSnapshot = {
    autoRefinePlot: false,
    autoRefinePlotInstructions: false,
    autoRefineNovel: false,
    autoRefineNovelInstructions: false,
};

export function asApiProvider(value: string | null | undefined): ApiProvider | null {
    return value === 'LM Studio' || value === 'Google' ? value : null;
}

function readBoolean(key: string): boolean {
    return localStorage.getItem(key) === 'true';
}

export function readBatchSettings(): BatchSettingsSnapshot {
    return {
        autoRefinePlot: readBoolean('batch-auto-refine-plot'),
        autoRefinePlotInstructions: readBoolean('batch-auto-refine-plot-instructions'),
        autoRefineNovel: readBoolean('batch-auto-refine-novel'),
        autoRefineNovelInstructions: readBoolean('batch-auto-refine-novel-instructions'),
    };
}

export function readSavedAppSettings(): SavedAppSettings {
    return {
        provider: asApiProvider(localStorage.getItem('api-provider')),
        apiBase: localStorage.getItem('api-base'),
        model: localStorage.getItem('api-model'),
        lmStudioBase: localStorage.getItem('api-base-lmstudio'),
        lmStudioModel: localStorage.getItem('api-model-lmstudio'),
        googleModel: localStorage.getItem('api-model-google'),
        batch: readBatchSettings(),
    };
}

export function saveApiSettings(settings: ApiSettingsSnapshot) {
    localStorage.setItem('api-provider', settings.provider);
    localStorage.setItem('api-base', settings.apiBase);
    localStorage.setItem('api-model', settings.modelName);

    if (settings.provider === 'LM Studio') {
        localStorage.setItem('api-base-lmstudio', settings.apiBase);
        localStorage.setItem('api-model-lmstudio', settings.modelName);
    } else {
        localStorage.setItem('api-model-google', settings.modelName);
    }
}

export function saveBatchSettings(settings: BatchSettingsSnapshot = DEFAULT_BATCH_SETTINGS) {
    localStorage.setItem('batch-auto-refine-plot', String(settings.autoRefinePlot));
    localStorage.setItem('batch-auto-refine-plot-instructions', String(settings.autoRefinePlotInstructions));
    localStorage.setItem('batch-auto-refine-novel', String(settings.autoRefineNovel));
    localStorage.setItem('batch-auto-refine-novel-instructions', String(settings.autoRefineNovelInstructions));
}

export function getProviderBase(provider: ApiProvider, saved: SavedAppSettings): string {
    return provider === 'Google'
        ? 'https://generativelanguage.googleapis.com/v1beta/openai/'
        : saved.lmStudioBase || DEFAULT_LM_STUDIO_BASE;
}

export function getProviderModel(provider: ApiProvider, saved: SavedAppSettings): string {
    return provider === 'Google'
        ? saved.googleModel || DEFAULT_GOOGLE_MODEL
        : saved.lmStudioModel || '';
}
