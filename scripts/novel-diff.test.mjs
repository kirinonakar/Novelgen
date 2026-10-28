import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { transformWithOxc } from 'vite';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

async function harness() {
    const editor = { novel: '' }, activity = { isNovelRunning: false }, calls = [];
    let diskText = '', failSave = false;
    const context = createContext({ console, setTimeout, clearTimeout, TextEncoder });
    const stubs = {
        'services/runtimeEditorStateService.ts': { getEditorSnapshot: () => editor,
            setNovelText: text => { editor.novel = text; }, setNovelStatus() {}, clearNovelRefineChapterRangeState() {}, setNovelRefineChapterRange() {} },
        'services/runtimeViewStateStore.ts': { runtimeViewStateStore: {
            getSnapshot: () => ({ activity }), setActivity: update => Object.assign(activity, update),
        } },
        'services/generationParamsService.ts': { getTotalChaptersParam: () => 3, getTargetTokensParam: () => 1000 },
        'modules/novel_auto.ts': { generateInstructionForChapter() {} },
        'modules/toast.ts': { showToast() {} },
        'modules/tauri_api.ts': { Channel: class {}, invoke: async (command, args) => {
            calls.push({ command, args });
            if (command === 'load_novel') return [diskText, '{}'];
            assert.equal(command, 'save_novel_state');
            if (failSave) throw new Error('Disk full');
            diskText = args.textContent;
            const metadata = JSON.parse(args.metadataJson);
            // Verify that the backend's adjusted memory is adopted after undo.
            return { ...metadata, needs_memory_rebuild: true, memory_rebuild_from_chapter: 2 };
        } },
    };
    const modules = new Map();
    const pending = new Map();
    function load(path) {
        if (!pending.has(path)) pending.set(path, loadModule(path));
        return pending.get(path);
    }
    async function loadModule(path) {
        if (modules.has(path)) return modules.get(path);
        if (stubs[path]) {
            const values = stubs[path];
            const module = new SyntheticModule(Object.keys(values), function () {
                for (const [key, value] of Object.entries(values)) this.setExport(key, value);
            }, { context });
            modules.set(path, module); return module;
        }
        const source = (await transformWithOxc(await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8'), path, { target: 'es2022' })).code;
        const module = new SourceTextModule(source, { context });
        modules.set(path, module);
        await module.link(specifier => load(posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.js$/, '.ts')));
        return module;
    }
    const service = await load('services/novelRevisionService.ts'); await service.evaluate();
    const diff = modules.get('utils/textDiff.ts').namespace;
    const store = modules.get('services/novelRevisionStore.ts').namespace.novelRevisionStore;
    const session = modules.get('services/runtimeSessionStateService.ts').namespace.runtimeSessionState;
    return { ...service.namespace, ...diff, store, session, editor, calls, activity,
        setDisk: value => { diskText = value; }, failSave: () => { failSave = true; },
        load(before, after, chapterNumbers = [2], language = 'English') {
            editor.novel = diskText = after;
            session.setLoadedNovel('novel_test.txt', { story_state: 'saved memory', last_refinement: {
                before_text: before, after_text: after, language, chapter_numbers: chapterNumbers,
            } });
            return store.getSnapshot();
        },
    };
}

const chapter = (number, body) => `### Chapter ${number}\n\n${body}\n\n`;
const contextLines = Array.from({ length: 10 }, (_, i) => `Unchanged line ${i}.`).join('\n');
const beforeBody = `Old opening.\n${contextLines}\nOld ending.`;
const afterBody = `New opening.\n${contextLines}\nNew ending.`;
const before = chapter(1, 'Keep the first chapter.') + chapter(2, beforeBody) + chapter(3, 'Keep the third chapter.');
const after = chapter(1, 'Keep the first chapter.') + chapter(2, afterBody) + chapter(3, 'Keep the third chapter.');

test('only modified chapter bodies are compared and their distant changes form separate chunks', async () => {
    const api = await harness();
    const revision = api.load(before, after);
    const chapters = api.buildChapterRevisionDiffs(revision);
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].number, 2);
    assert.equal(chapters[0].hunks.length, 2);
    assert.equal(chapters[0].before.text, beforeBody);
    assert.equal(chapters[0].after.text, afterBody);
    assert.ok(chapters[0].hunks.every(hunk => hunk.lines.every(line => !line.text.includes('first chapter') && !line.text.includes('third chapter'))));
});

