export type DiffKind = 'equal' | 'remove' | 'add';
export interface DiffLine { kind: DiffKind; text: string; oldLine: number | null; newLine: number | null }
export interface DiffHunk {
    id: string;
    oldStart: number; oldEnd: number; newStart: number; newEnd: number;
    oldLine: number; newLine: number; oldCount: number; newCount: number;
    lines: DiffLine[];
}
type Edit = { kind: DiffKind; text: string };
const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) || [];

// Unique-line anchors keep long novels cheap; bounded LCS resolves repeated prose
// between anchors. Very large unmatched regions become one reversible replacement.
function edits(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, out: Edit[], depth = 0) {
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
        out.push({ kind: 'equal', text: a[a0++] }); b0++;
    }
    let suffix = 0;
    while (a0 < a1 - suffix && b0 < b1 - suffix && a[a1 - suffix - 1] === b[b1 - suffix - 1]) suffix++;
    const ae = a1 - suffix, be = b1 - suffix;
    if (a0 === ae || b0 === be) {
        for (let i = a0; i < ae; i++) out.push({ kind: 'remove', text: a[i] });
        for (let i = b0; i < be; i++) out.push({ kind: 'add', text: b[i] });
    } else if ((ae - a0) * (be - b0) <= 250000) {
        const width = be - b0 + 1;
        const matrix = new Uint32Array((ae - a0 + 1) * width);
        for (let i = ae - 1; i >= a0; i--) for (let j = be - 1; j >= b0; j--) {
            const offset = (i - a0) * width + j - b0;
            matrix[offset] = a[i] === b[j] ? matrix[offset + width + 1] + 1
                : Math.max(matrix[offset + width], matrix[offset + 1]);
        }
        let i = a0, j = b0;
        while (i < ae || j < be) {
            const offset = (i - a0) * width + j - b0;
            if (i < ae && j < be && a[i] === b[j]) {
                out.push({ kind: 'equal', text: a[i++] }); j++;
            } else if (i < ae && (j === be || matrix[offset + width] >= matrix[offset + 1])) {
                out.push({ kind: 'remove', text: a[i++] });
            } else out.push({ kind: 'add', text: b[j++] });
        }
    } else {
        const unique = (lines: string[], from: number, to: number) => {
            const map = new Map<string, number>();
            for (let i = from; i < to; i++) map.set(lines[i], map.has(lines[i]) ? -1 : i);
            return map;
        };
        const left = unique(a, a0, ae), right = unique(b, b0, be);
        const pairs: [number, number][] = [];
        left.forEach((i, line) => {
            const j = right.get(line);
            if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]);
        });
        const tails: number[] = [], previous = new Int32Array(pairs.length).fill(-1);
        pairs.forEach((pair, index) => {
            let low = 0, high = tails.length;
            while (low < high) {
                const mid = (low + high) >>> 1;
                if (pairs[tails[mid]][1] < pair[1]) low = mid + 1; else high = mid;
            }
            if (low) previous[index] = tails[low - 1];
            tails[low] = index;
        });
        const anchors: [number, number][] = [];
        for (let k = tails.at(-1) ?? -1; k >= 0; k = previous[k]) anchors.push(pairs[k]);
        if (anchors.length && depth < 64) {
            let i = a0, j = b0;
            for (const [ai, bi] of anchors.reverse()) {
                edits(a, b, i, ai, j, bi, out, depth + 1);
                out.push({ kind: 'equal', text: a[ai] }); i = ai + 1; j = bi + 1;
            }
            edits(a, b, i, ae, j, be, out, depth + 1);
        } else {
            for (let i = a0; i < ae; i++) out.push({ kind: 'remove', text: a[i] });
            for (let i = b0; i < be; i++) out.push({ kind: 'add', text: b[i] });
        }
    }
    for (let i = a1 - suffix; i < a1; i++) out.push({ kind: 'equal', text: a[i] });
}

export function buildTextDiff(before: string, after: string): DiffHunk[] {
    if (before === after) return [];
    const operations: Edit[] = [];
    const left = splitLines(before), right = splitLines(after);
    edits(left, right, 0, left.length, 0, right.length, operations);
    const oldOffsets = [0], newOffsets = [0], oldNumbers = [1], newNumbers = [1];
    const lines: DiffLine[] = operations.map(op => {
        const oldLine = oldNumbers.at(-1)!, newLine = newNumbers.at(-1)!;
        oldOffsets.push(oldOffsets.at(-1)! + (op.kind === 'add' ? 0 : op.text.length));
        newOffsets.push(newOffsets.at(-1)! + (op.kind === 'remove' ? 0 : op.text.length));
        oldNumbers.push(oldLine + (op.kind === 'add' ? 0 : 1));
        newNumbers.push(newLine + (op.kind === 'remove' ? 0 : 1));
        return { ...op, oldLine: op.kind === 'add' ? null : oldLine, newLine: op.kind === 'remove' ? null : newLine };
    });
    const changes = operations.flatMap((op, i) => op.kind === 'equal' ? [] : [i]);
    const hunks: DiffHunk[] = [];
    for (let i = 0; i < changes.length;) {
        const first = changes[i];
        let last = first;
        while (++i < changes.length && changes[i] - last <= 7) last = changes[i];
        const end = last + 1, displayStart = Math.max(0, first - 3), displayEnd = Math.min(lines.length, end + 3);
        hunks.push({
            id: `${oldOffsets[first]}:${oldOffsets[end]}:${newOffsets[first]}:${newOffsets[end]}`,
            oldStart: oldOffsets[first], oldEnd: oldOffsets[end], newStart: newOffsets[first], newEnd: newOffsets[end],
            oldLine: oldNumbers[displayStart], newLine: newNumbers[displayStart],
            oldCount: oldNumbers[displayEnd] - oldNumbers[displayStart], newCount: newNumbers[displayEnd] - newNumbers[displayStart],
            lines: lines.slice(displayStart, displayEnd),
        });
    }
    return hunks;
}

