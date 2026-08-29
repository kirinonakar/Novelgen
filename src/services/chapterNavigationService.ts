import { getNovelChapterHeadings } from '../modules/novel_refine.js';
import { showToast } from '../modules/toast.js';
import type { Language, NovelChapterJumpOption } from '../types/app.js';
import { getRuntimeElement } from './runtimeDomRegistryService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';

export interface ChapterNavigationController {
    refreshNovelChapterJump(options?: { preserveValue?: boolean; debounce?: boolean }): Promise<unknown[]>;
    scrollNovelToSelectedChapter(options?: { silent?: boolean }): void;
    syncNovelChapterToScroll(): void;
    initNovelChapterJump(): void;
}

interface ChapterNavigationOptions {
    getLang: () => Language;
}

const CHAPTER_JUMP_LANGUAGES: Language[] = ['Korean', 'Japanese', 'English'];

function getChapterJumpLanguages(preferredLang: Language) {
    return [
        preferredLang,
        ...CHAPTER_JUMP_LANGUAGES.filter(lang => lang !== preferredLang),
    ];
}

function getNovelChapterHeadingsWithFallback(text: string, preferredLang: Language) {
    let bestHeadings = [];
    for (const lang of getChapterJumpLanguages(preferredLang)) {
        const headings = getNovelChapterHeadings(text, lang);
        if (headings.length > bestHeadings.length) {
            bestHeadings = headings;
        }
    }

    return bestHeadings;
}

function formatChapterJumpLabel(heading) {
    const cleanHeader = String(heading.header || '')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s*/, '')
        .replace(/^\*\*/, '')
        .replace(/\*\*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    const label = cleanHeader || `Chapter ${heading.number}`;
    return label.length > 70 ? `${label.slice(0, 67)}...` : label;
}

function buildChapterJumpOptions(headings): NovelChapterJumpOption[] {
    return headings.map(heading => ({
        value: String(heading.number),
        label: formatChapterJumpLabel(heading),
        chapterNumber: heading.number,
        offset: heading.index,
    }));
}

function scrollTextareaToOffset(textarea: HTMLTextAreaElement, offset: number) {
    const safeOffset = Math.max(0, Math.min(offset, textarea.value.length));
    const targetScrollTop = getTextareaOffsetScrollTop(textarea, safeOffset);

    try {
        textarea.focus({ preventScroll: true });
    } catch (_) {
        textarea.focus();
    }
    textarea.setSelectionRange(safeOffset, safeOffset);
    textarea.scrollTop = targetScrollTop;
    requestAnimationFrame(() => {
        textarea.scrollTop = targetScrollTop;
    });
}

function getTextareaOffsetsScrollTop(textarea: HTMLTextAreaElement, offsets: number[]) {
    const style = window.getComputedStyle(textarea);
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderRight = parseFloat(style.borderRightWidth) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const mirror = document.createElement('div');
    const mirrorWidth = textarea.clientWidth + borderLeft + borderRight;
    const properties = [
        'boxSizing',
        'fontFamily',
        'fontSize',
        'fontWeight',
        'fontStyle',
        'letterSpacing',
        'lineHeight',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'borderTopWidth',
        'borderRightWidth',
        'borderBottomWidth',
        'borderLeftWidth',
        'textTransform',
        'textIndent',
        'tabSize',
        'wordBreak',
        'overflowWrap',
    ];

    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.left = '-99999px';
    mirror.style.top = '0';
    mirror.style.width = `${mirrorWidth}px`;
    mirror.style.height = 'auto';
    mirror.style.minHeight = '0';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';

    for (const property of properties) {
        mirror.style[property] = style[property];
    }

    const markers: HTMLSpanElement[] = [];
    let cursor = 0;
    for (const offset of offsets) {
        const safeOffset = Math.max(cursor, Math.min(offset, textarea.value.length));
        mirror.appendChild(document.createTextNode(textarea.value.slice(cursor, safeOffset)));
        const marker = document.createElement('span');
        marker.textContent = '\u200b';
        mirror.appendChild(marker);
        markers.push(marker);
        cursor = safeOffset;
    }
    document.body.appendChild(mirror);

    const maxScrollTop = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
    const scrollTops = markers.map(marker => Math.min(
        Math.max(0, marker.offsetTop - paddingTop),
        maxScrollTop,
    ));
    mirror.remove();

    return scrollTops;
}

function getTextareaOffsetScrollTop(textarea: HTMLTextAreaElement, offset: number) {
    return getTextareaOffsetsScrollTop(textarea, [offset])[0] || 0;
}

