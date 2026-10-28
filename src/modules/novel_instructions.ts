export const MAX_NOVEL_AUTO_INSTRUCTION_CHAPTERS = 5;

export function formatChapterRefineInstructions(entries: { number: number; instructions: string }[]) {
    return entries.map(entry => `## Chapter ${entry.number}\n${entry.instructions.trim()}`).join('\n\n');
}

export function parseChapterRefineInstructions(text: string) {
    const chapters = new Map<number, string>();
    const common: string[] = [];
    let current: number | null = null;
    for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
        const heading = line.trim().match(/^#{1,6}\s+(?:Chapter\s+([0-9０-９]+)|(?:제\s*)?([0-9０-９]+)\s*장|第\s*([0-9０-９]+)\s*章)\s*$/i);
        if (heading) {
            current = Number((heading[1] || heading[2] || heading[3]).replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)));
            if (!chapters.has(current)) chapters.set(current, '');
        } else if (current === null) common.push(line);
        else chapters.set(current, `${chapters.get(current)}\n${line}`);
    }
    return { common: common.join('\n').trim(), chapters };
}

export function instructionsForChapter(parsed: ReturnType<typeof parseChapterRefineInstructions>, number: number) {
    if (!parsed.chapters.size) return parsed.common;
    const local = parsed.chapters.get(number)?.trim();
    // An unreviewed chapter must never receive another chapter's corrections.
    if (!local || local === 'NO_CHANGES') return parsed.common || 'NO_CHANGES';
    return [parsed.common, local].filter(Boolean).join('\n\n');
}
