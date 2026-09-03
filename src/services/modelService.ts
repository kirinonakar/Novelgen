import { invoke } from '../modules/tauri_api.js';
import type { ApiProvider } from '../types/app.js';

export async function fetchModelNames(
    apiBase: string,
    apiKey?: string,
    provider?: ApiProvider,
): Promise<string[]> {
    const models = await invoke<string[]>('fetch_models', {
        apiBase,
        apiKey: apiKey || '',
        provider: provider || '',
    });
    return Array.isArray(models) ? models : [];
}
