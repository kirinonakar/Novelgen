import { invoke } from '../modules/tauri_api.js';

export async function fetchModelNames(apiBase: string): Promise<string[]> {
    const models = await invoke<string[]>('fetch_models', { apiBase });
    return Array.isArray(models) ? models : [];
}
