import { invoke } from '../modules/tauri_api.js';
import { fetchTextAsset, parseSystemPresetIndex } from '../modules/text_utils.js';
import type { SystemPresetCatalog } from '../types/app.js';

export const CUSTOM_SYSTEM_PROMPT_PRESET = 'Custom (File Default)';
const SYSTEM_PRESET_INDEX_URL = 'prompts/system_presets/index.txt';

export async function loadSystemPresetCatalog(): Promise<SystemPresetCatalog> {
    const indexText = await fetchTextAsset(SYSTEM_PRESET_INDEX_URL);
    const entries = parseSystemPresetIndex(indexText);
    const prompts = await Promise.all(entries.map(entry => fetchTextAsset(`prompts/system_presets/${entry.file}`)));
    const presets = new Map<string, string>();
    let defaultPreset = '';

    for (const [index, entry] of entries.entries()) {
        const prompt = prompts[index];
        if (!prompt.trim()) continue;

        presets.set(entry.name, prompt.trimEnd());
        if (entry.isDefault) defaultPreset = entry.name;
    }

    return { presets, defaultPreset };
}

export async function loadCustomSystemPrompt(): Promise<string> {
    return await invoke<string>('load_system_prompt');
}

export type SystemPresetChanges = Record<string, string | null>;

export async function loadSystemPresetChanges(): Promise<SystemPresetChanges> {
    return await invoke<SystemPresetChanges>('load_system_prompt_presets');
}

export async function saveSystemPreset(name: string, content: string): Promise<SystemPresetChanges> {
    return await invoke<SystemPresetChanges>('save_system_prompt_preset', { name, content });
}

export async function deleteSystemPreset(name: string, hasDefault: boolean): Promise<SystemPresetChanges> {
    return await invoke<SystemPresetChanges>('delete_system_prompt_preset', { name, hasDefault });
}

export async function resetSystemPresets(): Promise<void> {
    await invoke('reset_system_prompt_presets');
}