test('chunk undo changes only that chunk, persists JSON history separately, and adopts rebuilt memory metadata', async () => {
    const api = await harness(); const revision = api.load(before, after);
    const hunk = api.buildChapterRevisionDiffs(revision)[0].hunks[0];
    const result = await api.undoNovelRevision(revision, { chapter: 2, hunkId: hunk.id });
    assert.equal(result, after.replace('New opening.', 'Old opening.'));
    assert.equal(api.editor.novel, result);
    assert.ok(result.includes('New ending.'));
    const save = api.calls.find(call => call.command === 'save_novel_state').args;
    const metadata = JSON.parse(save.metadataJson);
    assert.equal(save.textContent, result);
    assert.equal(metadata.last_refinement.before_text, before);
    assert.equal(metadata.last_refinement.after_text, result);
    assert.doesNotMatch(save.textContent, /before_text|after_text|chapter_numbers|last_refinement/);
    assert.equal(api.session.loadedNovelMetadata.memory_rebuild_from_chapter, 2);
    assert.equal(api.buildChapterRevisionDiffs(api.store.getSnapshot())[0].hunks.length, 1);
    assert.equal(api.activity.isNovelRunning, false);
});

test('whole-chapter undo keeps other refined chapters, and undo-all restores the exact original text', async () => {
    const api = await harness();
    const multiAfter = after.replace('Keep the third chapter.', 'Revised third chapter.');
    let revision = api.load(before, multiAfter, [2, 3]);
    const result = await api.undoNovelRevision(revision, { chapter: 2 });
    assert.equal(result, before.replace('Keep the third chapter.', 'Revised third chapter.'));
    revision = api.store.getSnapshot();
    assert.equal(api.buildChapterRevisionDiffs(revision)[0].number, 3);
    assert.equal(await api.undoNovelRevision(revision), before);
    assert.equal(api.buildChapterRevisionDiffs(api.store.getSnapshot()).length, 0);
});

test('stale snapshots, newer editor text, other files, external edits, and active jobs cannot be overwritten', async () => {
    const api = await harness(); let revision = api.load(before, after);
    api.editor.novel += 'Manual edit';
    await assert.rejects(api.undoNovelRevision(revision), /current edits/);
    revision = api.load(before, after); api.setDisk(after + 'External edit');
    await assert.rejects(api.undoNovelRevision(revision), /outside this view/);
    revision = api.load(before, after); api.session.isWorkerRunning = true;
    await assert.rejects(api.undoNovelRevision(revision), /operation to finish/);
    api.session.isWorkerRunning = false;
    api.session.setLoadedNovel('other.txt', null);
    await assert.rejects(api.undoNovelRevision(revision), /current edits/);
    assert.equal(api.calls.filter(call => call.command === 'save_novel_state').length, 0);
    assert.equal(api.store.getSnapshot(), null);
});

test('save failures retain the editor and revision and release the busy state', async () => {
    const api = await harness(); const revision = api.load(before, after); api.failSave();
    await assert.rejects(api.undoNovelRevision(revision), /Disk full/);
    assert.equal(api.editor.novel, after);
    assert.equal(api.store.getSnapshot(), revision);
    assert.equal(api.activity.isNovelRunning, false);
    assert.equal(api.session.isNovelRefining, false);
});

test('CRLF, Unicode, no-final-newline, and headerless chapter bodies retain exact undo offsets', async () => {
    const api = await harness();
    for (const [old, next, language, number] of [
        ['제 1장\r\n\r\n한글 😀 그대로.\r\n제 2장\r\n\r\n이전 본문.\r\n\r\n제 3장\r\n그대로.', '제 1장\r\n\r\n한글 😀 그대로.\r\n제 2장\r\n\r\n최신 본문.\r\n\r\n제 3장\r\n그대로.', 'Korean', 2],
        ['第 1 章\n以前の本文。', '第 1 章\n新しい本文。', 'Japanese', 1],
        ['Original 😀 body.', 'Revised 😀 body.', 'English', 1],
    ]) {
        const revision = api.load(old, next, [number], language);
        const item = api.buildChapterRevisionDiffs(revision)[0];
        assert.equal(item.number, number);
        assert.equal(await api.undoNovelRevision(revision, { chapter: number, hunkId: item.hunks[0].id }), old);
    }
});

