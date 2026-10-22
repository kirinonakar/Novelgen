import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import ts from 'typescript';

async function harness() {
    const body = {};
    const main = { scrollTop: 2448, scrollHeight: 5000, clientHeight: 500, parentElement: body,
        getBoundingClientRect: () => ({ top: 0 }), overflowY: 'auto' };
    const heading = (number, top) => ({ textContent: `Chapter ${number}`, isConnected: true,
        getBoundingClientRect: () => ({ top: top - main.scrollTop }) });
    const headings = [heading(1, 1000), heading(2, 2000), heading(3, 3000)];
    const preview = { parentElement: main, scrollHeight: 3000, clientHeight: 3000,
        querySelectorAll: () => headings,
        getBoundingClientRect: () => ({ top: 1000 - main.scrollTop, bottom: 4000 - main.scrollTop }) };
    const textarea = { value: 'x'.repeat(3000), clientWidth: 500, clientHeight: 100, scrollHeight: 1500, scrollTop: 0,
        getBoundingClientRect: () => ({ top: 900 - main.scrollTop }),
        parentElement: { parentElement: main, getBoundingClientRect: () => ({ top: 900 - main.scrollTop }) } };
    const editor = { novel: textarea.value, novelChapterJump: '1', tabs: { novel: 'preview' },
        novelChapterJumpOptions: [0, 1000, 2000].map((offset, index) => ({ value: String(index + 1), chapterNumber: index + 1, offset })) };
    const frames = new Map();
    let frameId = 0, selectedChapterJumps = 0;
    const context = createContext({ console, setTimeout, clearTimeout,
        requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
        cancelAnimationFrame: id => frames.delete(id),
        window: { getComputedStyle: element => ({ overflowY: element.overflowY || 'visible', borderLeftWidth: '0', borderRightWidth: '0', paddingTop: '0' }) },
        document: { body, scrollingElement: body, documentElement: body,
            createTextNode: text => ({ text }),
            createElement: tag => tag === 'span' ? {} : { style: {}, length: 0,
                appendChild(node) {
                    if (node.text !== undefined) this.length += node.text.length;
                    else node.offsetTop = this.length * 0.5; // Edit wraps at half Preview's height.
                }, remove() {} },
        },
    });
    body.appendChild = () => {};
    const store = { getSnapshot: () => ({ editor }), setEditor: patch => {
        Object.assign(editor, patch);
        // Model the shared page being clamped when the long Preview is hidden.
        if (patch.tabs?.novel === 'edit') main.scrollTop = 0;
    } };
    function synthetic(values) {
        return new SyntheticModule(Object.keys(values), function () {
            for (const [name, value] of Object.entries(values)) this.setExport(name, value);
        }, { context });
    }
    async function load(name, overrides) {
        const source = ts.transpileModule(await readFile(new URL(`../src/services/${name}.ts`, import.meta.url), 'utf8'), {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
        }).outputText;
        const ast = ts.createSourceFile('module.js', source, ts.ScriptTarget.ES2022, true);
        const imports = new Map(ast.statements.filter(ts.isImportDeclaration).map(node => [
            node.moduleSpecifier.text,
            Object.fromEntries(node.importClause.namedBindings.elements.map(item => [(item.propertyName || item.name).text, () => {}])),
        ]));
        const module = new SourceTextModule(source, { context });
        await module.link(specifier => synthetic(overrides[specifier] || imports.get(specifier)));
        await module.evaluate();
        return module.namespace;
    }
    const navigation = (await load('chapterNavigationService', {
        './runtimeDomRegistryService.js': { getRuntimeElement: key => key === 'novelContent' ? textarea : preview },
        './runtimeViewStateStore.js': { runtimeViewStateStore: store },
    })).createChapterNavigation({ getLang: () => 'English' });
    const workflow = (await load('runtimeWorkflowActionsService', {
        './runtimeViewStateStore.js': { runtimeViewStateStore: store },
    })).createRuntimeWorkflowActions({
        refreshNovelChapterJump() {}, syncNovelChapterToScroll() {},
        captureNovelReadingPosition: navigation.captureNovelReadingPosition,
        restoreNovelReadingPosition: navigation.restoreNovelReadingPosition,
        scrollNovelToSelectedChapter: () => { selectedChapterJumps++; },
    });
    function paint() {
        const pending = [...frames.values()]; frames.clear();
        pending.forEach(fn => fn());
    }
    return { navigation, workflow, main, textarea, editor, paint, selectedChapterJumps: () => selectedChapterJumps };
}

test('Preview to Edit follows the current chapter and progress, even when chapter 1 is selected', async () => {
    const api = await harness();
    api.workflow.onEditorTabChange('novel', 'edit');
    api.paint();
    assert.equal(api.textarea.scrollTop, 750); // Halfway through Chapter 2 in Edit.
    assert.equal(api.selectedChapterJumps(), 0);
});

test('Edit to Preview follows the newly scrolled Edit position rather than the old Preview location', async () => {
    const api = await harness();
    api.workflow.onEditorTabChange('novel', 'edit'); api.paint();
    api.textarea.scrollTop = 900; // 80% through Chapter 2.
    api.workflow.onEditorTabChange('novel', 'preview'); api.paint();
    assert.equal(api.main.scrollTop, 2748);
    assert.equal(api.selectedChapterJumps(), 0);
});

test('repeated switches keep the reading position and preserve zero at the first chapter', async () => {
    const api = await harness();
    for (let i = 0; i < 3; i++) {
        api.workflow.onEditorTabChange('novel', 'edit'); api.paint();
        api.workflow.onEditorTabChange('novel', 'preview'); api.paint();
        assert.equal(api.main.scrollTop, 2448);
    }
    api.main.scrollTop = 948;
    api.workflow.onEditorTabChange('novel', 'edit'); api.paint();
    assert.equal(api.textarea.scrollTop, 0);
});

test('the final chapter and rapid tab changes do not reset to chapter 1', async () => {
    const api = await harness();
    api.main.scrollTop = 3548;
    api.workflow.onEditorTabChange('novel', 'edit'); api.paint();
    assert.equal(api.textarea.scrollTop, 1300);
    api.workflow.onEditorTabChange('novel', 'preview');
    api.workflow.onEditorTabChange('novel', 'edit'); api.paint();
    assert.equal(api.textarea.scrollTop, 1300);
    api.workflow.onEditorTabChange('novel', 'preview'); api.paint();
    assert.equal(api.main.scrollTop, 3548);
});

test('Edit capture includes content clipped by the outer page as well as textarea scrolling', async () => {
    const api = await harness();
    api.workflow.onEditorTabChange('novel', 'edit'); api.paint();
    api.textarea.scrollTop = 750;
    api.main.scrollTop = 1048; // Another 200 pixels are hidden behind the sticky tab header.
    api.workflow.onEditorTabChange('novel', 'preview'); api.paint();
    assert.equal(api.main.scrollTop, 2848);
});
