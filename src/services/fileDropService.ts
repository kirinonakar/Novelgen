import { showToast } from '../modules/toast.js';
import { eventHasFiles, getDroppedFile } from '../modules/text_utils.js';
import { readSupportedTextFile, UnsupportedTextFileError } from './textFileService.js';

export function installGlobalFileDropGuards() {
    const listeners: Array<[string, (event: Event) => void]> = [];

    ['dragenter', 'dragover', 'drop'].forEach(eventName => {
        const listener = (event: Event) => {
            if (!eventHasFiles(event as DragEvent)) return;
            event.preventDefault();
        };
        listeners.push([eventName, listener]);
        document.addEventListener(eventName, listener);
    });

    return () => {
        listeners.forEach(([eventName, listener]) => {
            document.removeEventListener(eventName, listener);
        });
    };
}

export function eventHasDroppedFiles(event: DragEvent) {
    return eventHasFiles(event);
}

export async function readDroppedTextFromEvent(event: DragEvent, label: string) {
    const file = getDroppedFile(event);
    if (!file) return null;

    try {
        const text = await readSupportedTextFile(file);
        showToast(`Loaded ${file.name} into ${label}.`, 'success');
        return text;
    } catch (e) {
        console.error(`[Frontend] Failed to read dropped file for ${label}:`, e);
        if (e instanceof UnsupportedTextFileError) {
            showToast(`Only .txt or .md files can be dropped into ${label}.`, 'warning');
            return null;
        }
        showToast(`Failed to load ${file.name}.`, 'error');
        return null;
    }
}