test('CRLF normalization does not make unchanged lines look edited and chunk undo retains exact raw offsets', async () => {
    const api = await harness();
    const original = before.replace(/\n/g, '\r\n');
    const revision = api.load(original, after);
    const item = api.buildChapterRevisionDiffs(revision)[0];
    assert.equal(item.hunks.length, 2);
    assert.ok(item.hunks[0].lines.some(line => line.kind === 'equal'));
    const result = await api.undoNovelRevision(revision, { chapter: 2, hunkId: item.hunks[0].id });
    assert.equal(result, after.replace('New opening.\n', 'Old opening.\r\n'));
});

test('line diff round-trips insertions, deletions, repeated lines, large edits, and random manuscripts', async () => {
    const api = await harness();
    let seed = 23456;
    const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    const cases = [['', 'Inserted\n'], ['Deleted\n', ''], ['a\na\nb', 'a\nb\na'], ['a', 'a\n'], ['😀\r\n한글', '😀\r\n수정']];
    const long = Array.from({ length: 3000 }, (_, i) => `Unique line ${i}\n`).join('');
    cases.push([long, long.replace('line 10\n', 'line 10 changed\n').replace('line 2900\n', 'line 2900 changed\n')]);
    cases.push(['old\n'.repeat(600), 'new\n'.repeat(600)]);
    for (let i = 0; i < 300; i++) {
        const make = () => Array.from({ length: random(25) }, () => `Line ${random(8)}${random(2) ? '\n' : ''}`).join('');
        cases.push([make(), make()]);
    }
    for (const [old, next] of cases) {
        const hunks = api.buildTextDiff(old, next);
        let restored = next;
        for (const hunk of [...hunks].reverse()) restored = api.revertDiffHunk(old, restored, hunk);
        assert.equal(restored, old);
    }
});

test('revision loading keeps a stable snapshot and clearing a novel removes its comparison', async () => {
    const api = await harness(); const revision = api.load(before, after);
    api.session.setLoadedNovel(revision.filename, JSON.parse(JSON.stringify(api.session.loadedNovelMetadata)));
    assert.equal(api.store.getSnapshot(), revision);
    api.session.clearLoadedNovel();
    assert.equal(api.store.getSnapshot(), null);
});

test('intraline highlighting isolates changed text and preserves Unicode and unchanged phrases', async () => {
    const api = await harness();
    for (const [old, next] of [
        ['그는 붉은 문을 열었다. 😀', '그는 푸른 문을 열었다. 😀'],
        ['The quiet room.', 'The very quiet room.'],
        ['One 😀 remains.', 'One 😺 remains.'],
    ]) {
        const diff = api.buildInlineDiff(old, next);
        assert.equal(diff.before.map(part => part.text).join(''), old);
        assert.equal(diff.after.map(part => part.text).join(''), next);
        assert.ok(diff.before.some(part => !part.changed));
        assert.ok(diff.after.some(part => part.changed));
        for (const part of [...diff.before, ...diff.after]) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part.text));
    }
    const diff = api.buildInlineDiff('He opened the red door.', 'He opened the tan door.');
    assert.equal(diff.before.filter(part => part.changed).map(part => part.text).join(''), 'red');
    assert.equal(diff.after.filter(part => part.changed).map(part => part.text).join(''), 'tan');
    const long = Array.from({ length: 2000 }, (_, i) => `word${i} `).join('');
    const large = api.buildInlineDiff(long, long.replace('word10 ', 'changed10 ').replace('word1800 ', 'changed1800 '));
    assert.ok(large.after.filter(part => part.changed).map(part => part.text).join('').length < 100);
});

async function renderDiffDialog(api, revision) {
    const context = createContext({ document: { body: {} } });
    const source = (await transformWithOxc(await readFile(new URL('../src/components/NovelRefineDiffDialog.tsx', import.meta.url), 'utf8'), 'NovelRefineDiffDialog.tsx', { target: 'es2022', jsx: { runtime: 'automatic' } })).code;
    const module = new SourceTextModule(source, { context });
    await module.link(specifier => {
        const values = specifier === 'react' ? React : specifier === 'react/jsx-runtime' ? jsxRuntime
            : specifier === 'react-dom' ? { createPortal: children => children }
            : specifier.endsWith('novelRevisionService.js') ? api
            : specifier.endsWith('textDiff.js') ? api : null;
        assert.ok(values, specifier);
        return new SyntheticModule(Object.keys(values), function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context });
    });
    await module.evaluate();
    return renderToStaticMarkup(React.createElement(module.namespace.default, {
        revision, currentText: revision.after_text, busy: false, actions: {}, onClose() {},
    }));
}

