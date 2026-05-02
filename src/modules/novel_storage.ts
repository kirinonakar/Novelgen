import { invoke } from './tauri_api.js';

export async function loadNovelState(filename) {
    const [text, metaJson] = await invoke("load_novel", { filename });
    let meta = null;
    if (metaJson) {
        try {
            meta = JSON.parse(metaJson);
        } catch (e) {
            console.warn(`[Frontend] Failed to parse metadata for ${filename}:`, e);
        }
    }
    return { filename, text, meta };
}

export async function loadLatestNovelState() {
    const result = await invoke('get_latest_novel_metadata');
    if (!result) return null;

    const [filename, jsonStr] = result;
    const meta = JSON.parse(jsonStr);
    let text = "";
    try {
        const loaded = await invoke("load_novel", { filename });
        text = loaded[0];
    } catch (e) {
        console.warn(`[Frontend] Failed to load latest novel text for ${filename}:`, e);
    }

    return { filename, text, meta };
}

export function metadataNextChapter(meta) {
    const current = Number(meta?.current_chapter || 0);
    return current > 0 ? current + 1 : null;
}