function matchesChapterHeadingText(text: string | null, chapterNumber: number, lang: Language) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return false;

    if (lang === 'Korean') {
        return new RegExp(`^(?:제\\s*)?${chapterNumber}\\s*장(?:\\s|[:：.)、\\-–—]|$)`, 'i').test(normalized);
    }
    if (lang === 'Japanese') {
        return new RegExp(`^(?:第\\s*)?${chapterNumber}\\s*章(?:\\s|[:：.)、\\-–—]|$)`, 'i').test(normalized);
    }
    return new RegExp(`^Chapter\\s+${chapterNumber}(?:\\s|[:：.)、\\-–—]|$)`, 'i').test(normalized);
}

function getScrollableAncestor(element: Element) {
    let current: Element | null = element;
    while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        const canScrollY = /(auto|scroll)/.test(style.overflowY);
        if (canScrollY && current.scrollHeight > current.clientHeight + 1) {
            return current;
        }
        current = current.parentElement;
    }

    return document.scrollingElement || document.documentElement;
}

function scrollElementIntoScrollableAncestor(target: Element, { offset = 52 } = {}) {
    const scroller = getScrollableAncestor(target);
    const targetRect = target.getBoundingClientRect();
    const scrollerRect = scroller === document.scrollingElement
        ? { top: 0 }
        : scroller.getBoundingClientRect();

    scroller.scrollTop += targetRect.top - scrollerRect.top - offset;
}

let lastNovelText = '';
let pendingTimeoutId: any = null;
let maxWaitTimeoutId: any = null;

