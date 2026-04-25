export function estimateTokenCount(text) {
    if (!text || !text.trim()) return 0;

    const cjkChars = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3]/g) || []).length;
    const asciiWords = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
    const otherChars = text
        .replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3]/g, '')
        .replace(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g, '')
        .replace(/\s+/g, '')
        .length;

    return Math.max(1, Math.ceil(cjkChars * 0.6 + asciiWords * 1.25 + otherChars * 0.25));
}

export function formatCompactNumber(value) {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 10000) return `${Math.round(value / 1000)}k`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return String(value);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function getPartPlan(totalChapters) {
    const total = Math.max(1, parseInt(totalChapters, 10) || 1);
    if (total <= 5) {
        return [{ part: 1, start: 1, end: total }];
    }

    const minPartsForMaxSize = Math.ceil(total / 8);
    const maxPartsForMinSize = Math.floor(total / 3);
    const preferredParts = Math.ceil(total / 5);
    const partCount = clamp(preferredParts, minPartsForMaxSize, maxPartsForMinSize);
    const baseSize = Math.floor(total / partCount);
    let remainder = total % partCount;
    let start = 1;

    return Array.from({ length: partCount }, (_, index) => {
        const size = baseSize + (remainder > 0 ? 1 : 0);
        remainder -= 1;
        const end = start + size - 1;
        const part = { part: index + 1, start, end };
        start = end + 1;
        return part;
    });
}

function formatPartPlan(plan, lang) {
    return plan
        .map(({ part, start, end }) => {
            if (lang === 'Korean') return `제 ${part}부 = 제 ${start}장~제 ${end}장`;
            if (lang === 'Japanese') return `第 ${part} 部 = 第 ${start} 章~第 ${end} 章`;
            return `Part ${part} = Chapter ${start}~Chapter ${end}`;
        })
        .join('; ');
}

export function getPlotArcInstruction(lang, totalChapters = 0) {
    const total = Math.max(1, parseInt(totalChapters, 10) || 1);
    const plan = getPartPlan(total);
    const partPlanText = formatPartPlan(plan, lang);
    const partCount = plan.length;

    if (lang === 'Korean') {
        return `In section 5, separate story parts (부) and chapters (장) as different hierarchy levels. Use exactly ${partCount} part heading(s) for this ${total}-chapter outline, with this chapter coverage: ${partPlanText}. Each part heading must appear once, in ascending order, immediately before its first assigned chapter. Under each part, list only the chapters assigned to that part, and list every chapter marker in ascending order from 제 1장 through 제 ${total}장 exactly once across the whole section. Never make part numbers advance one-for-one with chapter numbers, never skip a part number, and never write a part heading without the chapters assigned to it. For total chapters 1-5, use only 제 1부 because a part must be a large unit of at least 3 chapters whenever multiple parts are possible.`;
    }
    if (lang === 'Japanese') {
        return `In section 5, separate story parts (部) and chapters (章) as different hierarchy levels. Use exactly ${partCount} part heading(s) for this ${total}-chapter outline, with this chapter coverage: ${partPlanText}. Each part heading must appear once, in ascending order, immediately before its first assigned chapter. Under each part, list only the chapters assigned to that part, and list every chapter marker in ascending order from 第 1 章 through 第 ${total} 章 exactly once across the whole section. Never make part numbers advance one-for-one with chapter numbers, never skip a part number, and never write a part heading without the chapters assigned to it. For total chapters 1-5, use only 第 1 部 because a part must be a large unit of at least 3 chapters whenever multiple parts are possible.`;
    }
    return `In section 5, separate story parts and chapters as different hierarchy levels. Use exactly ${partCount} part heading(s) for this ${total}-chapter outline, with this chapter coverage: ${partPlanText}. Each part heading must appear once, in ascending order, immediately before its first assigned chapter. Under each part, list only the chapters assigned to that part, and list every chapter marker in ascending order from Chapter 1 through Chapter ${total} exactly once across the whole section. Never make part numbers advance one-for-one with chapter numbers, never skip a part number, and never write a part heading without the chapters assigned to it. For total chapters 1-5, use only Part 1 because a part must be a large unit of at least 3 chapters whenever multiple parts are possible.`;
}

const SUPPORTED_TEXT_FILE_EXTENSIONS = ['.txt', '.md'];

export function isSupportedTextFile(file) {
    const name = file?.name?.toLowerCase();
    return Boolean(name && SUPPORTED_TEXT_FILE_EXTENSIONS.some(extension => name.endsWith(extension)));
}

export function eventHasFiles(event) {
    const types = event.dataTransfer?.types;
    if (types) {
        if (typeof types.includes === 'function' && types.includes('Files')) return true;
        if (typeof types.contains === 'function' && types.contains('Files')) return true;
    }

    if (event.dataTransfer?.files?.length) return true;
    return Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file');
}

export function getDroppedFile(event) {
    if (event.dataTransfer?.files?.length) {
        return event.dataTransfer.files[0];
    }

    const fileItem = Array.from(event.dataTransfer?.items || []).find(item => item.kind === 'file');
    return fileItem?.getAsFile() || null;
}

export function readTextFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
        reader.readAsText(file);
    });
}

export async function fetchTextAsset(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Failed to load ${path}: ${response.status}`);
    }
    return response.text();
}

export function parseSystemPresetIndex(text) {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
            const [name, file, marker] = line.split('|').map(part => part?.trim() || '');
            return { name, file, isDefault: marker?.toLowerCase() === 'default' };
        })
        .filter(item => item.name && item.file);
}

export function splitPlotIntoChapters(plotText) {
    const pattern = /(?:Chapter\s*(\d+)|제?\s*(\d+)\s*장|第?\s*(\d+)\s*章)/gi;
    const matches = [...plotText.matchAll(pattern)];
    const map = {};
    for (let i = 0; i < matches.length; i++) {
        const num = parseInt(matches[i][1] || matches[i][2] || matches[i][3]);
        const start = matches[i].index + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : plotText.length;
        map[num] = plotText.slice(start, end).trim();
    }
    return map;
}

export function splitFullTextIntoChapters(text, lang) {
    let pattern;
    if (lang === "Korean") pattern = /(?:^|\n)[#\s*]*제?\s*(\d+)\s*[장]/gi;
    else if (lang === "Japanese") pattern = /(?:^|\n)[#\s*]*第?\s*(\d+)\s*[장章]/gi;
    else pattern = /(?:^|\n)[#\s*]*Chapter\s*(\d+)/gi;

    const matches = [...text.matchAll(pattern)];
    const chapters = {};
    for (let i = 0; i < matches.length; i++) {
        const chNum = parseInt(matches[i][1]);
        const start = matches[i].index + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        chapters[chNum] = text.slice(start, end).trim();
    }
    return chapters;
}

export function getCleanedInitialText(novelText, lang, nextCh) {
    let pattern;
    if (lang === "Korean") pattern = /(?:^|\n)[#\s*]*제?\s*(\d+)\s*[장]/gi;
    else if (lang === "Japanese") pattern = /(?:^|\n)[#\s*]*第?\s*(\d+)\s*[장章]/gi;
    else pattern = /(?:^|\n)[#\s*]*Chapter\s*(\d+)/gi;

    const matches = [...novelText.matchAll(pattern)];
    for (let i = matches.length - 1; i >= 0; i--) {
        const chNum = parseInt(matches[i][1]);
        if (chNum === nextCh) {
            return novelText.slice(0, matches[i].index).trim();
        }
    }
    return novelText;
}
