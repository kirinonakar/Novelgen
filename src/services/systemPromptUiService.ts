import { showToast } from '../modules/toast.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';
import {
    CUSTOM_SYSTEM_PROMPT_PRESET,
    deleteSystemPreset,
    loadCustomSystemPrompt,
    loadSystemPresetCatalog,
    loadSystemPresetChanges,
    resetSystemPresets,
    saveSystemPreset,
    type SystemPresetChanges,
} from './systemPromptService.js';

const LAST_SYSTEM_PRESET_KEY = 'last-system-preset';
const defaultPresets = new Map<string, string>();
let defaultPresetName = '';
let visiblePresets = new Map<string, string>();
let hasFileDefaultOverride = false;

function readLastSystemPreset(): string {
    try {
        return localStorage.getItem(LAST_SYSTEM_PRESET_KEY) ?? '';
    } catch (error) {
        console.warn('[Frontend] Failed to read the last system preset:', error);
        return '';
    }
}

function rememberSystemPreset(name: string) {
    try {
        if (name) localStorage.setItem(LAST_SYSTEM_PRESET_KEY, name);
        else localStorage.removeItem(LAST_SYSTEM_PRESET_KEY);
    } catch (error) {
        console.warn('[Frontend] Failed to remember the last system preset:', error);
    }
}

function applyPresetChanges(changes: SystemPresetChanges, preferredPreset = '') {
    hasFileDefaultOverride = Object.hasOwn(changes, CUSTOM_SYSTEM_PROMPT_PRESET);
    visiblePresets = new Map(defaultPresets);
    for (const [name, content] of Object.entries(changes)) {
        if (content === null) visiblePresets.delete(name);
        else visiblePresets.set(name, content);
    }

    const presetOptions = [...visiblePresets.keys()];
    const startupPreset = visiblePresets.get(CUSTOM_SYSTEM_PROMPT_PRESET)?.trim()
        ? CUSTOM_SYSTEM_PROMPT_PRESET
        : defaultPresetName;
    const selectedPreset = [preferredPreset, startupPreset].find(name => visiblePresets.has(name))
        ?? presetOptions[0] ?? '';
    runtimeViewStateStore.setPromptEditor({
        isLoadingPresets: false,
        presetOptions,
        selectedPreset,
        systemPrompt: visiblePresets.get(selectedPreset) ?? '',
    });
    return selectedPreset;
}

async function readFileDefault(): Promise<string | undefined> {
    try {
        return await loadCustomSystemPrompt();
    } catch (error) {
        console.error('[Frontend] Failed to load the file default system prompt:', error);
        return undefined;
    }
}

export async function loadSystemPromptPresets() {
    const [fileDefault, catalog, saved] = await Promise.allSettled([
        readFileDefault(),
        loadSystemPresetCatalog(),
        loadSystemPresetChanges(),
    ]);
    defaultPresets.clear();
    defaultPresetName = '';
    if (fileDefault.status === 'fulfilled' && fileDefault.value !== undefined) {
        defaultPresets.set(CUSTOM_SYSTEM_PROMPT_PRESET, fileDefault.value);
    }
    if (catalog.status === 'fulfilled') {
        for (const [name, content] of catalog.value.presets) defaultPresets.set(name, content);
        defaultPresetName = catalog.value.defaultPreset;
    } else {
        console.error('[Frontend] Failed to load built-in system prompt presets:', catalog.reason);
        showToast('Failed to load built-in system prompt presets.', 'warning');
    }
    if (saved.status === 'rejected') {
        console.error('[Frontend] Failed to load saved system prompt presets:', saved.reason);
        showToast('Failed to load saved system prompt presets.', 'warning');
    }
    applyPresetChanges(saved.status === 'fulfilled' ? saved.value : {}, readLastSystemPreset());
}

export function selectSystemPromptPreset(name: string) {
    const systemPrompt = visiblePresets.get(name);
    if (systemPrompt === undefined) return;

    runtimeViewStateStore.setPromptEditor({ selectedPreset: name, systemPrompt });
    rememberSystemPreset(name);
    if (name !== CUSTOM_SYSTEM_PROMPT_PRESET || hasFileDefaultOverride) return;

    const selection = runtimeViewStateStore.getSnapshot().promptEditor;
    void readFileDefault().then(content => {
        if (content === undefined || runtimeViewStateStore.getSnapshot().promptEditor !== selection) return;

        defaultPresets.set(name, content);
        visiblePresets.set(name, content);
        if (content !== systemPrompt) runtimeViewStateStore.setPromptEditor({ systemPrompt: content });
    });
}

export async function saveSystemPrompt(name: string) {
    const presetName = name.trim();
    const { systemPrompt } = runtimeViewStateStore.getSnapshot().promptEditor;
    const changes = await saveSystemPreset(presetName, systemPrompt);
    rememberSystemPreset(applyPresetChanges(changes, presetName));
    showToast(`Saved preset “${presetName}”.`, 'success');
}

export async function deleteSystemPrompt(name: string) {
    const changes = await deleteSystemPreset(name, defaultPresets.has(name));
    rememberSystemPreset(applyPresetChanges(changes));
    showToast(`Deleted preset “${name}”.`, 'success');
}

export async function resetSystemPrompts() {
    const fileDefault = await readFileDefault();
    await resetSystemPresets();
    if (fileDefault !== undefined) defaultPresets.set(CUSTOM_SYSTEM_PROMPT_PRESET, fileDefault);
    applyPresetChanges({});
    rememberSystemPreset('');
    showToast('System presets reset.', 'success');
}
