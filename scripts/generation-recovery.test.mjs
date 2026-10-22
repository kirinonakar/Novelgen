import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import ts from 'typescript';

async function harness({ files = new Map(), stream } = {}) {
    const storage = new Map(), calls = [], previews = [];
    const editor = { novel: 'Unrelated manuscript', plot: 'Unrelated plot', nextChapter: '1', novelStatus: { message: '' } };
    const view = { apiSettings: {}, generationParams: {}, promptEditor: {}, editor, refineInstructions: { novel: '' } };
    const context = createContext({ console, localStorage: {
        getItem: key => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key),
    }, requestAnimationFrame: fn => fn(), setTimeout, clearTimeout });
    const stubs = {
        '../services/chunkedPlotGenerationService.js': { generatePlotOutlineInChunks() { assert.fail('Unexpected plot generation'); }, shouldGeneratePlotInChunks: () => false },
        '../services/plotGenerationService.js': { generatePlotStream() { assert.fail('Unexpected plot generation'); } },
        './novel_refine.js': { clearNovelRefineChapterRange() {}, refineNovelTextInChapters() {} },
        './plot_auto.js': { generatePlotAutoInstructions() {} },
        './plot_refine.js': { normalizePlotOutlineOutput: text => text, refinePlotTextInChunks() {} },
        '../services/plotPromptService.js': { buildPlotOutlinePrompt: () => 'plot prompt' },
        '../services/generationParamsService.js': { getTargetTokensParam: () => 2000, getTotalChaptersParam: () => 10 },
        '../services/runtimeViewStateStore.js': { runtimeViewStateStore: { getSnapshot: () => view, setActivity() {} } },
        '../services/runtimeEditorStateService.js': {
            getEditorSnapshot: () => editor,
            setNextChapter: chapter => { editor.nextChapter = String(chapter); },
            setNovelText: text => { editor.novel = text; previews.push(text); },
            setNovelStatus: message => { editor.novelStatus.message = message; },
            setPlotStatus() {}, setPlotText: text => { editor.plot = text; },
        },
        '../services/runtimeDomRegistryService.js': { getRuntimeElement: () => null },
        './toast.js': { showToast() {} },
        './tauri_api.js': {
            Channel: class {},
            invoke: async (command, args) => {
                calls.push({ command, args });
                if (command === 'load_novel') {
                    const value = files.get(args.filename);
                    if (!value) throw new Error('Missing job file');
                    return [value.text, JSON.stringify(value.meta)];
                }
                if (command === 'suggest_next_chapter') {
                    const chapters = [...args.text.matchAll(/Chapter (\d+)/g)].map(match => Number(match[1]));
                    return Math.max(args.last_completed_ch || 0, ...chapters, 0) + 1;
                }
                if (command === 'generate_novel') return stream(args.onEvent, args.params);
                assert.fail(`Unexpected command: ${command}`);
            },
        },
    };
    const modules = new Map();
    const pendingModules = new Map();
    const paths = {
        '../services/runtimeSessionStateService.js': 'services/runtimeSessionStateService.ts',
        './runtimeSessionStateService.js': 'services/runtimeSessionStateService.ts',
        '../services/batchCheckpointService.js': 'services/batchCheckpointService.ts',
        './novel_storage.js': 'modules/novel_storage.ts',
        './text_utils.js': 'modules/text_utils.ts',
    };
    function load(path) {
        if (!pendingModules.has(path)) pendingModules.set(path, loadModule(path));
        return pendingModules.get(path);
    }
    async function loadModule(path) {
        let source = await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
        if (path === 'modules/batch_queue.ts') source += '\nexport { runBatchJob, runSingleJob };';
        const module = new SourceTextModule(ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
        }).outputText, { context });
        modules.set(path, module);
        await module.link(async name => {
            if (paths[name]) return load(paths[name]);
            const stub = stubs[name];
            assert.ok(stub, `Missing stub: ${name}`);
            return new SyntheticModule(Object.keys(stub), function () {
                for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
            }, { context });
        });
        return module;
    }
    const batch = await load('modules/batch_queue.ts');
    await batch.evaluate();
    const generation = await load('modules/novel_generation.ts');
    await generation.evaluate();
    return {
        ...batch.namespace, ...generation.namespace, calls, previews, storage, editor, files,
        session: modules.get('services/runtimeSessionStateService.ts').namespace.runtimeSessionState,
        checkpoints: modules.get('services/batchCheckpointService.ts').namespace,
    };
}

const jobFile = 'novel_20261022_0001.txt';
const savedPlot = Array.from({ length: 10 }, (_, i) => `Chapter ${i + 1}\nTitle: Test\nContent: Story.`).join('\n\n');
function job() {
    return { uid: 7, type: 'batch', novelFilename: jobFile, plotOutline: savedPlot, startedNovelGeneration: true,
        canResumeNovelGeneration: true, seed: 'seed', lang: 'English', totalChapters: 10, targetTokens: 1000 };
}

