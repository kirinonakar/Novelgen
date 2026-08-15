import type { ApiProvider, ApiSettingsSnapshot, BatchSettingsSnapshot, SavedAppSettings, ThinkingLevel } from '../types/app.js';

export const DEFAULT_LM_STUDIO_BASE = 'http://localhost:1234/v1';
export const DEFAULT_LM_STUDIO_MODEL = 'unsloth/gemma-4-31b-it';
export const DEFAULT_UNSLOTH_DESKTOP_BASE = 'http://localhost:8888/v1';
export const DEFAULT_GOOGLE_MODEL = 'gemini-flash-lite-latest';
export const DEFAULT_OLLAMA_BASE = 'http://localhost:11434/v1';
export const DEFAULT_OLLAMA_CLOUD_BASE = 'https://ollama.com/v1';
export const DEFAULT_OPENCODE_GO_BASE = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_ZEN_BASE = 'https://opencode.ai/zen/v1';
export const DEFAULT_CEREBRAS_BASE = 'https://api.cerebras.ai/v1';

export const GOOGLE_MODELS = [
    DEFAULT_GOOGLE_MODEL,
    'gemini-flash-latest',
    'gemini-pro-latest',
    'gemma-4-26b-a4b-it',
    'gemma-4-31b-it'
];

export const OPENCODE_GO_MODELS = [
    'glm-5.2',
    'glm-5.1',
    'kimi-k2.7-code',
    'kimi-k2.6',
    'mimo-v2.5',
    'mimo-v2.5-pro',
    'minimax-m3',
    'minimax-m2.7',
    'qwen3.7-max',
    'qwen3.7-plus',
    'qwen3.6-plus',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
];

export const ZEN_MODELS = [
    'glm-5.2',
    'glm-5.1',
    'kimi-k2.7-code',
    'kimi-k2.6',
    'mimo-v2.5',
    'mimo-v2.5-pro',
    'minimax-m3',
    'minimax-m2.7',
    'qwen3.7-max',
    'qwen3.7-plus',
    'qwen3.6-plus',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
];

export const CEREBRAS_MODELS = [
    'gemma-4-31b',
    'gpt-oss-120b',
    'zai-glm-4.7',
];

export const THINKING_LEVELS: ThinkingLevel[] = ['default', 'disable', 'low', 'medium', 'high', 'xhigh', 'max'];

const DEFAULT_BATCH_SETTINGS: BatchSettingsSnapshot = {
    batchCount: '1',
    autoRefinePlot: false,
    autoRefinePlotInstructions: false,
    autoRefineNovel: false,
    autoRefineNovelInstructions: false,
};
export function asApiProvider(value: string | null | undefined): ApiProvider | null {
    const providers: ApiProvider[] = ['LM Studio', 'Unsloth Desktop', 'Google', 'Ollama', 'Ollama Cloud', 'OpenCode Go', 'Zen', 'Cerebras'];
    return providers.find(p => p === value) || null;
}

export function asThinkingLevel(value: string | null | undefined): ThinkingLevel {
    return THINKING_LEVELS.find(level => level === value) || 'default';
}

function readBoolean(key: string): boolean {
    return localStorage.getItem(key) === 'true';
}

function readBatchCount(): string {
    const value = localStorage.getItem('batch-count') || DEFAULT_BATCH_SETTINGS.batchCount;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 1 ? String(parsed) : DEFAULT_BATCH_SETTINGS.batchCount;
}

export function readBatchSettings(): BatchSettingsSnapshot {
    return {
        batchCount: readBatchCount(),
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
        unslothDesktopBase: localStorage.getItem('api-base-unslothdesktop'),
        unslothDesktopModel: localStorage.getItem('api-model-unslothdesktop'),
        googleModel: localStorage.getItem('api-model-google'),
        ollamaBase: localStorage.getItem('api-base-ollama'),
        ollamaModel: localStorage.getItem('api-model-ollama'),
        ollamaCloudBase: localStorage.getItem('api-base-ollamacloud'),
        ollamaCloudModel: localStorage.getItem('api-model-ollamacloud'),
        opencodeGoBase: localStorage.getItem('api-base-opencodego'),
        opencodeGoModel: localStorage.getItem('api-model-opencodego'),
        zenBase: localStorage.getItem('api-base-zen'),
        zenModel: localStorage.getItem('api-model-zen'),
        cerebrasBase: localStorage.getItem('api-base-cerebras'),
        cerebrasModel: localStorage.getItem('api-model-cerebras'),
        thinkingLevel: asThinkingLevel(localStorage.getItem('api-thinking-level')),
        batch: readBatchSettings(),
    };
}

