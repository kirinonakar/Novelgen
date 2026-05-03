import { showToast } from '../modules/toast.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';
import {
    CUSTOM_SYSTEM_PROMPT_PRESET,
    loadCustomSystemPrompt,
    loadSystemPresetCatalog,
    saveCustomSystemPrompt,
} from './systemPromptService.js';

let PRESETS: Record<string, string> = {};
let DEFAULT_SYSTEM_PROMPT_PRESET = '';

export function getPresetPrompt(name: string): string | undefined {
    return PRESETS[name];
}

export function getDefaultSystemPrompt(): string {
    return PRESETS[DEFAULT_SYSTEM_PROMPT_PRESET] || '';
}

export async function loadSystemPromptPresets() {
    try {
        const catalog = await loadSystemPresetCatalog();
        PRESETS = catalog.presets;
        DEFAULT_SYSTEM_PROMPT_PRESET = catalog.defaultPreset;
    } catch (e) {
        console.error('[Frontend] Failed to load system prompt presets:', e);
        PRESETS = {};
        DEFAULT_SYSTEM_PROMPT_PRESET = '';
        showToast('Failed to load system prompt presets.', 'warning');
    }

    runtimeViewStateStore.setPromptEditor({
        presetOptions: [CUSTOM_SYSTEM_PROMPT_PRESET, ...Object.keys(PRESETS)],
    });
}

export async function loadCustomPromptIntoEditor({ fallbackToDefault = true } = {}) {
    try {
        const customPrompt = await loadCustomSystemPrompt();
        console.log('[Frontend] System prompt loaded:', customPrompt?.substring(0, 50) + '...');

        if (customPrompt && customPrompt.trim().length > 0) {
            runtimeViewStateStore.setPromptEditor({
                selectedPreset: CUSTOM_SYSTEM_PROMPT_PRESET,
                systemPrompt: customPrompt,
            });
            return true;
        }
    } catch (e) {
        console.error('[Frontend] System prompt load failed:', e);
    }

    if (fallbackToDefault) {
        const defaultPrompt = getDefaultSystemPrompt();
        runtimeViewStateStore.setPromptEditor({
            selectedPreset: defaultPrompt
                ? DEFAULT_SYSTEM_PROMPT_PRESET
                : CUSTOM_SYSTEM_PROMPT_PRESET,
            systemPrompt: defaultPrompt,
        });
    }

    return false;
}

export async function saveSystemPrompt() {
    try {
        runtimeViewStateStore.setPromptEditor({ promptStatus: 'Saving...' });
        const msg = await saveCustomSystemPrompt(runtimeViewStateStore.getSnapshot().promptEditor.systemPrompt);
        runtimeViewStateStore.setPromptEditor({ promptStatus: msg });
        setTimeout(() => runtimeViewStateStore.setPromptEditor({ promptStatus: '' }), 3000);
    } catch (e) {
        runtimeViewStateStore.setPromptEditor({ promptStatus: '❌ Error: ' + e });
    }
}
