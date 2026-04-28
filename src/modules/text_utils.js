export function estimateTokenCount(text) {
    if (!text || !text.trim()) return 0;

    const normalized = String(text).replace(/\r\n/g, '\n');
    const hangulSyllables = (normalized.match(/[\uac00-\ud7a3]/g) || []).length;
    const hangulJamo = (normalized.match(/[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]/g) || []).length;
    const kanaChars = (normalized.match(/[\u3040-\u30ff\uff66-\uff9f]/g) || []).length;
    const hanChars = (normalized.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const newlineCount = (normalized.match(/\n/g) || []).length;
    const asciiWordTokens = [...normalized.matchAll(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)]
        .reduce((sum, match) => sum + Math.max(1, match[0].length / 4), 0);

    const otherChars = normalized
        .replace(/[\uac00-\ud7a3]/g, '')
        .replace(/[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]/g, '')
        .replace(/[\u3040-\u30ff\uff66-\uff9f]/g, '')
        .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, '')
        .replace(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g, '')
        .replace(/\s+/g, '')
        .length;

    const cjkChars = hangulSyllables + hangulJamo + kanaChars + hanChars;
    const nonSpaceChars = normalized.replace(/\s+/g, '').length;
    const cjkRatio = nonSpaceChars > 0 ? cjkChars / nonSpaceChars : 0;
    const utf8Bytes = typeof TextEncoder !== 'undefined'
        ? new TextEncoder().encode(normalized).length
        : normalized.length;
    const byteDivisor = cjkRatio >= 0.5 ? 3.55 : cjkRatio >= 0.15 ? 3.65 : 3.8;

    const scriptWeightedTokens =
        hangulSyllables * 0.9
        + hangulJamo
        + kanaChars * 0.9
        + hanChars * 1.1
        + asciiWordTokens
        + otherChars * 0.65
        + newlineCount * 0.45;
    const byteWeightedTokens = utf8Bytes / byteDivisor;

    return Math.max(1, Math.ceil(Math.max(scriptWeightedTokens, byteWeightedTokens)));
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

export function getPartPlan(totalChapters) {
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

export function getChapterDesignInstruction(lang) {
    if (lang === 'Korean') {
        return `In section 5, keep each chapter readable as a story outline first. Every chapter entry must preserve the narrative labels "내용:" and "핵심 포인트:" with concrete story content under them. Add the compact generation-control fields after those labels, not instead of them: chapter_function (primary and optional secondary), start_scene, end_state or end_hook, must_include, must_not_include or not_this_chapter, chapter_keywords, reveal_or_knowledge_step, and intensity scores from 0-10 for external_threat, relationship_drama, mystery, combat, and comedy when relevant. Vary adjacent chapter functions so the outline does not repeat the same conflict engine, accusation loop, rescue shape, power reveal, relationship beat, or ending hook unless it returns with a new consequence.`;
    }
    if (lang === 'Japanese') {
        return `In section 5, keep each chapter readable as a story outline first. Every chapter entry must preserve narrative labels equivalent to "内容:" and "重要ポイント:" with concrete story content under them. Add the compact generation-control fields after those labels, not instead of them: chapter_function (primary and optional secondary), start_scene, end_state or end_hook, must_include, must_not_include or not_this_chapter, chapter_keywords, reveal_or_knowledge_step, and intensity scores from 0-10 for external_threat, relationship_drama, mystery, combat, and comedy when relevant. Vary adjacent chapter functions so the outline does not repeat the same conflict engine, accusation loop, rescue shape, power reveal, relationship beat, or ending hook unless it returns with a new consequence.`;
    }
    return `In section 5, keep each chapter readable as a story outline first. Every chapter entry must preserve the narrative labels "Content:" and "Key Points:" with concrete story content under them. Add the compact generation-control fields after those labels, not instead of them: chapter_function (primary and optional secondary), start_scene, end_state or end_hook, must_include, must_not_include or not_this_chapter, chapter_keywords, reveal_or_knowledge_step, and intensity scores from 0-10 for external_threat, relationship_drama, mystery, combat, and comedy when relevant. Vary adjacent chapter functions so the outline does not repeat the same conflict engine, accusation loop, rescue shape, power reveal, relationship beat, or ending hook unless it returns with a new consequence.`;
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
