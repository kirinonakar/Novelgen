import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { transformWithOxc } from 'vite';

// Exercise the real refine loop with a simulated Tauri stream; no provider calls.
const sources = await Promise.all(['plot_refine', 'text_utils'].map(async name => [
    name,
    (await transformWithOxc(await readFile(new URL(`../src/modules/${name}.ts`, import.meta.url), 'utf8'), `${name}.ts`, {
        target: 'es2022',
    })).code,
]));

async function loadRefine(responses = []) {
    const context = createContext({ console, setTimeout, clearTimeout });
    const session = { stopRequested: false };
    const calls = [];
    const plotStatuses = [];
    const utilities = new SourceTextModule(sources[1][1], { context });
    const stubs = {
        '../services/runtimeSessionStateService.js': { runtimeSessionState: session },
        './tauri_api.js': {
            Channel: class {},
            invoke: async (command, { params, onEvent }) => {
                calls.push(params.prompt);
                const response = responses[calls.length - 1];
                assert.notEqual(response, undefined, 'Unexpected extra generation/retry');
                if (typeof response === 'function') return response(onEvent, session);
                onEvent.onmessage({ content: response, is_finished: true });
            },
        },
        './toast.js': { showToast() {} },
        '../services/runtimeEditorStateService.js': {
            getEditorSnapshot() {}, setPlotRefinePartRange() {}, setPlotText() {},
            setPlotStatus: (message, state) => plotStatuses.push({ message, state }),
        },
        '../services/generationParamsService.js': { getTotalChaptersParam() {} },
        '../services/runtimeViewStateStore.js': {
            runtimeViewStateStore: { getSnapshot: () => ({ apiSettings: {}, generationParams: {}, promptEditor: {} }) },
        },
    };
    const refine = new SourceTextModule(sources[0][1], { context });
    await refine.link(specifier => {
        if (specifier === './text_utils.js') return utilities;
        const stub = stubs[specifier];
        assert.ok(stub, `Unexpected import: ${specifier}`);
        return new SyntheticModule(Object.keys(stub), function () {
            for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
        }, { context });
    });
    await refine.evaluate();
    return { ...refine.namespace, ...utilities.namespace, calls, plotStatuses };
}

const chapter = (n, detail = 'refined', heading = `제 ${n}장`) =>
    `${heading}: 제목 ${n}\n내용: ${detail} ${n}\n핵심 포인트: 사건 ${n}`;
const part = (chapters, heading = '제 1부: 시작') => `${heading}\n${chapters.join('\n\n')}`;
const originalPart = part([1, 2, 3].map(n => chapter(n, 'original')));
const originalPlot = `1. 제목\n테스트\n5. 각 장 제목과 내용, 핵심 포인트\n${originalPart}`;
const refineOptions = {
    originalPlot, lang: 'Korean', totalChapters: 3, refineInstructions: '', startPart: 1, endPart: 1,
};

test('a repeated current-part heading preserves complementary chapters without retry', async () => {
    const output = `${part([chapter(1), chapter(2)])}\n\n${part([chapter(3)], '제 1부: 시작 (계속)')}`;
    const api = await loadRefine([output]);
    const result = await api.refinePlotTextInChunks(refineOptions);
    assert.equal(api.calls.length, 1);
    for (const n of [1, 2, 3]) assert.match(result, new RegExp(`refined ${n}`));
    assert.equal((result.match(/제 1부/g) || []).length, 1);
});

test('formatted and full-width chapter headings are accepted without retry or lost content', async () => {
    const output = part([
        chapter(1, 'refined', '- **제 １장**'),
        chapter(2, 'refined', '> __제 ２장__'),
        chapter(3, 'refined', '### **제 ３장**'),
    ]);
    const api = await loadRefine([output]);
    const result = await api.refinePlotTextInChunks(refineOptions);
    assert.equal(api.calls.length, 1);
    for (const n of [1, 2, 3]) assert.match(result, new RegExp(`refined ${n}`));
});

test('Japanese kanji chapter numbers above ten survive sanitization and coverage checks', async () => {
    const api = await loadRefine();
    const output = part([chapter(11, 'refined', '第十一章'), chapter(12, 'refined', '第十二章')], '第 2 部: 続き');
    const source = part([chapter(11, 'original', '第 11 章'), chapter(12, 'original', '第 12 章')], '第 2 部: 続き');
    const result = api.sanitizeRefinedPartOutput(output, source, 2);
    assert.deepEqual(Object.keys(api.splitPlotIntoChapters(result)), ['11', '12']);
    assert.match(result, /refined 11/);
    assert.match(result, /refined 12/);
});

