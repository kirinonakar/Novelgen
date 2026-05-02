import { renderMarkdown } from '../modules/preview.js';
import { showToast } from '../modules/toast.js';
import { eventHasFiles, getDroppedFile } from '../modules/text_utils.js';
import { readSupportedTextFile, UnsupportedTextFileError } from './textFileService.js';

export interface TextDropTargetOptions {
    targetId: string;
    label: string;
    onTextLoaded?: (targetId: string) => void | Promise<void>;
}

export function installGlobalFileDropGuards() {
    ['dragenter', 'dragover', 'drop'].forEach(eventName => {
        document.addEventListener(eventName, (event) => {
            if (!eventHasFiles(event as DragEvent)) return;
            event.preventDefault();
        });
    });
}

export function setupTextDropTarget(element: Element | null | undefined, options: TextDropTargetOptions) {
    if (!element) return;
    let dragDepth = 0;

    element.addEventListener('dragenter', (event) => {
        if (!eventHasFiles(event as DragEvent)) return;
        event.preventDefault();
        dragDepth += 1;
        element.classList.add('file-drop-active');
    });

    element.addEventListener('dragover', (event) => {
        if (!eventHasFiles(event as DragEvent)) return;
        event.preventDefault();
        (event as DragEvent).dataTransfer!.dropEffect = 'copy';
        element.classList.add('file-drop-active');
    });

    element.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            element.classList.remove('file-drop-active');
        }
    });

    element.addEventListener('drop', async (event) => {
        if (!eventHasFiles(event as DragEvent)) return;
        event.preventDefault();
        dragDepth = 0;
        element.classList.remove('file-drop-active');

        const file = getDroppedFile(event as DragEvent);
        if (!file) return;

        const textarea = document.getElementById(options.targetId) as HTMLTextAreaElement | null;
        if (!textarea) return;

        try {
            const text = await readSupportedTextFile(file);
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            renderMarkdown(options.targetId);
            await options.onTextLoaded?.(options.targetId);
            showToast(`Loaded ${file.name} into ${options.label}.`, 'success');
        } catch (e) {
            console.error(`[Frontend] Failed to read dropped file for ${options.label}:`, e);
            if (e instanceof UnsupportedTextFileError) {
                showToast(`Only .txt or .md files can be dropped into ${options.label}.`, 'warning');
                return;
            }
            showToast(`Failed to load ${file.name}.`, 'error');
        }
    });
}