test('the actual dialog renders two versions, stronger intraline marks, and chunk/chapter/all undo controls', async () => {
    const api = await harness(); const revision = api.load(before, after);
    const html = await renderDiffDialog(api, revision);
    assert.match(html, /Previous version \(before refinement\)/);
    assert.match(html, /Latest version/);
    assert.match(html, /<mark class="diff-inline-remove">Old<\/mark>/);
    assert.match(html, /<mark class="diff-inline-add">New<\/mark>/);
    assert.match(html, /Undo chunk 1/);
    assert.match(html, /Undo this chapter/);
    assert.match(html, /Undo all refined chapters/);
    assert.doesNotMatch(html, /Keep the first chapter|Keep the third chapter/);
});

test('sentence reflow, blank lines, and invisible line endings never label unchanged prose as deleted', async () => {
    const api = await harness();
    for (const [old, next] of [
        ['He stopped.\nShe entered.', 'He stopped. She entered.'],
        ['그는 멈췄다.\n그녀가 들어왔다.', '그는 멈췄다.그녀가 들어왔다.'],
        ['彼は止まった。\n彼女が入った。', '彼は止まった。彼女が入った。'],
        ['The same ending.\n', 'The same ending.'],
        ['The same ending.  \n\nNext sentence.\n', 'The same ending.\nNext sentence.'],
        ['한글문구'.repeat(400) + '\n' + '그대로'.repeat(400), '한글문구'.repeat(400) + '그대로'.repeat(400)],
    ]) {
        const hunks = api.buildTextDiff(old, next);
        const rows = hunks.flatMap(hunk => api.buildSideBySideDiffRows(hunk.lines));
        assert.ok(rows.length);
        assert.ok(rows.every(row => !row.beforeChanged && !row.afterChanged), JSON.stringify([old.slice(0, 100), next.slice(0, 100)]));
        assert.ok(rows.every(row => [...row.beforeParts, ...row.afterParts].every(part => !part.changed)));
    }
});

test('reflow and edits together highlight actual words across the whole block, not mismatched display rows', async () => {
    const api = await harness();
    const old = 'Unchanged first sentence.\nHe held a red umbrella.\nUnchanged third sentence.';
    const next = 'Unchanged first sentence. He held a tan umbrella.\nUnchanged third sentence.';
    const rows = api.buildTextDiff(old, next).flatMap(hunk => api.buildSideBySideDiffRows(hunk.lines));
    const removed = rows.flatMap(row => row.beforeParts).filter(part => part.changed).map(part => part.text).join('');
    const added = rows.flatMap(row => row.afterParts).filter(part => part.changed).map(part => part.text).join('');
    assert.equal(removed, 'red');
    assert.equal(added, 'tan');
    const spaces = api.buildSideBySideDiffRows(api.buildTextDiff('ice cream', 'icecream')[0].lines);
    assert.ok(spaces.some(row => row.beforeChanged), 'word-space changes without line reflow must remain visible');
});

test('reflow-only hunks render as layout changes and still undo the exact raw chapter text', async () => {
    const api = await harness();
    const old = chapter(1, 'Untouched.') + chapter(2, 'The first sentence.\r\nThe second sentence.') + chapter(3, 'Untouched.');
    const next = chapter(1, 'Untouched.') + chapter(2, 'The first sentence. The second sentence.') + chapter(3, 'Untouched.');
    const revision = api.load(old, next);
    const html = await renderDiffDialog(api, revision);
    assert.match(html, /Line breaks or trailing whitespace only/);
    assert.doesNotMatch(html, /<mark|class="diff-remove"|class="diff-add"/);
    const hunk = api.buildChapterRevisionDiffs(revision)[0].hunks[0];
    assert.equal(await api.undoNovelRevision(revision, { chapter: 2, hunkId: hunk.id }), old);
});