test('batch resume uses its persisted file and continuity despite another displayed novel', async () => {
    const api = await harness({ files: new Map([[jobFile, { text: 'Chapter 8\nSaved story.', meta: {
        current_chapter: 8, character_state: 'Original hero', current_arc: 'Original arc', memory_rebuild_from_chapter: 8,
        needs_memory_rebuild: true,
    } }]]) });
    const active = job();
    api.session.taskQueue = [active];
    api.session.lastRanJobUid = active.uid;
    let generated;
    await api.runBatchJob(active, {
        generateNovel: async options => {
            generated = options;
            options.onFilenameKnown(jobFile);
            const result = { fullNovelText: 'Chapter 10\nDone.', novelFilename: jobFile, metadata: { current_chapter: 10 } };
            api.files.set(jobFile, { text: result.fullNovelText, meta: result.metadata });
            return result;
        }, updatePlotTokenCount() {}, detectNextChapter() {},
    });
    assert.equal(generated.novelFilename, jobFile);
    assert.equal(generated.initialText, 'Chapter 8\nSaved story.');
    assert.equal(generated.startChapter, 9);
    assert.equal(generated.characterState, 'Original hero');
    assert.equal(generated.currentArc, 'Original arc');
    assert.equal(generated.memoryRebuildFromChapter, 8);
    assert.ok(api.calls.every(call => call.command !== 'get_latest_novel_metadata'));
    api.session.reset();
    assert.equal(api.checkpoints.restoreBatchQueue(), true);
    assert.equal(api.session.taskQueue[0].novelFilename, jobFile);
    assert.equal(api.session.taskQueue[0].plotOutline, savedPlot);
    assert.equal(api.session.isPaused, true);
});

test('a missing job file pauses instead of falling back to another novel', async () => {
    const api = await harness();
    const active = job();
    api.session.lastRanJobUid = active.uid;
    await assert.rejects(api.runBatchJob(active, { updatePlotTokenCount() {}, generateNovel() { assert.fail('Must not generate'); } }), /Cannot load this job's novel/);
    assert.equal(api.session.stopRequested, true);
    assert.equal(api.session.isPaused, true);
    assert.deepEqual(api.calls.map(call => call.command), ['load_novel']);
});

test('single-job resume also ignores the editor filename and next chapter', async () => {
    const api = await harness({ files: new Map([[jobFile, { text: 'Chapter 8\nSaved story.', meta: { current_chapter: 8, character_state: 'Original hero' } }]]) });
    api.session.setLoadedNovel('novel_other.txt');
    const active = { ...job(), type: 'single', startChapter: 1 };
    let generated;
    await api.runSingleJob(active, {
        generateNovel: async options => {
            generated = options;
            return { fullNovelText: 'Chapter 10\nDone.', novelFilename: jobFile, metadata: { current_chapter: 10 } };
        },
    });
    assert.equal(generated.startChapter, 9);
    assert.equal(generated.characterState, 'Original hero');
    assert.equal(generated.initialText, 'Chapter 8\nSaved story.');
    assert.equal(generated.novelFilename, jobFile);
});

test('chapter patches preserve a long Unicode prefix and rollback a partial chapter', async () => {
    const prefix = '한글 😀\n'.repeat(100000);
    const header = '\n\n### Chapter 101\n\n';
    const api = await harness({ stream: channel => {
        channel.onmessage({ content: header, replace_from: prefix.length, is_finished: false });
        channel.onmessage({ content: '초안 😀', is_chapter_preview: true });
        channel.onmessage({ content: '', replace_from: prefix.length, is_finished: true });
        return { full_text: prefix, novel_filename: jobFile, metadata: { current_chapter: 100 } };
    } });
    await api.generateNovel({ initialText: prefix, startChapter: 101, novelFilename: jobFile });
    assert.ok(api.previews.includes(prefix + header + '초안 😀'));
    assert.equal(api.editor.novel, prefix);
});

test('chapter completion commits once and later previews use the next chapter base', async () => {
    const prefix = 'Chapter 1\n이전 😀\n';
    const second = '\nChapter 2\n새 본문.\n';
    const third = '\nChapter 3\n';
    const api = await harness({ stream: channel => {
        channel.onmessage({ content: '\nChapter 2\n', replace_from: prefix.length });
        channel.onmessage({ content: '초안', is_chapter_preview: true });
        channel.onmessage({ content: second, replace_from: prefix.length, status: 'Summarizing Chapter 2...' });
        channel.onmessage({ content: third, replace_from: (prefix + second).length });
        channel.onmessage({ content: '세 번째.', is_chapter_preview: true });
        return { full_text: prefix + second + third + '세 번째.', novel_filename: jobFile, metadata: { current_chapter: 3 } };
    } });
    const finished = [];
    await api.generateNovel({ initialText: prefix, startChapter: 2, novelFilename: jobFile, onChapterFinished: chapter => finished.push(chapter) });
    assert.ok(api.previews.includes(prefix + second + third + '세 번째.'));
    assert.equal(api.editor.novel, prefix + second + third + '세 번째.');
    assert.deepEqual(finished, [2, 3]);
});
