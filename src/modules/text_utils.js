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

export function getPlotArcInstruction(lang) {
    if (lang === 'Korean') {
        return "In section 5, divide the chapter list into explicit story-part headings such as '제 1부: 발단', '제 2부: 전환' before the relevant chapter entries. Keep clear chapter markers like '제 1장'. For long outlines, no part should cover more than about 8 chapters.";
    }
    if (lang === 'Japanese') {
        return "In section 5, divide the chapter list into explicit story-part headings such as '第 1 部：発端', '第 2 部：転換' before the relevant chapter entries. Keep clear chapter markers like '第 1 章'. For long outlines, no part should cover more than about 8 chapters.";
    }
    return "In section 5, divide the chapter list into explicit story-part headings such as 'Part 1: Setup' and 'Part 2: Turn' before the relevant chapter entries. Keep clear chapter markers like 'Chapter 1'. For long outlines, no part should cover more than about 8 chapters.";
}

export function isTxtFile(file) {
    return Boolean(file?.name?.toLowerCase().endsWith('.txt'));
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