test('actual missing chapters still trigger a retry with the exact required coverage', async () => {
    const api = await loadRefine([part([chapter(1), chapter(2)]), part([chapter(1), chapter(2), chapter(3)])]);
    const statuses = [];
    const result = await api.refinePlotTextInChunks({ ...refineOptions, onStatus: status => statuses.push(status) });
    assert.equal(api.calls.length, 2);
    assert.ok(statuses.some(status => status.includes('missed chapter markers 3')));
    assert.match(result, /refined 3/);
});

test('repeated failure remains bounded and does not silently restore source chapters', async () => {
    const api = await loadRefine(Array(4).fill(part([chapter(1), chapter(2)])));
    await assert.rejects(api.refinePlotTextInChunks(refineOptions), /after 3 retries.*3/);
    assert.equal(api.calls.length, 4);
});

test('a different part is excluded instead of accepting the unrefined original', async () => {
    const api = await loadRefine();
    const result = api.sanitizeRefinedPartOutput(part([chapter(4)], '제 2부: 다음'), originalPart, 1);
    assert.deepEqual(Object.keys(api.splitPlotIntoChapters(result)), []);
    assert.doesNotMatch(result, /original|refined 4/);
});

test('duplicate chapters keep the detailed version and future-part output is excluded', async () => {
    const api = await loadRefine();
    const output = `${part([chapter(1), chapter(2), chapter(3)])}\n${part(['제 1장: short'])}\n${part([chapter(4)], '제 2부: 다음')}`;
    const result = api.sanitizeRefinedPartOutput(output, originalPart, 1);
    assert.deepEqual(Object.keys(api.splitPlotIntoChapters(result)), ['1', '2', '3']);
    assert.match(result, /refined 1/);
    assert.doesNotMatch(result, /short|refined 4/);
});

test('stop after generation does not retry an incomplete part', async () => {
    const api = await loadRefine([(channel, session) => {
        channel.onmessage({ content: part([chapter(1)]), is_finished: false });
        session.stopRequested = true;
        channel.onmessage({ content: part([chapter(1)]), is_finished: true });
    }]);
    await api.refinePlotTextInChunks(refineOptions);
    assert.equal(api.calls.length, 1);
});

test('shared heading parsing preserves bare markers, titles, CRLF bodies, and language variants', async () => {
    const api = await loadRefine();
    for (const [heading, number] of [
        ['제 1장', 1], ['## **제 2장**', 2], ['- **Chapter ３**: Arrival', 3],
        ['> __Chapter 4__', 4], ['[第十二章]: 続き', 12], ['第百二十三章', 123],
    ]) {
        assert.equal(api.parsePlotChapterHeading(heading)?.number, number, heading);
        const parsed = api.splitPlotIntoChapters(`${heading}\r\n내용: 첫 줄\r\n두 번째 줄`);
        assert.match(parsed[number], /내용: 첫 줄\r\n두 번째 줄$/, heading);
        const normalized = api.normalizePlotOutlineOutput(`${heading}\n내용: 첫 줄`);
        assert.ok(api.splitPlotIntoChapters(normalized)[number]?.includes('첫 줄'), heading);
    }
    for (const line of ['Chapter 1st', '제 2장면', '내용: 제 3장', 'Chapter\n4', '제 0장']) {
        assert.equal(api.parsePlotChapterHeading(line), null, line);
    }
});

test('a selected later part requests only its original chapter numbers', async () => {
    const secondPart = part([4, 5, 6].map(n => chapter(n)), '제 2부: 다음');
    const api = await loadRefine([secondPart]);
    const result = await api.refinePlotTextInChunks({
        ...refineOptions, originalPlot: `${originalPlot}\n${secondPart}`, totalChapters: 6, startPart: 2, endPart: 2,
    });
    assert.equal(api.calls.length, 1);
    assert.match(api.calls[0], /Required chapter numbers for this part only: 4, 5, 6/);
    assert.doesNotMatch(api.calls[0], /list every chapter marker in ascending order/);
    assert.match(result, /original 1/);
    assert.match(result, /refined 6/);
});

