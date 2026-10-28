import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildChapterRevisionDiffs, undoNovelRevision } from '../services/novelRevisionService.js';
import type { LoadedNovelRevision } from '../services/novelRevisionStore.js';
import { buildSideBySideDiffRows, type SideBySideDiffRow } from '../utils/textDiff.js';
import type { NovelgenRuntimeActions } from '../types/app.js';

function DiffRow({ before, after, beforeParts, afterParts, beforeChanged, afterChanged }: SideBySideDiffRow) {
    return <tr>
        <td className={`diff-number ${beforeChanged ? 'diff-remove' : ''}`}>{before?.oldLine}</td>
        <td className={beforeChanged ? 'diff-remove' : ''}><span className="diff-sign" aria-hidden="true">{beforeChanged ? '−' : ' '}</span>
            <code>{beforeParts.map((part, i) => part.changed ? <mark className="diff-inline-remove" key={i}>{part.text}</mark> : part.text)}</code></td>
        <td className={`diff-number ${afterChanged ? 'diff-add' : ''}`}>{after?.newLine}</td>
        <td className={afterChanged ? 'diff-add' : ''}><span className="diff-sign" aria-hidden="true">{afterChanged ? '+' : ' '}</span>
            <code>{afterParts.map((part, i) => part.changed ? <mark className="diff-inline-add" key={i}>{part.text}</mark> : part.text)}</code></td>
    </tr>;
}

export default function NovelRefineDiffDialog({ revision, currentText, busy, actions, onClose }: {
    revision: LoadedNovelRevision;
    currentText: string;
    busy: boolean;
    actions: NovelgenRuntimeActions;
    onClose: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [selectedChapter, setSelectedChapter] = useState<number | null>(null);
    const chapters = useMemo(() => buildChapterRevisionDiffs(revision), [revision]);
    const chapter = chapters.find(chapter => chapter.number === selectedChapter) ?? chapters[0];
    const displayHunks = useMemo(() => chapter?.hunks.map(hunk => ({ ...hunk, rows: buildSideBySideDiffRows(hunk.lines) })) || [], [chapter]);
    const blocked = busy || saving || currentText !== revision.after_text;

    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);

    async function undo(target?: { chapter: number; hunkId?: string }) {
        setError(''); setSaving(true);
        try {
            const text = await undoNovelRevision(revision, target);
            actions.onNovelContentChange(text);
            actions.onFindNextChapter();
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
        } finally { setSaving(false); }
    }

    return createPortal(
        <dialog ref={dialog} className="novel-diff-dialog" aria-labelledby="novel-diff-title"
            onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
            <header className="novel-diff-toolbar">
                <div><h2 id="novel-diff-title">Last Refine Diff</h2><p>{revision.filename} · {chapters.length} modified chapter{chapters.length === 1 ? '' : 's'}</p></div>
                <div className="novel-diff-actions">
                    <button type="button" className="btn btn-danger" disabled={blocked || revision.before_text === revision.after_text}
                        onClick={() => void undo()}>Undo all refined chapters</button>
                    <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>Close</button>
                </div>
            </header>
            <div className="novel-diff-chapters" role="group" aria-label="Modified chapters">
                {chapters.map(item => <button key={item.number} type="button" className={`btn ${chapter?.number === item.number ? 'btn-primary' : 'btn-secondary'}`}
                    aria-pressed={chapter?.number === item.number} onClick={() => setSelectedChapter(item.number)}>
                    Chapter {item.number} · {item.hunks.length} change{item.hunks.length === 1 ? '' : 's'}
                </button>)}
            </div>
            {currentText !== revision.after_text && <p className="novel-diff-notice" role="status">The editor has changed since this refinement. You can compare the saved versions; undo is disabled to protect your edits.</p>}
            {busy && !saving && <p className="novel-diff-notice" role="status">Undo is available after the current novel operation finishes.</p>}
            {error && <p className="novel-diff-error" role="alert">{error}</p>}
            <div className="novel-diff-body" aria-busy={saving}>
                {chapter ? <>
                    <div className="novel-diff-chapter-heading"><h3>Chapter {chapter.number}</h3>
                        <button type="button" className="btn btn-secondary" disabled={blocked}
                            onClick={() => void undo({ chapter: chapter.number })}>Undo this chapter</button></div>
                    {displayHunks.map((hunk, index) => <section className="novel-diff-hunk" key={hunk.id} aria-label={`Change ${index + 1}`}>
                        <div className="novel-diff-hunk-header">
                            <code>@@ -{hunk.oldLine},{hunk.oldCount} +{hunk.newLine},{hunk.newCount} @@</code>
                            {!hunk.rows.some(row => row.beforeChanged || row.afterChanged) && <span className="novel-diff-layout-note">Line breaks or trailing whitespace only</span>}
                            <button type="button" className="btn btn-secondary" disabled={blocked}
                                onClick={() => void undo({ chapter: chapter.number, hunkId: hunk.id })}>Undo chunk {index + 1}</button>
                        </div>
                        <table className="novel-diff-table"><colgroup><col className="diff-line-number" /><col /><col className="diff-line-number" /><col /></colgroup>
                            <thead><tr><th colSpan={2} scope="colgroup">Previous version (before refinement)</th><th colSpan={2} scope="colgroup">Latest version</th></tr></thead>
                            <tbody>{hunk.rows.map((row, rowIndex) => <DiffRow key={rowIndex} {...row} />)}</tbody>
                        </table>
                    </section>)}
                </> : <p className="novel-diff-empty">No remaining changes in the refined chapters.</p>}
            </div>
            {saving && <p className="novel-diff-notice" role="status">Saving undo…</p>}
        </dialog>, document.body,
    );
}
