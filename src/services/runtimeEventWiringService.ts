import { els } from '../modules/dom_refs.js';
import type { ChapterNavigationController } from './chapterNavigationService.js';
import {
    installGlobalFileDropGuards,
    setupTextDropTarget,
} from './fileDropService.js';

interface RuntimeEventWiringOptions {
    chapterNavigation: ChapterNavigationController;
    handleDroppedTextLoaded: (targetId: string, text: string) => void | Promise<void>;
}

export function createRuntimeEventSetup({
    chapterNavigation,
    handleDroppedTextLoaded,
}: RuntimeEventWiringOptions) {
    function setupEditorDropTarget(element: Element | null | undefined, label: string) {
        if (!element?.id) return;
        setupTextDropTarget(element.closest('.tab-content') || element, {
            targetId: element.id,
            label,
            onTextLoaded: handleDroppedTextLoaded,
        });
    }

    return function setupEventListeners() {
        installGlobalFileDropGuards();

        setupTextDropTarget(els.promptBox.closest('.input-group') || els.promptBox, {
            targetId: els.promptBox.id,
            label: 'System Prompt Details',
            onTextLoaded: handleDroppedTextLoaded,
        });

        chapterNavigation.initNovelChapterJump();
        setupEditorDropTarget(els.seedBox, 'Seed');
        setupEditorDropTarget(els.plotContent, 'Plot');
        setupEditorDropTarget(els.novelContent, 'Novel');
    };
}