export function createChapterNavigation({ getLang }: ChapterNavigationOptions): ChapterNavigationController {
    let scrollSyncFrameId: number | null = null;
    let previewChapterCache: {
        novelText: string;
        preview: HTMLElement;
        entries: Array<{ value: string; element: Element }>;
    } | null = null;
    let textareaChapterCache: {
        layoutKey: string;
        novelText: string;
        entries: Array<{ value: string; scrollTop: number }>;
    } | null = null;

    function refreshNovelChapterJump({ preserveValue = true, debounce = true } = {}) {
        const clearTimers = () => {
            if (pendingTimeoutId) {
                clearTimeout(pendingTimeoutId);
                pendingTimeoutId = null;
            }
            if (maxWaitTimeoutId) {
                clearTimeout(maxWaitTimeoutId);
                maxWaitTimeoutId = null;
            }
        };

        const execute = () => {
            clearTimers();

            const { editor } = runtimeViewStateStore.getSnapshot();
            if (editor.novel === lastNovelText) {
                return [];
            }
            lastNovelText = editor.novel;

            const selectedChapter = preserveValue ? editor.novelChapterJump : '';
            const headings = getNovelChapterHeadingsWithFallback(editor.novel, getLang());
            const jumpOptions = buildChapterJumpOptions(headings);
            const selectedStillExists = jumpOptions.some(option => option.value === selectedChapter);

            runtimeViewStateStore.setEditor({
                novelChapterJump: selectedStillExists ? selectedChapter : '',
                novelChapterJumpOptions: jumpOptions,
            });

            return headings;
        };

        if (!debounce) {
            clearTimers();
            return Promise.resolve(execute());
        }

        const debounceDelay = 150;
        const maxWait = 2000;

        if (pendingTimeoutId) {
            clearTimeout(pendingTimeoutId);
        }

        if (!maxWaitTimeoutId) {
            maxWaitTimeoutId = setTimeout(() => {
                maxWaitTimeoutId = null;
                if (pendingTimeoutId) {
                    clearTimeout(pendingTimeoutId);
                    pendingTimeoutId = null;
                }
                execute();
            }, maxWait);
        }

        return new Promise<unknown[]>((resolve) => {
            pendingTimeoutId = setTimeout(() => {
                pendingTimeoutId = null;
                if (maxWaitTimeoutId) {
                    clearTimeout(maxWaitTimeoutId);
                    maxWaitTimeoutId = null;
                }
                resolve(execute());
            }, debounceDelay);
        });
    }

    function findNovelPreviewChapterElement(chapterNumber: number) {
        const preview = getRuntimeElement('novelContentPreview');
        if (!preview) return null;

        const candidates = preview.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote');
        const languages = getChapterJumpLanguages(getLang());
        return Array.from<Element>(candidates).find(element =>
            languages.some(lang => matchesChapterHeadingText(element.textContent, chapterNumber, lang))
        ) || null;
    }

    function scrollNovelPreviewToChapter(chapterNumber: number, offset: number | null = null) {
        const preview = getRuntimeElement('novelContentPreview');
        const target = findNovelPreviewChapterElement(chapterNumber);
        if (!preview) return false;

        if (target) {
            scrollElementIntoScrollableAncestor(target);
            return true;
        }

        const novelText = runtimeViewStateStore.getSnapshot().editor.novel;
        if (Number.isFinite(offset) && novelText) {
            const ratio = Math.max(0, Math.min(Number(offset) / novelText.length, 1));
            const scroller = getScrollableAncestor(preview);
            scroller.scrollTop = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            return true;
        }

        return false;
    }

    function scrollNovelToSelectedChapter({ silent = false } = {}) {
        const { editor } = runtimeViewStateStore.getSnapshot();
        const selectedOption = editor.novelChapterJumpOptions
            .find(option => option.value === editor.novelChapterJump);
        if (!selectedOption) return;

        const { chapterNumber, offset } = selectedOption;
        const activeTab = editor.tabs.novel;

        if (activeTab === 'preview') {
            requestAnimationFrame(() => {
                const didScroll = scrollNovelPreviewToChapter(chapterNumber, offset);
                if (!didScroll && !silent) {
                    showToast(`Chapter ${chapterNumber} was not found in preview.`, 'warning');
                }
            });
            return;
        }

        const novelContent = getRuntimeElement('novelContent');
        if (Number.isFinite(offset) && novelContent) {
            scrollTextareaToOffset(novelContent, offset);
        }
    }

    function findPreviewChapterAtScrollPosition() {
        const preview = getRuntimeElement('novelContentPreview');
        const { editor } = runtimeViewStateStore.getSnapshot();
        if (!preview || editor.novelChapterJumpOptions.length === 0) return null;

        if (
            !previewChapterCache
            || previewChapterCache.preview !== preview
            || previewChapterCache.novelText !== editor.novel
            || previewChapterCache.entries.some(entry => !entry.element.isConnected)
        ) {
            const entries = editor.novelChapterJumpOptions.flatMap(option => {
                const element = findNovelPreviewChapterElement(option.chapterNumber);
                return element ? [{ value: option.value, element }] : [];
            });
            previewChapterCache = { novelText: editor.novel, preview, entries };
        }

        const scroller = getScrollableAncestor(preview);
        const scrollerRect = scroller === document.scrollingElement
            ? { top: 0 }
            : scroller.getBoundingClientRect();
        const scrollTop = scroller.scrollTop;
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);

        if (maxScrollTop > 0 && scrollTop >= maxScrollTop - 2) {
            return editor.novelChapterJumpOptions.at(-1)?.value || null;
        }

        const readingLine = scrollerRect.top + Math.min(72, scroller.clientHeight * 0.2);
        let activeChapter = editor.novelChapterJumpOptions[0].value;

        for (const entry of previewChapterCache.entries) {
            if (entry.element.getBoundingClientRect().top > readingLine) break;
            activeChapter = entry.value;
        }

        return activeChapter;
    }

    function findTextareaChapterAtScrollPosition() {
        const textarea = getRuntimeElement('novelContent');
        const { editor } = runtimeViewStateStore.getSnapshot();
        if (!textarea || editor.novelChapterJumpOptions.length === 0) return null;

        const maxScrollTop = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
        if (maxScrollTop <= 0) return editor.novelChapterJumpOptions[0].value;

        if (textarea.scrollTop >= maxScrollTop - 2) {
            return editor.novelChapterJumpOptions.at(-1)?.value || null;
        }

        const style = window.getComputedStyle(textarea);
        const layoutKey = [
            textarea.clientWidth,
            textarea.scrollHeight,
            style.fontFamily,
            style.fontSize,
            style.letterSpacing,
            style.lineHeight,
        ].join(':');

        if (
            !textareaChapterCache
            || textareaChapterCache.novelText !== editor.novel
            || textareaChapterCache.layoutKey !== layoutKey
        ) {
            const scrollTops = getTextareaOffsetsScrollTop(
                textarea,
                editor.novelChapterJumpOptions.map(option => option.offset),
            );
            textareaChapterCache = {
                layoutKey,
                novelText: editor.novel,
                entries: editor.novelChapterJumpOptions.map((option, index) => ({
                    value: option.value,
                    scrollTop: scrollTops[index] || 0,
                })),
            };
        }

        const readingLine = textarea.scrollTop + Math.min(48, textarea.clientHeight * 0.15);
        let activeChapter = editor.novelChapterJumpOptions[0].value;

        for (const entry of textareaChapterCache.entries) {
            if (entry.scrollTop > readingLine) break;
            activeChapter = entry.value;
        }

        return activeChapter;
    }

    function syncNovelChapterToScroll() {
        if (scrollSyncFrameId !== null) return;

        scrollSyncFrameId = requestAnimationFrame(() => {
            scrollSyncFrameId = null;
            const { editor } = runtimeViewStateStore.getSnapshot();
            const activeChapter = editor.tabs.novel === 'preview'
                ? findPreviewChapterAtScrollPosition()
                : findTextareaChapterAtScrollPosition();

            if (activeChapter && activeChapter !== editor.novelChapterJump) {
                runtimeViewStateStore.setEditor({ novelChapterJump: activeChapter });
            }
        });
    }

    function initNovelChapterJump() {
        void refreshNovelChapterJump({ preserveValue: false, debounce: false });
    }

    return {
        refreshNovelChapterJump,
        scrollNovelToSelectedChapter,
        syncNovelChapterToScroll,
        initNovelChapterJump,
    };
}
