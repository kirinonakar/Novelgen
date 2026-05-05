import { getNovelChapterHeadings } from '../modules/novel_refine.js';
import { showToast } from '../modules/toast.js';
import type { Language, NovelChapterJumpOption } from '../types/app.js';
import { getRuntimeElement } from './runtimeDomRegistryService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';

export interface ChapterNavigationController {
    refreshNovelChapterJump(options?: { preserveValue?: boolean }): unknown[];
    scrollNovelToSelectedChapter(options?: { silent?: boolean }): void;
    initNovelChapterJump(): void;
}

interface ChapterNavigationOptions {
    getLang: () => Language;
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

function getTextareaOffsetScrollTop(textarea: HTMLTextAreaElement, offset: number) {
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

    mirror.textContent = textarea.value.slice(0, offset);
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);

    const targetScrollTop = Math.max(0, marker.offsetTop - paddingTop);
    mirror.remove();

    return Math.min(
        targetScrollTop,
        Math.max(0, textarea.scrollHeight - textarea.clientHeight)
    );
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

export function createChapterNavigation({ getLang }: ChapterNavigationOptions): ChapterNavigationController {
    function refreshNovelChapterJump({ preserveValue = true } = {}) {
        const { editor } = runtimeViewStateStore.getSnapshot();
        const selectedChapter = preserveValue ? editor.novelChapterJump : '';
        const headings = getNovelChapterHeadings(editor.novel, getLang());
        const jumpOptions = buildChapterJumpOptions(headings);
        const selectedStillExists = jumpOptions.some(option => option.value === selectedChapter);

        runtimeViewStateStore.setEditor({
            novelChapterJump: selectedStillExists ? selectedChapter : '',
            novelChapterJumpOptions: jumpOptions,
        });

        return headings;
    }

    function findNovelPreviewChapterElement(chapterNumber: number) {
        const preview = getRuntimeElement('novelContentPreview');
        if (!preview) return null;

        const candidates = preview.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote');
        return Array.from<Element>(candidates).find(element =>
            matchesChapterHeadingText(element.textContent, chapterNumber, getLang())
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

    function initNovelChapterJump() {
        refreshNovelChapterJump({ preserveValue: false });
    }

    return {
        refreshNovelChapterJump,
        scrollNovelToSelectedChapter,
        initNovelChapterJump,
    };
}
