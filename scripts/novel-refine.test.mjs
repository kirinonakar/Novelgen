import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import ts from 'typescript';

// Run the actual chapter loop, previews, and saves against simulated Tauri streams.
const sources = await Promise.all(['novel_refine', 'text_utils'].map(async name =>
    ts.transpileModule(await readFile(new URL(`../src/modules/${name}.ts`, import.meta.url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText));

async function loadRefine(responses) {
    const context = createContext({ console: { ...console, error() {} }, TextEncoder, setTimeout, clearTimeout });
    const session = {
        loadedNovelFilename: 'test.txt',
        setLoadedNovel(filename, metadata) { this.loadedNovelFilename = filename; this.loadedNovelMetadata = metadata; },
    };
    const calls = [], saves = [], statuses = [], previews = [];
    const utilities = new SourceTextModule(sources[1], { context });
    const stubs = {
        '../services/runtimeSessionStateService.js': { runtimeSessionState: session },
        './novel_auto.js': { generateInstructionForChapter: async () => 'Improve the dialogue.' },
        '../services/generationParamsService.js': {
            getTargetTokensParam: () => 2000, getTotalChaptersParam: fallback => fallback,
        },
        '../services/runtimeEditorStateService.js': {
            clearNovelRefineChapterRangeState() {}, getEditorSnapshot: () => ({}),
            setNovelRefineChapterRange() {},
            setNovelStatus: (message, state) => statuses.push({ message, state }),
            setNovelText: text => previews.push(text),
        },
        '../services/runtimeViewStateStore.js': {
            runtimeViewStateStore: {
                getSnapshot: () => ({ apiSettings: {}, generationParams: {}, promptEditor: {} }),
                setRefineInstructions() {}, setActivity() {},
            },
        },
        './tauri_api.js': {
            Channel: class {},
            invoke: async (command, args) => {
                if (command === 'save_novel_state') { saves.push(args); return; }
                assert.equal(command, 'generate_plot');
                calls.push(args.params);
                const response = responses[calls.length - 1];
                assert.notEqual(response, undefined, 'Unexpected extra generation/continuation');
                if (typeof response === 'function') return response(args.onEvent, session);
                args.onEvent.onmessage({ content: response, is_finished: true });
            },
        },
        './toast.js': { showToast() {} },
    };
    const refine = new SourceTextModule(sources[0], { context });
    await refine.link(specifier => {
        if (specifier === './text_utils.js') return utilities;
        const stub = stubs[specifier];
        assert.ok(stub, `Unexpected import: ${specifier}`);
        return new SyntheticModule(Object.keys(stub), function () {
            for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
        }, { context });
    });
    await refine.evaluate();
    return { ...refine.namespace, calls, saves, statuses, previews, session };
}

const marker = n => `<<<NOVEL_REFINE_CHAPTER_${n}_COMPLETE>>>`;
const body = '그는 낡은 문을 열었다. 안에는 오래된 편지 한 장이 놓여 있었다.\n\n'.repeat(40);
const options = {
    originalNovel: `제 1장: 편지\n\n${body}그는 편지를 들고 집으로 돌아왔다.`,
    plotOutline: '제 1장: 편지\n내용: 편지를 발견하고 집으로 돌아간다.',
    lang: 'Korean', totalChapters: 1,
};

test('a complete shorter revision does not request an unnecessary ending', async () => {
    const revised = `${body.slice(0, 600)}\n\n그는 편지를 들고 집으로 돌아왔다.`;
    const api = await loadRefine([revised]);
    const result = await api.refineNovelTextInChapters(options);
    assert.equal(api.calls.length, 1);
    assert.ok(result.fullText.endsWith('그는 편지를 들고 집으로 돌아왔다.'));
    assert.ok(!api.statuses.some(item => item.message.includes('Completing chapter')));
    assert.equal(api.calls[0].max_tokens, 0, 'keep provider-aware automatic output limits');
});

test('the completion signal permits an intentional unpunctuated ending and never enters previews or saves', async () => {
    const revised = `${body}그리고 마침내, 새벽`;
    const api = await loadRefine([channel => {
        for (const content of [revised, ...Array.from(marker(1), (_, i) => `${revised}\n${marker(1).slice(0, i + 1)}`)]) {
            channel.onmessage({ content, is_finished: false });
        }
        channel.onmessage({ content: `${revised}\n${marker(1)}`, is_finished: true });
    }]);
    const result = await api.refineNovelTextInChapters(options);
    assert.equal(api.calls.length, 1);
    assert.ok(result.fullText.endsWith('그리고 마침내, 새벽'));
    for (const text of [...api.previews, ...api.saves.map(save => save.textContent)]) {
        assert.ok(!text.trimEnd().endsWith('<'));
        assert.doesNotMatch(text, /<<<NOVEL_REFINE/);
    }
    assert.match(api.calls[0].prompt, /<<<NOVEL_REFINE_CHAPTER_1_COMPLETE>>>/);
    assert.equal(api.calls[0].prompt.split(body).length - 1, 1, 'include the manuscript only once');
});

test('Markdown emphasis at a completed ending does not trigger continuation', async () => {
    const api = await loadRefine([`${body}**그는 돌아왔다.**`]);
    const result = await api.refineNovelTextInChapters(options);
    assert.equal(api.calls.length, 1);
    assert.ok(result.fullText.endsWith('**그는 돌아왔다.**'));
});

test('a genuinely interrupted sentence is completed once without duplicating the boundary', async () => {
    const draft = `${body}편지를 읽은 그는 문을`;
    const api = await loadRefine([draft, `편지를 읽은 그는 문을 닫았다.\n${marker(1)}`]);
    const result = await api.refineNovelTextInChapters(options);
    assert.equal(api.calls.length, 2);
    assert.ok(result.fullText.endsWith('편지를 읽은 그는 문을 닫았다.'));
    assert.equal(result.fullText.split('편지를 읽은 그는 문을').length - 1, 1);
});

test('unfinished output after the continuation limit is not saved as a completed chapter', async () => {
    const api = await loadRefine([`${body}아직`, '아직 이야기가 이어지고', '아직 이야기가 이어지고 결말은 여전히']);
    await assert.rejects(api.refineNovelTextInChapters(options), /chapter 1.*incomplete/i);
    assert.equal(api.calls.length, 3);
    assert.equal(api.saves.length, 0);
    assert.ok(api.previews.at(-1).endsWith('그는 편지를 들고 집으로 돌아왔다.'));
    assert.equal(api.session.isNovelRefining, false);
});

test('empty output fails without asking the model to invent a chapter ending', async () => {
    const api = await loadRefine(['']);
    await assert.rejects(api.refineNovelTextInChapters(options), /empty content/);
    assert.equal(api.calls.length, 1);
    assert.equal(api.saves.length, 0);
});

test('a continuation with no new text repairs only the final paragraph without losing completed text', async () => {
    const draft = `${body}그는 아직`;
    const api = await loadRefine([draft, draft, '그는 아직 편지를 들고 있었다. 그리고 집으로 돌아왔다.']);
    const result = await api.refineNovelTextInChapters(options);
    assert.equal(api.calls.length, 3);
    assert.match(api.calls[2].prompt, /complete replacement for the final paragraph/);
    assert.ok(result.fullText.includes(body.trimEnd()));
    assert.ok(result.fullText.endsWith('그는 아직 편지를 들고 있었다. 그리고 집으로 돌아왔다.'));
    assert.doesNotMatch(result.fullText, /아직 그는/);
});

test('stop during generation does not start continuation or save a partial chapter', async () => {
    const api = await loadRefine([(channel, session) => {
        channel.onmessage({ content: `${body}그는 아직`, is_finished: false });
        session.stopRequested = true;
        channel.onmessage({ content: `${body}그는 아직`, is_finished: true });
    }]);
    assert.equal(await api.refineNovelTextInChapters(options), null);
    assert.equal(api.calls.length, 1);
    assert.equal(api.saves.length, 0);
    assert.equal(api.statuses.at(-1).state, 'cancelled');
});

test('a provider error retains earlier completed chapters and restores the failed chapter source', async () => {
    const api = await loadRefine([`수정된 첫 장.\n${marker(1)}`, channel => {
        channel.onmessage({ content: '잘린 둘째 장', is_finished: true, error: 'API Error (503): unavailable' });
    }]);
    await assert.rejects(api.refineNovelTextInChapters({
        ...options, totalChapters: 2, originalNovel: `${options.originalNovel}\n\n제 2장: 귀환\n\n원래 둘째 장.`,
    }), /503/);
    assert.equal(api.saves.length, 1);
    assert.match(api.previews.at(-1), /수정된 첫 장\./);
    assert.ok(api.previews.at(-1).endsWith('원래 둘째 장.'));
});

test('backend output-limit continuations remain one generation call with live status updates', async () => {
    const api = await loadRefine([channel => {
        channel.onmessage({ content: '그는 편지를', is_finished: false, status: '⏳ Generating...' });
        channel.onmessage({ content: '그는 편지를', is_finished: false, status: 'Continuing plot (1/4)...' });
        channel.onmessage({ content: `그는 편지를 읽고 돌아왔다.\n${marker(1)}`, is_finished: true });
    }]);
    const result = await api.refineNovelTextInChapters(options);
    assert.equal(api.calls.length, 1);
    assert.ok(api.statuses.some(item => item.message.includes('Continuing plot (1/4)')));
    assert.ok(result.fullText.endsWith('그는 편지를 읽고 돌아왔다.'));
});

test('English and Japanese chapters accept completion signals inside code fences', async () => {
    for (const [lang, heading, ending] of [
        ['English', 'Chapter 1: Home', 'And then, dawn'],
        ['Japanese', '第1章: 帰還', 'そして、夜明け'],
    ]) {
        const api = await loadRefine([`\`\`\`text\n${heading}\n${ending}\n${marker(1)}\n\`\`\``]);
        const result = await api.refineNovelTextInChapters({ ...options, lang, originalNovel: `${heading}\nOriginal.` });
        assert.equal(api.calls.length, 1);
        assert.ok(result.fullText.endsWith(ending));
        assert.doesNotMatch(result.fullText, /<<<|```/);
    }
});

test('a completion signal never overrides a provider error or replaces an empty manuscript', async () => {
    for (const [response, error] of [
        [marker(1), /empty content/],
        [channel => channel.onmessage({ content: `일부 원고.\n${marker(1)}`, is_finished: true, error: 'content_filter' }), /content_filter/],
    ]) {
        const api = await loadRefine([response]);
        await assert.rejects(api.refineNovelTextInChapters(options), error);
        assert.equal(api.calls.length, 1);
        assert.equal(api.saves.length, 0);
    }
});

test('continuation output for the next chapter is excluded instead of appended as raw text', async () => {
    const api = await loadRefine([`${body}그는 아직`, '제 2장: 다음\n잘못 생성된 다음 장.', '그는 아직 돌아갈 집이 있었다.']);
    const result = await api.refineNovelTextInChapters(options);
    assert.equal(api.calls.length, 3);
    assert.ok(result.fullText.endsWith('그는 아직 돌아갈 집이 있었다.'));
    assert.ok(api.previews.every(text => !text.includes('잘못 생성된 다음 장')));
});

test('last sentences mentioning a chapter remain manuscript prose', async () => {
    for (const [lang, heading, ending] of [
        ['Korean', '제 1장: 편지', '제 2장 첫머리에 적힌 이름은 그의 것이었다.'],
        ['Japanese', '第1章: 手紙', '第2章 に記された名前は彼のものだった。'],
        ['English', 'Chapter 1: Letter', 'Chapter 2 was only a name written on the box.'],
    ]) {
        const api = await loadRefine([`${body}${ending}\n${marker(1)}`]);
        const result = await api.refineNovelTextInChapters({ ...options, lang, originalNovel: `${heading}\nOriginal.` });
        assert.ok(result.fullText.endsWith(ending), lang);
        assert.match(result.fullText, /낡은 문/);
        assert.equal(api.calls.length, 1);
    }
});

test('manuscript-label words in narrative never delete earlier paragraphs or the last sentence', async () => {
    for (const ending of ['본문은 이제 막 시작이었다.', '수정본을 들고 그는 집으로 돌아왔다.', 'Revised plans would have to wait.', '本文はこれで終わりだった。']) {
        const api = await loadRefine([`${body}${ending}\n${marker(1)}`]);
        const result = await api.refineNovelTextInChapters(options);
        assert.match(result.fullText, /낡은 문/);
        assert.ok(result.fullText.endsWith(ending));
    }
});

test('an opening quote or an unclosed final dialogue is not a complete sentence', async () => {
    for (const [draft, completed] of [
        ['그는 속삭였다. "', '그는 속삭였다. "돌아왔구나."'],
        ['그는 속삭였다. “돌아왔구', '그는 속삭였다. “돌아왔구나.”'],
    ]) {
        const api = await loadRefine([`${body}${draft}`, `${draft}${completed.slice(draft.length)}\n${marker(1)}`]);
        const result = await api.refineNovelTextInChapters(options);
        assert.equal(api.calls.length, 2);
        assert.ok(result.fullText.endsWith(completed));
    }
});

test('a completion signal cannot hide a dangling final dialogue', async () => {
    const draft = '그는 속삭였다. “';
    const api = await loadRefine([`${body}${draft}\n${marker(1)}`, `${draft}돌아왔구나.”\n${marker(1)}`]);
    const result = await api.refineNovelTextInChapters(options);
    assert.equal(api.calls.length, 2);
    assert.ok(result.fullText.endsWith('그는 속삭였다. “돌아왔구나.”'));
});

test('a short repeated resume anchor preserves the exact middle of a word', async () => {
    const api = await loadRefine([`${body}그는 돌아왔`, `그는 돌아왔다.\n${marker(1)}`]);
    const result = await api.refineNovelTextInChapters(options);
    assert.equal(api.calls.length, 2);
    assert.ok(result.fullText.endsWith('그는 돌아왔다.'));
    assert.doesNotMatch(result.fullText, /돌아왔 다|돌아왔 그는/);
});

test('the final channel snapshot is used even if it arrives after invoke resolves', async () => {
    const api = await loadRefine([channel => {
        channel.onmessage({ content: `${body}앞 문장.`, is_finished: false });
        setTimeout(() => channel.onmessage({ content: `${body}앞 문장. 마지막 문장까지 도착했다.\n${marker(1)}`, is_finished: true }), 0);
    }]);
    const result = await api.refineNovelTextInChapters(options);
    assert.ok(result.fullText.endsWith('마지막 문장까지 도착했다.'));
    assert.ok(api.saves.every(save => save.textContent.endsWith('마지막 문장까지 도착했다.')));
});

test('a misplaced completion signal does not discard the last sentence after it', async () => {
    for (const finalSignal of ['', `\n${marker(1)}`]) {
        const api = await loadRefine([`${body}\n${marker(1)}\n그는 편지를 들고 집으로 돌아왔다.${finalSignal}`]);
        const result = await api.refineNovelTextInChapters(options);
        assert.ok(result.fullText.endsWith('그는 편지를 들고 집으로 돌아왔다.'));
        assert.doesNotMatch(result.fullText, /<<<NOVEL_REFINE/);
        assert.equal(api.calls.length, 1);
    }
});

test('ambiguous continuation boundaries repair the final paragraph instead of corrupting the last word', async () => {
    const api = await loadRefine([`${body}그는 돌아왔`, `다.\n${marker(1)}`, '그는 돌아왔다.']);
    const result = await api.refineNovelTextInChapters(options);
    assert.equal(api.calls.length, 3);
    assert.ok(result.fullText.endsWith('그는 돌아왔다.'));
    assert.doesNotMatch(result.fullText, /돌아왔 다/);
});

test('missing final channel delivery does not save an earlier complete-looking preview', async () => {
    const api = await loadRefine([channel => {
        channel.onmessage({ content: `${body}앞 문장.`, is_finished: false });
    }]);
    await assert.rejects(api.refineNovelTextInChapters(options), /without its final snapshot/);
    assert.equal(api.saves.length, 0);
    assert.equal(api.calls.length, 1);
});

test('normal apostrophes and multi-paragraph dialogue do not trigger false ending recovery', async () => {
    for (const ending of [
        '“처음 하는 말이야.\n\n“그리고 마지막 말이기도 해.”',
        '"First I opened the letter.\n\n"Then I came home."',
        'She couldn’t forget the letter. It wasn’t hers.',
    ]) {
        const api = await loadRefine([`${body}${ending}\n${marker(1)}`]);
        const result = await api.refineNovelTextInChapters(options);
        assert.equal(api.calls.length, 1);
        assert.ok(result.fullText.endsWith(ending));
    }
});

test('normal sentence punctuation completes the chapter regardless of earlier delimiter mismatches or missing signals', async () => {
    for (const ending of [
        '그는 “편지”라는 단어와 (표식을 보았다.\n\n그는 집으로 돌아왔다.',
        '그는 속삭였다. “돌아왔구나.',
        'She read the 6" label (then left. She was finally home.',
        '그는 돌아왔다.”',
        '彼は帰ってきた。」',
        '**그는 집으로 돌아왔다.**',
    ]) {
        const api = await loadRefine([`${body}${ending}`]);
        const result = await api.refineNovelTextInChapters(options);
        assert.equal(api.calls.length, 1);
        assert.ok(result.fullText.endsWith(ending));
        assert.ok(!api.statuses.some(item => item.message.includes('Completing chapter')));
    }
});

test('a completion-only continuation confirms an intentional unpunctuated ending without a no-new-text error', async () => {
    for (const confirmation of [marker(1), `그리고 마침내, 새벽\n${marker(1)}`]) {
        const draft = `${body}그리고 마침내, 새벽`;
        const api = await loadRefine([draft, confirmation]);
        const result = await api.refineNovelTextInChapters(options);
        assert.equal(api.calls.length, 2);
        assert.ok(result.fullText.endsWith('그리고 마침내, 새벽'));
        assert.equal(result.fullText.split('그리고 마침내, 새벽').length - 1, 1);
        assert.doesNotMatch(result.fullText, /<<<NOVEL_REFINE/);
    }
});

test('a genuinely unfinished ending that cannot be repaired remains bounded and preserves the original', async () => {
    const draft = `${body}그는 아직`;
    const api = await loadRefine([draft, draft, '그는 아직']);
    await assert.rejects(api.refineNovelTextInChapters(options), /still incomplete after 2 ending continuations/);
    assert.equal(api.calls.length, 3);
    assert.equal(api.saves.length, 0);
    assert.ok(api.previews.at(-1).endsWith('그는 편지를 들고 집으로 돌아왔다.'));
});
