import { els } from '../modules/dom_refs.js';
import type { ChapterNavigationController } from './chapterNavigationService.js';
import {
    installGlobalFileDropGuards,
    setupTextDropTarget,
} from './fileDropService.js';
import { initTabs } from './tabService.js';

interface RuntimeEventWiringOptions {
    chapterNavigation: ChapterNavigationController;
    handleDroppedTextLoaded: (targetId: string) => void | Promise<void>;
    updatePlotTokenCount: () => void;
}

export function createRuntimeEventSetup({
    chapterNavigation,
    handleDroppedTextLoaded,
    updatePlotTokenCount,
}: RuntimeEventWiringOptions) {
    return function setupEventListeners() {
        installGlobalFileDropGuards();

        setupTextDropTarget(els.promptBox.closest('.input-group') || els.promptBox, {
            targetId: els.promptBox.id,
            label: 'System Prompt Details',
            onTextLoaded: handleDroppedTextLoaded,
        });

        chapterNavigation.initNovelChapterJump();
        initTabs({
            setupTextDropTarget: (element, options) => setupTextDropTarget(element, {
                ...options,
                onTextLoaded: handleDroppedTextLoaded,
            }),
            updatePlotTokenCount,
            refreshNovelChapterJump: chapterNavigation.refreshNovelChapterJump,
            scrollNovelToSelectedChapter: chapterNavigation.scrollNovelToSelectedChapter,
            getNovelChapterJumpValue: () => els.novelChapterJump?.value || '',
        });
    };
}
