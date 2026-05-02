import { renderMarkdown, schedulePreviewRender } from '../modules/preview.js';
import type { TextDropTargetOptions } from './fileDropService.js';

interface InitTabsOptions {
    setupTextDropTarget: (element: Element | null | undefined, options: TextDropTargetOptions) => void;
    updatePlotTokenCount: () => void;
    refreshNovelChapterJump: (options?: { preserveValue?: boolean }) => unknown[];
    scrollNovelToSelectedChapter: (options?: { silent?: boolean }) => void;
    getNovelChapterJumpValue: () => string;
}

export function initTabs({
    setupTextDropTarget,
    updatePlotTokenCount,
    refreshNovelChapterJump,
    scrollNovelToSelectedChapter,
    getNovelChapterJumpValue,
}: InitTabsOptions) {
    document.querySelectorAll('.tabs-container').forEach(container => {
        const targetId = container.getAttribute('data-for');
        if (!targetId) return;

        const textarea = document.getElementById(targetId);
        const preview = document.getElementById(`${targetId}-preview`);
        const label = container.querySelector<HTMLElement>('.tab-label')?.innerText?.trim() || targetId;
        const dropTarget = container.querySelector('.tab-content') || textarea || preview;
        const tabBtns = container.querySelectorAll('.tab-btn');
        const panes = container.querySelectorAll('.tab-pane');

        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');

                tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                panes.forEach(p => {
                    if (p.getAttribute('data-pane') === tab) p.classList.add('active');
                    else p.classList.remove('active');
                });

                if (tab === 'preview') {
                    renderMarkdown(targetId);
                }
                if (targetId === 'novel-content') {
                    refreshNovelChapterJump();
                    if (getNovelChapterJumpValue()) {
                        requestAnimationFrame(() => scrollNovelToSelectedChapter({ silent: true }));
                    }
                }
            });
        });

        textarea?.addEventListener('input', () => {
            if (targetId === 'plot-content') {
                updatePlotTokenCount();
            }
            if (targetId === 'novel-content') {
                refreshNovelChapterJump();
            }
            if (preview?.parentElement?.classList.contains('active')) {
                schedulePreviewRender(targetId, { source: 'manual' });
            }
        });

        setupTextDropTarget(dropTarget, { targetId, label });
    });
}
