const ALLOWED_TAGS = new Set([
    'a', 'annotation', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'li', 'math', 'mfrac', 'mi', 'mn', 'mo', 'mover', 'mpadded',
    'mroot', 'mrow', 'mspace', 'msqrt', 'mstyle', 'msub', 'msubsup', 'msup', 'mtable',
    'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'ol', 'p', 'pre', 'semantics',
    'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]);

const GLOBAL_ALLOWED_ATTRIBUTES = new Set([
    'aria-hidden', 'aria-label', 'class', 'role',
]);

const TAG_ALLOWED_ATTRIBUTES = {
    a: new Set(['href', 'rel', 'target', 'title']),
    annotation: new Set(['encoding']),
    img: new Set(['alt', 'src', 'title']),
    math: new Set(['display', 'xmlns']),
    span: new Set(['style']),
};

function isSafeClassList(value) {
    return value
        .split(/\s+/)
        .filter(Boolean)
        .every(item => /^[A-Za-z0-9_-]+$/.test(item));
}

function isSafeUrl(value, tagName, attrName) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return false;

    if (trimmed.startsWith('#')) return true;

    let url;
    try {
        url = new URL(trimmed, window.location.href);
    } catch (_) {
        return false;
    }

    if (attrName === 'src' && tagName === 'img') {
        return ['http:', 'https:', 'data:'].includes(url.protocol)
            && (!trimmed.toLowerCase().startsWith('data:') || trimmed.toLowerCase().startsWith('data:image/'));
    }

    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
}

function isKatexElement(element) {
    return Boolean(element.closest?.('.katex, .katex-display'));
}

function sanitizeInlineStyle(value) {
    const style = String(value || '').trim();
    if (!style) return '';
    if (/(?:expression|javascript:|url\s*\(|@import)/i.test(style)) return '';
    return style;
}

function sanitizeAttributes(element) {
    const tagName = element.tagName.toLowerCase();
    const allowedForTag = TAG_ALLOWED_ATTRIBUTES[tagName] || new Set();

    for (const attr of Array.from(element.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value;

        if (name.startsWith('on')) {
            element.removeAttribute(attr.name);
            continue;
        }

        if (name === 'style') {
            if (isKatexElement(element)) {
                const sanitizedStyle = sanitizeInlineStyle(value);
                if (sanitizedStyle) element.setAttribute('style', sanitizedStyle);
                else element.removeAttribute(attr.name);
            } else {
                element.removeAttribute(attr.name);
            }
            continue;
        }

        if (name === 'class' && !isSafeClassList(value)) {
            element.removeAttribute(attr.name);
            continue;
        }

        if (name === 'href' || name === 'src') {
            if (!isSafeUrl(value, tagName, name)) {
                element.removeAttribute(attr.name);
            }
            continue;
        }

        if (!GLOBAL_ALLOWED_ATTRIBUTES.has(name) && !allowedForTag.has(name)) {
            element.removeAttribute(attr.name);
        }
    }

    if (tagName === 'a' && element.hasAttribute('href')) {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
    }
}

function sanitizeNode(node) {
    if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
        return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node;
    const tagName = element.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tagName)) {
        const textNode = document.createTextNode(element.textContent || '');
        element.replaceWith(textNode);
        return;
    }

    sanitizeAttributes(element);

    for (const child of Array.from(element.childNodes)) {
        sanitizeNode(child);
    }
}

function replaceTextNodeWithFragments(textNode, replacements) {
    const text = textNode.nodeValue || '';
    let cursor = 0;
    const fragment = document.createDocumentFragment();
    const pattern = /\uE000BOLD(\d+)\uE001/g;
    let match;

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > cursor) {
            fragment.appendChild(document.createTextNode(text.slice(cursor, match.index)));
        }

        const replacement = replacements[Number(match[1])];
        if (replacement !== undefined) {
            const strong = document.createElement('strong');
            strong.textContent = replacement;
            fragment.appendChild(strong);
        } else {
            fragment.appendChild(document.createTextNode(match[0]));
        }

        cursor = match.index + match[0].length;
    }

    if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    textNode.replaceWith(fragment);
}

function restoreForcedBold(container, replacements) {
    if (!replacements.length) return;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
        if ((walker.currentNode.nodeValue || '').includes('\uE000BOLD')) {
            nodes.push(walker.currentNode);
        }
    }

    for (const node of nodes) {
        replaceTextNodeWithFragments(node, replacements);
    }
}

function renderSanitizedHtml(container, unsafeHtml, { forcedBold = [] } = {}) {
    const template = document.createElement('template');
    template.innerHTML = unsafeHtml;

    for (const child of Array.from(template.content.childNodes)) {
        sanitizeNode(child);
    }

    container.replaceChildren(template.content);
    restoreForcedBold(container, forcedBold);
}

function applyBoldMath(text) {
    return text
        .replace(/(\*\*|__)\$\$([\s\S]+?)\$\$\1/g, (_, marker, body) => {
            return `$$\\boldsymbol{${body}}$$`;
        })
        .replace(/(\*\*|__)\$(?!\$)([\s\S]+?)\$\1/g, (_, marker, body) => {
            return `$\\boldsymbol{${body}}$`;
        });
}

function applyQuotedBoldText(text) {
    const forcedBold = [];
    const transformed = text.replace(
        /(\*\*|__)([“"‘'「『][^\n]+?[”"’'」』])\1(?=[\p{L}\p{N}_])/gu,
        (_, marker, body) => {
            const index = forcedBold.push(body) - 1;
            return `\uE000BOLD${index}\uE001`;
        },
    );

    return { text: transformed, forcedBold };
}

function applySafeLineBreakTags(text) {
    return text.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
}

export function renderMarkdown(id) {
    const textarea = document.getElementById(id);
    const preview = document.getElementById(`${id}-preview`);
    if (textarea && preview && window.marked) {
        let text = applyBoldMath(textarea.value);
        const boldText = applyQuotedBoldText(text);
        text = boldText.text;

        const processedText = text.replace(/~/g, '\\~');
        const renderedHtml = applySafeLineBreakTags(window.marked.parse(processedText));
        renderSanitizedHtml(preview, renderedHtml, {
            forcedBold: boldText.forcedBold,
        });
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
