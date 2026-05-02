import { invoke } from '../modules/tauri_api.js';
import { fetchTextAsset, parseSystemPresetIndex } from '../modules/text_utils.js';
import type { SystemPresetCatalog } from '../types/app.js';

export const CUSTOM_SYSTEM_PROMPT_PRESET = 'Custom (File Default)';
const SYSTEM_PRESET_INDEX_URL = 'prompts/system_presets/index.txt';

export async function loadSystemPresetCatalog(): Promise<SystemPresetCatalog> {
    const indexText = await fetchTextAsset(SYSTEM_PRESET_INDEX_URL);
    const entries = parseSystemPresetIndex(indexText);
    const presets: Record<string, string> = {};
    let defaultPreset = '';

    for (const entry of entries) {
        const prompt = await fetchTextAsset(`prompts/system_presets/${entry.file}`);
        if (!prompt.trim()) continue;

        presets[entry.name] = prompt.trimEnd();
        if (entry.isDefault) defaultPreset = entry.name;
    }

    return {
        presets,
        defaultPreset: presets[defaultPreset] ? defaultPreset : Object.keys(presets)[0] || '',
    };
}

export async function loadCustomSystemPrompt(): Promise<string> {
    return await invoke<string>('load_system_prompt');
}

export async function saveCustomSystemPrompt(content: string): Promise<string> {
    return await invoke<string>('save_system_prompt', { content });
}