export function saveApiSettings(settings: ApiSettingsSnapshot) {
    localStorage.setItem('api-provider', settings.provider);
    localStorage.setItem('api-base', settings.apiBase);
    localStorage.setItem('api-model', settings.modelName);
    localStorage.setItem('api-thinking-level', settings.thinkingLevel);

    if (settings.provider === 'LM Studio') {
        localStorage.setItem('api-base-lmstudio', settings.apiBase);
        localStorage.setItem('api-model-lmstudio', settings.modelName);
    } else if (settings.provider === 'Unsloth Desktop') {
        localStorage.setItem('api-base-unslothdesktop', settings.apiBase);
        localStorage.setItem('api-model-unslothdesktop', settings.modelName);
    } else if (settings.provider === 'Google') {
        localStorage.setItem('api-model-google', settings.modelName);
    } else if (settings.provider === 'Ollama') {
        localStorage.setItem('api-base-ollama', settings.apiBase);
        localStorage.setItem('api-model-ollama', settings.modelName);
    } else if (settings.provider === 'Ollama Cloud') {
        localStorage.setItem('api-base-ollamacloud', settings.apiBase);
        localStorage.setItem('api-model-ollamacloud', settings.modelName);
    } else if (settings.provider === 'OpenCode Go') {
        localStorage.setItem('api-base-opencodego', settings.apiBase);
        localStorage.setItem('api-model-opencodego', settings.modelName);
    } else if (settings.provider === 'Zen') {
        localStorage.setItem('api-base-zen', settings.apiBase);
        localStorage.setItem('api-model-zen', settings.modelName);
    } else if (settings.provider === 'Cerebras') {
        localStorage.setItem('api-base-cerebras', settings.apiBase);
        localStorage.setItem('api-model-cerebras', settings.modelName);
    }
}

export function saveBatchSettings(settings: BatchSettingsSnapshot = DEFAULT_BATCH_SETTINGS) {
    localStorage.setItem('batch-count', settings.batchCount || DEFAULT_BATCH_SETTINGS.batchCount);
    localStorage.setItem('batch-auto-refine-plot', String(settings.autoRefinePlot));
    localStorage.setItem('batch-auto-refine-plot-instructions', String(settings.autoRefinePlotInstructions));
    localStorage.setItem('batch-auto-refine-novel', String(settings.autoRefineNovel));
    localStorage.setItem('batch-auto-refine-novel-instructions', String(settings.autoRefineNovelInstructions));
}

export function getProviderBase(provider: ApiProvider, saved: SavedAppSettings): string {
    if (provider === 'Google') {
        return 'https://generativelanguage.googleapis.com/v1beta/openai/';
    }
    if (provider === 'Ollama') {
        return saved.ollamaBase || DEFAULT_OLLAMA_BASE;
    }
    if (provider === 'Unsloth Desktop') {
        return saved.unslothDesktopBase || DEFAULT_UNSLOTH_DESKTOP_BASE;
    }
    if (provider === 'Ollama Cloud') {
        return saved.ollamaCloudBase || DEFAULT_OLLAMA_CLOUD_BASE;
    }
    if (provider === 'OpenCode Go') {
        return saved.opencodeGoBase || DEFAULT_OPENCODE_GO_BASE;
    }
    if (provider === 'Zen') {
        return saved.zenBase || DEFAULT_ZEN_BASE;
    }
    if (provider === 'Cerebras') {
        return saved.cerebrasBase || DEFAULT_CEREBRAS_BASE;
    }
    return saved.lmStudioBase || DEFAULT_LM_STUDIO_BASE;
}

export function getProviderModel(provider: ApiProvider, saved: SavedAppSettings): string {
    if (provider === 'Google') {
        return saved.googleModel || DEFAULT_GOOGLE_MODEL;
    }
    if (provider === 'Ollama') {
        return saved.ollamaModel || '';
    }
    if (provider === 'Unsloth Desktop') {
        return saved.unslothDesktopModel || '';
    }
    if (provider === 'Ollama Cloud') {
        return saved.ollamaCloudModel || '';
    }
    if (provider === 'OpenCode Go') {
        return saved.opencodeGoModel || '';
    }
    if (provider === 'Zen') {
        return saved.zenModel || '';
    }
    if (provider === 'Cerebras') {
        return saved.cerebrasModel || '';
    }
    return saved.lmStudioModel || '';
}
