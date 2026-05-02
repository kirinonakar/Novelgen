import type { NovelgenRuntimeActions } from '../types/app.js';
import { createAppSettingsController } from './appSettingsUiService.js';
import { createChapterNavigation } from './chapterNavigationService.js';
import { createNovelChapterDetector } from './novelChapterDetectionService.js';
import { createPlotActions } from './plotActionService.js';
import { createRuntimeActions } from './runtimeActionBindingService.js';
import { createRuntimeBootstrap } from './runtimeBootstrapService.js';
import { createRuntimeDropHandler } from './runtimeDropHandlerService.js';
import { createRuntimeEventSetup } from './runtimeEventWiringService.js';
import {
    loadNovel as loadSavedNovel,
    reloadNovelList,
    reloadPlotList,
    saveNovel,
} from './savedContentService.js';
import { getSelectedLanguage, getSelectedProvider } from './runtimeSelectorsService.js';
import {
    getPresetPrompt,
    loadCustomPromptIntoEditor,
} from './systemPromptUiService.js';
import { createRuntimeWorkflowActions } from './runtimeWorkflowActionsService.js';
import { updatePlotTokenCount } from './textMetricsUiService.js';

export interface NovelgenRuntimeController {
    actions: NovelgenRuntimeActions;
    initialize: () => Promise<void>;
}

const getLang = getSelectedLanguage;
const getProvider = getSelectedProvider;

export function createNovelgenRuntimeController(): NovelgenRuntimeController {
    const appSettings = createAppSettingsController({ getProvider });
    const chapterNavigation = createChapterNavigation({ getLang });
    const chapterDetector = createNovelChapterDetector({ getLang });
    const plotActions = createPlotActions({ getLang, getProvider, updatePlotTokenCount });
    const detectNextChapter = chapterDetector.detectNextChapter;
    const handleDroppedTextLoaded = createRuntimeDropHandler({
        detectNextChapter,
        refreshNovelChapterJump: chapterNavigation.refreshNovelChapterJump,
        updatePlotTokenCount,
    });
    const setupEventListeners = createRuntimeEventSetup({
        chapterNavigation,
        handleDroppedTextLoaded,
    });
    const workflowActions = createRuntimeWorkflowActions({
        getLang,
        getProvider,
        getPresetPrompt,
        loadCustomPromptIntoEditor,
        saveSettings: appSettings.saveSettings,
        updatePlotTokenCount,
        reloadNovelList,
        loadNovel: () => loadSavedNovel({
            saveSettings: appSettings.saveSettings,
            detectNextChapter,
            refreshNovelChapterJump: chapterNavigation.refreshNovelChapterJump,
            updatePlotTokenCount,
            getLang,
        }),
        saveNovel,
        reloadPlotList,
        detectNextChapter,
        refreshNovelChapterJump: chapterNavigation.refreshNovelChapterJump,
        scrollNovelToSelectedChapter: chapterNavigation.scrollNovelToSelectedChapter,
    });
    const actions = createRuntimeActions({ appSettings, plotActions, workflowActions });
    const initialize = createRuntimeBootstrap({
        appSettings,
        getProvider,
        setupEventListeners,
    });

    return {
        actions,
        initialize,
    };
}