export function revertDiffHunk(before: string, after: string, hunk: DiffHunk): string {
    return after.slice(0, hunk.newStart) + before.slice(hunk.oldStart, hunk.oldEnd) + after.slice(hunk.newEnd);
}

export interface InlineDiffPart { text: string; changed: boolean }

export function buildInlineDiff(before: string, after: string, ignoreLineBreakChanges = false): { before: InlineDiffPart[]; after: InlineDiffPart[] } {
    const visibleContent = (text: string) => text.replace(/[\t ]+(?=\r?\n|$)/g, '').replace(/[\r\n]/g, '');
    if (ignoreLineBreakChanges && visibleContent(before) === visibleContent(after)) {
        return { before: [{ text: before, changed: false }], after: [{ text: after, changed: false }] };
    }
    const left = Array.from(before), right = Array.from(after), operations: Edit[] = [];
    // Code points keep emoji intact. Bound the work for exceptionally long lines;
    // word anchors retain useful precision without an unbounded character matrix.
    if (left.length * right.length <= 250000) {
        edits(left, right, 0, left.length, 0, right.length, operations);
    } else {
        const words = (text: string) => text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
        const a = words(before), b = words(after);
        edits(a, b, 0, a.length, 0, b.length, operations);
    }
    const result: { before: InlineDiffPart[]; after: InlineDiffPart[] } = { before: [], after: [] };
    const append = (parts: InlineDiffPart[], text: string, changed: boolean) => {
        const last = parts.at(-1);
        if (last?.changed === changed) last.text += text; else parts.push({ text, changed });
    };
    for (let i = 0; i < operations.length;) {
        if (operations[i].kind === 'equal') {
            append(result.before, operations[i].text, false);
            append(result.after, operations[i++].text, false);
            continue;
        }
        const start = i;
        let removed = '', added = '';
        while (i < operations.length && operations[i].kind !== 'equal') {
            const op = operations[i++];
            if (op.kind === 'remove') removed += op.text; else added += op.text;
        }
        // A wrapped sentence is still the same sentence. Only suppress whitespace
        // edits involving a line break, not meaningful word-space changes.
        const layoutOnly = ignoreLineBreakChanges && /[\r\n]/.test(removed + added)
            && /^\s*$/.test(removed) && /^\s*$/.test(added);
        for (let j = start; j < i; j++) {
            const op = operations[j];
            if (op.kind === 'remove') append(result.before, op.text, !layoutOnly);
            else append(result.after, op.text, !layoutOnly);
        }
    }
    return result;
}

export interface SideBySideDiffRow {
    before?: DiffLine; after?: DiffLine;
    beforeParts: InlineDiffPart[]; afterParts: InlineDiffPart[];
    beforeChanged: boolean; afterChanged: boolean;
}

function partsByLine(lines: DiffLine[], parts: InlineDiffPart[]) {
    let lineStart = 0, partIndex = 0, partStart = 0;
    return lines.map(line => {
        const visibleEnd = lineStart + line.text.replace(/[\t \r\n]+$/, '').length;
        while (partIndex < parts.length && partStart + parts[partIndex].text.length <= lineStart) {
            partStart += parts[partIndex++].text.length;
        }
        const visible: InlineDiffPart[] = [];
        let index = partIndex, offset = partStart;
        while (index < parts.length && offset < visibleEnd) {
            const part = parts[index++], end = offset + part.text.length;
            const text = part.text.slice(Math.max(0, lineStart - offset), Math.min(part.text.length, visibleEnd - offset));
            if (text) visible.push({ text, changed: part.changed });
            offset = end;
        }
        lineStart += line.text.length;
        return { line, parts: visible, changed: visible.some(part => part.changed) };
    });
}

export function buildSideBySideDiffRows(lines: DiffLine[]): SideBySideDiffRow[] {
    const rows: SideBySideDiffRow[] = [];
    for (let i = 0; i < lines.length;) {
        if (lines[i].kind === 'equal') {
            const line = lines[i++], parts = [{ text: line.text.replace(/[\t \r\n]+$/, ''), changed: false }];
            rows.push({ before: line, after: line, beforeParts: parts, afterParts: parts, beforeChanged: false, afterChanged: false });
            continue;
        }
        const removed: DiffLine[] = [], added: DiffLine[] = [];
        while (i < lines.length && lines[i].kind !== 'equal') {
            (lines[i].kind === 'remove' ? removed : added).push(lines[i++]);
        }
        // Align text across the entire edit block before projecting highlights
        // onto display rows. Positional line pairs mislabel split/joined prose.
        const inline = buildInlineDiff(removed.map(line => line.text).join(''), added.map(line => line.text).join(''), true);
        const before = partsByLine(removed, inline.before), after = partsByLine(added, inline.after);
        for (let j = 0; j < Math.max(before.length, after.length); j++) {
            rows.push({ before: before[j]?.line, after: after[j]?.line,
                beforeParts: before[j]?.parts || [], afterParts: after[j]?.parts || [],
                beforeChanged: before[j]?.changed || false, afterChanged: after[j]?.changed || false });
        }
    }
    return rows;
}