test('settings and part refinement forward thinking counts and the transition to generation', async () => {
    const stream = content => channel => {
        channel.onmessage({ content: '', status: '💭 Thinking...(5 tokens)', is_finished: false });
        channel.onmessage({ content: '', status: '💭 Thinking...(10 tokens)', is_finished: false });
        channel.onmessage({ content, status: '⏳ Generating...', is_finished: false });
        channel.onmessage({ content, status: 'final stream status', is_finished: true });
    };
    const api = await loadRefine([
        stream('1. 제목\n수정된 설정'),
        stream(part([chapter(1), chapter(2), chapter(3)])),
    ]);
    const statuses = [];
    const result = await api.refinePlotTextInChunks({
        ...refineOptions, endPart: null, onStatus: message => statuses.push(message),
    });
    for (const prefix of ['⏳ Refining settings...', '⏳ Refining plot part 1/1...']) {
        for (const suffix of ['💭 Thinking...(5 tokens)', '💭 Thinking...(10 tokens)', '⏳ Generating...']) {
            const message = `${prefix} ${suffix}`;
            assert.ok(statuses.includes(message), message);
            assert.ok(api.plotStatuses.some(item => item.message === message && item.state === 'refining'), message);
        }
    }
    assert.ok(!statuses.some(message => message.includes('final stream status')));
    assert.equal(statuses.at(-1), '✅ Done');
    assert.match(result, /refined 3/);
});

test('retry and continuation statuses retain the part context alongside thinking counts', async () => {
    const api = await loadRefine([
        part([chapter(1), chapter(2)]),
        channel => {
            channel.onmessage({ content: '', status: '💭 Thinking...(20 tokens)', is_finished: false });
            channel.onmessage({ content: chapter(1), status: '⏳ Continuing plot (1/4)...', is_finished: false });
            channel.onmessage({ content: part([chapter(1), chapter(2), chapter(3)]), is_finished: true });
        },
    ]);
    const statuses = [];
    await api.refinePlotTextInChunks({ ...refineOptions, onStatus: message => statuses.push(message) });
    assert.ok(statuses.includes('⏳ Refining plot part 1/1 (retry 1/3)... 💭 Thinking...(20 tokens)'));
    assert.ok(statuses.includes('⏳ Refining plot part 1/1 (retry 1/3)... ⏳ Continuing plot (1/4)...'));
    assert.equal(statuses.at(-1), '✅ Done');
});

test('a delayed final snapshot preserves the full intensity tail instead of the last preview', async () => {
    for (const tail of ['combat 0,', 'combat 0, comedy']) {
        const preview = `${part([chapter(1), chapter(2), chapter(3)])}\nintensity: ${tail}`;
        const complete = `${part([chapter(1), chapter(2), chapter(3)])}\nintensity: combat 0, comedy 4`;
        const api = await loadRefine([channel => {
            channel.onmessage({ content: preview, is_finished: false });
            setTimeout(() => channel.onmessage({ content: complete, is_finished: true }), 0);
        }]);
        const updates = [];
        const result = await api.refinePlotTextInChunks({ ...refineOptions, onUpdate: text => updates.push(text) });
        assert.ok(result.endsWith('combat 0, comedy 4'), tail);
        assert.equal(updates.at(-1), result);
        assert.equal(api.calls.length, 1);
    }
});

test('a delayed settings snapshot is used by the following part prompt', async () => {
    const api = await loadRefine([
        channel => {
            channel.onmessage({ content: '1. 제목\n설정 작', is_finished: false });
            setTimeout(() => channel.onmessage({ content: '1. 제목\n설정 작성 완료', is_finished: true }), 0);
        },
        part([chapter(1), chapter(2), chapter(3)]),
    ]);
    const result = await api.refinePlotTextInChunks({ ...refineOptions, endPart: null });
    assert.match(api.calls[1], /설정 작성 완료/);
    assert.match(result, /설정 작성 완료/);
});

test('a delayed terminal stream error cannot be accepted as a successful preview', async () => {
    const api = await loadRefine([channel => {
        const content = part([chapter(1), chapter(2), chapter(3)]);
        channel.onmessage({ content, is_finished: false });
        setTimeout(() => channel.onmessage({ content, error: 'final stream failed', is_finished: true }), 0);
    }]);
    await assert.rejects(api.refinePlotTextInChunks(refineOptions), /final stream failed/);
});

test('missing final delivery does not accept a complete-looking truncated preview', async () => {
    const api = await loadRefine([channel => {
        channel.onmessage({ content: `${part([chapter(1), chapter(2), chapter(3)])}\nintensity: combat 0, comedy`, is_finished: false });
    }]);
    await assert.rejects(api.refinePlotTextInChunks(refineOptions), /without its final snapshot/);
    assert.equal(api.calls.length, 1);
});
