export function renderMarkdown(id) {
    const textarea = document.getElementById(id);
    const preview = document.getElementById(`${id}-preview`);
    if (textarea && preview && window.marked) {
        let text = textarea.value;

        text = text.replace(/\*\*(\$\$?[\s\S]+?\$\$?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/__(\$\$?[\s\S]+?\$\$?)__/g, '<strong>$1</strong>');

        const processedText = text.replace(/~/g, '\\~');
        preview.innerHTML = window.marked.parse(processedText);
    }
}

const previewRenderState = new Map();
const MANUAL_PREVIEW_RENDER_DELAY_MS = 350;
const STREAM_PREVIEW_RENDER_INTERVAL_MS = 1000;
const STREAM_PREVIEW_INITIAL_DELAY_MS = 650;
const STREAM_PREVIEW_MIN_DELAY_MS = 250;

function getPreviewRenderState(id) {
    if (!previewRenderState.has(id)) {
        previewRenderState.set(id, {
            timeoutId: null,
            lastRenderedAt: 0,
            hasPendingUpdate: false,
        });
    }

    return previewRenderState.get(id);
}

function isPreviewPaneActive(id) {
    const preview = document.getElementById(`${id}-preview`);
    return Boolean(preview?.closest('.tab-pane')?.classList.contains('active'));
}

function flushPreviewRender(id, { force = false } = {}) {
    const state = getPreviewRenderState(id);

    if (state.timeoutId) {
        clearTimeout(state.timeoutId);
        state.timeoutId = null;
    }

    state.hasPendingUpdate = false;

    if (!force && !isPreviewPaneActive(id)) {
        return;
    }

    renderMarkdown(id);
    state.lastRenderedAt = Date.now();
}

export function schedulePreviewRender(
    id,
    { source = 'manual', force = false, immediate = false } = {},
) {
    const textarea = document.getElementById(id);
    const preview = document.getElementById(`${id}-preview`);
    if (!textarea || !preview || !window.marked) return;
    if (!force && !isPreviewPaneActive(id)) return;

    const state = getPreviewRenderState(id);
    state.hasPendingUpdate = true;

    if (immediate) {
        flushPreviewRender(id, { force });
        return;
    }

    if (source === 'stream') {
        if (state.timeoutId) return;

        const elapsed = Date.now() - state.lastRenderedAt;
        const delay =
            state.lastRenderedAt === 0
                ? STREAM_PREVIEW_INITIAL_DELAY_MS
                : Math.max(STREAM_PREVIEW_MIN_DELAY_MS, STREAM_PREVIEW_RENDER_INTERVAL_MS - elapsed);

        state.timeoutId = setTimeout(() => {
            state.timeoutId = null;
            if (!state.hasPendingUpdate) return;

            state.hasPendingUpdate = false;
            renderMarkdown(id);
            state.lastRenderedAt = Date.now();
        }, delay);

        return;
    }

    if (state.timeoutId) {
        clearTimeout(state.timeoutId);
    }

    state.timeoutId = setTimeout(() => {
        state.timeoutId = null;
        if (!state.hasPendingUpdate) return;

        state.hasPendingUpdate = false;
        renderMarkdown(id);
        state.lastRenderedAt = Date.now();
    }, MANUAL_PREVIEW_RENDER_DELAY_MS);
}

export function debouncedRenderMarkdown(id) {
    schedulePreviewRender(id, { source: 'manual' });
}
