import { getNovelChapterHeadings, splitNovelIntoChapterBlocks } from '../modules/novel_refine.js';
import { invoke } from '../modules/tauri_api.js';
import { buildTextDiff, revertDiffHunk } from '../utils/textDiff.js';
import { getEditorSnapshot, setNovelStatus, setNovelText } from './runtimeEditorStateService.js';
import { novelRevisionStore, type LoadedNovelRevision } from './novelRevisionStore.js';
import { runtimeSessionState } from './runtimeSessionStateService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';

function originalOffsetMapper(text: string) {
    const lineBreaks = [...text.matchAll(/\r\n/g)].map((match, index) => match.index - index);
    // The chapter parser normalizes CRLF. Convert its UTF-16 offsets back to the
    // original manuscript so a partial undo preserves every unrelated byte.
    return (offset: number) => {
        let low = 0, high = lineBreaks.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (lineBreaks[mid] < offset) low = mid + 1; else high = mid;
        }
        return offset + low;
    };
}

function chapterBodyRanges(text: string, language: string) {
    const normalized = text.replace(/\r\n/g, '\n');
    const headings = getNovelChapterHeadings(normalized, language);
    const indexes = new Map<number, number>();
    headings.forEach((heading, index) => indexes.set(heading.number, indexes.has(heading.number) ? -1 : index));
    const rawOffset = originalOffsetMapper(text);
    const ranges = new Map<number, { start: number; end: number; text: string }>();
    for (const chapter of splitNovelIntoChapterBlocks(normalized, language).chapters) {
        const index = indexes.get(chapter.number);
        if (index === -1 || !chapter.body) continue;
        if (index === undefined && !(chapter.number === 1 && !headings.length)) continue;
        const from = index === undefined ? 0 : headings[index].index + headings[index].length;
        const until = index === undefined ? normalized.length : headings[index + 1]?.index ?? normalized.length;
        const start = normalized.indexOf(chapter.body, from);
        if (start < from || start + chapter.body.length > until) continue;
        const rawStart = rawOffset(start), rawEnd = rawOffset(start + chapter.body.length);
        ranges.set(chapter.number, { start: rawStart, end: rawEnd, text: text.slice(rawStart, rawEnd) });
    }
    return ranges;
}

export function buildChapterRevisionDiffs(revision: LoadedNovelRevision) {
    const beforeRanges = chapterBodyRanges(revision.before_text, revision.language);
    const afterRanges = chapterBodyRanges(revision.after_text, revision.language);
    return [...new Set(revision.chapter_numbers)].flatMap(number => {
        const before = beforeRanges.get(number);
        const after = afterRanges.get(number);
        if (!before || !after) return [];
        const oldOffset = originalOffsetMapper(before.text), newOffset = originalOffsetMapper(after.text);
        const hunks = buildTextDiff(before.text.replace(/\r\n/g, '\n'), after.text.replace(/\r\n/g, '\n')).map(hunk => ({
            ...hunk, oldStart: oldOffset(hunk.oldStart), oldEnd: oldOffset(hunk.oldEnd),
            newStart: newOffset(hunk.newStart), newEnd: newOffset(hunk.newEnd),
        }));
        return hunks.length ? [{ number, before, after, hunks }] : [];
    });
}

export async function undoNovelRevision(revision: LoadedNovelRevision, target?: { chapter: number; hunkId?: string }) {
    const assertCurrent = () => {
        if (novelRevisionStore.getSnapshot() !== revision
            || runtimeSessionState.loadedNovelFilename !== revision.filename
            || getEditorSnapshot().novel !== revision.after_text) {
            throw new Error('The novel changed after this refinement. Undo is disabled to protect your current edits.');
        }
    };
    assertCurrent();
    if (runtimeSessionState.isWorkerRunning || runtimeSessionState.isNovelRefining
        || runtimeViewStateStore.getSnapshot().activity.isNovelRunning) {
        throw new Error('Wait for the current novel operation to finish before undoing.');
    }
    let nextText = revision.before_text;
    if (target) {
        const chapter = buildChapterRevisionDiffs(revision).find(chapter => chapter.number === target.chapter);
        if (!chapter) throw new Error('This chapter no longer has changes to undo.');
        let replacement = chapter.before.text;
        if (target.hunkId) {
            const hunk = chapter.hunks.find(hunk => hunk.id === target.hunkId);
            if (!hunk) throw new Error('This change is no longer available. Reopen the diff.');
            replacement = revertDiffHunk(chapter.before.text, chapter.after.text, hunk);
        }
        nextText = revision.after_text.slice(0, chapter.after.start) + replacement + revision.after_text.slice(chapter.after.end);
    }
    runtimeSessionState.isNovelRefining = true;
    runtimeViewStateStore.setActivity({ isNovelRunning: true });
    try {
        const [diskText] = await invoke<[string, string]>('load_novel', { filename: revision.filename });
        assertCurrent();
        if (diskText !== revision.after_text) throw new Error('The saved novel changed outside this view. Reload it before undoing.');
        const metadata = await invoke('save_novel_state', {
            filename: revision.filename, textContent: nextText,
            metadataJson: JSON.stringify({
                ...runtimeSessionState.loadedNovelMetadata,
                last_refinement: { ...revision, filename: undefined, after_text: nextText },
            }),
        });
        // A delayed save must never replace a newer editor buffer or another file.
        if (runtimeSessionState.loadedNovelFilename !== revision.filename || getEditorSnapshot().novel !== revision.after_text) {
            throw new Error('Undo was saved, but the editor changed while saving. Your current editor text has been kept.');
        }
        setNovelText(nextText);
        runtimeSessionState.setLoadedNovel(revision.filename, metadata);
        setNovelStatus('Refinement changes undone and saved.', 'completed');
        return nextText;
    } finally {
        runtimeSessionState.isNovelRefining = false;
        runtimeViewStateStore.setActivity({ isNovelRunning: false });
    }
}
