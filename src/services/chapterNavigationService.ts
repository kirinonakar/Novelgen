import { els } from '../modules/dom_refs.js';
import { getNovelChapterHeadings } from '../modules/novel_refine.js';
import { renderMarkdown } from '../modules/preview.js';
import { showToast } from '../modules/toast.js';
import type { Language } from '../types/app.js';

export interface ChapterNavigationController {
    refreshNovelChapterJump(options?: { preserveValue?: boolean }): unknown[];
    scrollNovelToSelectedChapter(options?: { silent?: boolean }): void;
    initNovelChapterJump(): void;
}

interface ChapterNavigationOptions {
    getLang: () => Language;
}

function getActiveTab(container: Element | null) {
    return container?.querySelector('.tab-btn.active')?.getAttribute('data-tab') || 'edit';
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
        const select = els.novelChapterJump;
        if (!select || !els.novelContent) return [];

        const selectedChapter = preserveValue
            ? select.selectedOptions?.[0]?.dataset?.chapterNumber || select.value
            : '';
        const headings = getNovelChapterHeadings(els.novelContent.value, getLang());

        select.replaceChildren();

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = headings.length ? 'Jump to...' : 'No chapters';
        placeholder.disabled = headings.length > 0;
        placeholder.selected = true;
        select.appendChild(placeholder);

        for (const heading of headings) {
            const option = document.createElement('option');
            option.value = String(heading.number);
            option.dataset.chapterNumber = String(heading.number);
            option.dataset.offset = String(heading.index);
            option.textContent = formatChapterJumpLabel(heading);
            select.appendChild(option);
        }

        if (selectedChapter) {
            const matchingOption = Array.from<HTMLOptionElement>(select.options)
                .find(option => option.dataset.chapterNumber === selectedChapter);
            if (matchingOption) {
                matchingOption.selected = true;
            }
        }

        return headings;
    }

    function findNovelPreviewChapterElement(chapterNumber: number) {
        const preview = els.novelContentPreview;
        if (!preview) return null;

        const candidates = preview.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote');
        return Array.from<Element>(candidates).find(element =>
            matchesChapterHeadingText(element.textContent, chapterNumber, getLang())
        ) || null;
    }

    function scrollNovelPreviewToChapter(chapterNumber: number, offset: number | null = null) {
        const preview = els.novelContentPreview;
        const target = findNovelPreviewChapterElement(chapterNumber);
        if (!preview) return false;

        if (target) {
            scrollElementIntoScrollableAncestor(target);
            return true;
        }

        if (Number.isFinite(offset) && els.novelContent?.value) {
            const ratio = Math.max(0, Math.min(Number(offset) / els.novelContent.value.length, 1));
            const scroller = getScrollableAncestor(preview);
            scroller.scrollTop = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            return true;
        }

        return false;
    }

    function scrollNovelToSelectedChapter({ silent = false } = {}) {
        const select = els.novelChapterJump;
        const selectedOption = select?.selectedOptions?.[0];
        if (!selectedOption?.dataset?.chapterNumber) return;

        const chapterNumber = parseInt(selectedOption.dataset.chapterNumber, 10);
        const offset = parseInt(selectedOption.dataset.offset || '', 10);
        const container = select.closest('.tabs-container');
        const activeTab = getActiveTab(container);

        if (activeTab === 'preview') {
            renderMarkdown(els.novelContent.id);
            requestAnimationFrame(() => {
                const didScroll = scrollNovelPreviewToChapter(chapterNumber, offset);
                if (!didScroll && !silent) {
                    showToast(`Chapter ${chapterNumber} was not found in preview.`, 'warning');
                }
            });
            return;
        }

        if (Number.isFinite(offset) && els.novelContent) {
            scrollTextareaToOffset(els.novelContent, offset);
        }
    }

    function initNovelChapterJump() {
        refreshNovelChapterJump({ preserveValue: false });

        els.novelContent?.addEventListener('novel-content-updated', () => {
            refreshNovelChapterJump();
        });
        els.novelChapterJump?.addEventListener('pointerdown', () => {
            refreshNovelChapterJump();
        });
        els.novelChapterJump?.addEventListener('focus', () => {
            refreshNovelChapterJump();
        });
        els.novelChapterJump?.addEventListener('change', () => {
            scrollNovelToSelectedChapter();
        });
    }

    return {
        refreshNovelChapterJump,
        scrollNovelToSelectedChapter,
        initNovelChapterJump,
    };
}
