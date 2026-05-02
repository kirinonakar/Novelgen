import { els } from '../modules/dom_refs.js';
import { showToast } from '../modules/toast.js';
import {
    CUSTOM_SYSTEM_PROMPT_PRESET,
    loadCustomSystemPrompt,
    loadSystemPresetCatalog,
    saveCustomSystemPrompt,
} from './systemPromptService.js';

let PRESETS: Record<string, string> = {};
let DEFAULT_SYSTEM_PROMPT_PRESET = '';

function populateSystemPresetSelect() {
    if (!els.preset) return;

    els.preset.replaceChildren();

    const customOption = document.createElement('option');
    customOption.value = CUSTOM_SYSTEM_PROMPT_PRESET;
    customOption.innerText = CUSTOM_SYSTEM_PROMPT_PRESET;
    els.preset.appendChild(customOption);

    for (const name of Object.keys(PRESETS)) {
        const option = document.createElement('option');
        option.value = name;
        option.innerText = name;
        els.preset.appendChild(option);
    }
}

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

    populateSystemPresetSelect();
}

export async function loadCustomPromptIntoEditor({ fallbackToDefault = true } = {}) {
    try {
        const customPrompt = await loadCustomSystemPrompt();
        console.log('[Frontend] System prompt loaded:', customPrompt?.substring(0, 50) + '...');

        if (customPrompt && customPrompt.trim().length > 0) {
            els.promptBox.value = customPrompt;
            if (els.preset) els.preset.value = CUSTOM_SYSTEM_PROMPT_PRESET;
            return true;
        }
    } catch (e) {
        console.error('[Frontend] System prompt load failed:', e);
    }

    if (fallbackToDefault) {
        const defaultPrompt = getDefaultSystemPrompt();
        els.promptBox.value = defaultPrompt;
        if (els.preset) {
            els.preset.value = defaultPrompt
                ? DEFAULT_SYSTEM_PROMPT_PRESET
                : CUSTOM_SYSTEM_PROMPT_PRESET;
        }
    }

    return false;
}

export async function saveSystemPrompt() {
    try {
        els.promptStatus.innerText = 'Saving...';
        const msg = await saveCustomSystemPrompt(els.promptBox.value);
        els.promptStatus.innerText = msg;
        setTimeout(() => els.promptStatus.innerText = 'Idle', 3000);
    } catch (e) {
        els.promptStatus.innerText = '❌ Error: ' + e;
    }
}
