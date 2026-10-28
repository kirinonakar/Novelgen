import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { parseSync, transformWithOxc } from 'vite';

// Run the actual chapter loop, previews, and saves against simulated Tauri streams.
const sources = await Promise.all(['novel_refine', 'text_utils', 'novel_auto', 'novel_instructions'].map(async name =>
    (await transformWithOxc(await readFile(new URL(`../src/modules/${name}.ts`, import.meta.url), 'utf8'), `${name}.ts`, {
        target: 'es2022',
    })).code));

async function loadRefine(responses, { autoInstructions = '1. Dialogue -> Clarify the reply -> [LOCAL]', metadata, savedMetadata } = {}) {
    const context = createContext({ console: { ...console, error() {} }, TextEncoder, setTimeout, clearTimeout });
    const session = {
        loadedNovelFilename: 'test.txt',
        loadedNovelMetadata: metadata,
        setLoadedNovel(filename, metadata) { this.loadedNovelFilename = filename; this.loadedNovelMetadata = metadata; },
    };
    const calls = [], saves = [], statuses = [], previews = [];
    const utilities = new SourceTextModule(sources[1], { context });
    const instructions = new SourceTextModule(sources[3], { context });
    const stubs = {
        '../services/runtimeSessionStateService.js': { runtimeSessionState: session },
        './novel_auto.js': { generateInstructionForChapter: async () => {
            if (typeof autoInstructions === 'function') return autoInstructions();
            return autoInstructions;
        } },
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
                if (command === 'save_novel_state') {
                    saves.push(args);
                    return savedMetadata || JSON.parse(args.metadataJson);
                }
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
        if (specifier === './novel_instructions.js') return instructions;
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

test('NO_CHANGES skips all rewrite requests and preserves the exact source including spacing', async () => {
    const api = await loadRefine([], { autoInstructions: 'NO_CHANGES' });
    const originalNovel = '  ' + options.originalNovel + '\r\n\r\n';
    const finished = [];
    const result = await api.refineNovelTextInChapters({
        ...options, originalNovel, autoInstructionsPerChapter: true, apiParams: {},
        onChapterFinished: n => finished.push(n),
    });
    assert.equal(api.calls.length, 0);
    assert.equal(result.fullText, originalNovel);
    assert.equal(api.saves.at(-1).textContent, originalNovel);
    assert.deepEqual(finished, [1]);
    assert.ok(api.statuses.some(item => item.message.includes('unchanged')));
});

test('mixed auto review keeps an approved chapter and limits the other rewrite to listed corrections', async () => {
    const verdicts = ['NO_CHANGES', '1. Ending -> Clarify the reply -> [LOCAL]'];
    const originalNovel = 'Chapter 1\n\nKeep this dialogue exactly.\n\nChapter 2\n\nShe answered.';
    const api = await loadRefine(['She answered clearly.'], { autoInstructions: () => verdicts.shift() });
    const result = await api.refineNovelTextInChapters({
        originalNovel, plotOutline: 'Chapter 1\nDialogue.\nChapter 2\nReply.',
        lang: 'English', totalChapters: 2, autoInstructionsPerChapter: true, apiParams: {},
    });
    assert.equal(api.calls.length, 1);
    assert.match(result.fullText, /Keep this dialogue exactly\./);
    assert.match(result.fullText, /She answered clearly\./);
    assert.match(api.calls[0].prompt, /Copy all unaffected passages verbatim/);
    assert.doesNotMatch(api.calls[0].prompt, /Perform these passes|10~20% longer|REPEATED EMOTION STRUCTURE PASS/);
});

test('an explicit no-change verdict from single-chapter Auto Instructions also skips manual refine', async () => {
    const api = await loadRefine([]);
    const result = await api.refineNovelTextInChapters({ ...options, userInstructions: 'NO_CHANGES' });
    assert.equal(api.calls.length, 0);
    assert.equal(result.fullText, options.originalNovel);
});

test('failed automatic review never falls back to an unrequested general rewrite', async () => {
    const api = await loadRefine([], { autoInstructions: () => { throw new Error('Provider unavailable'); } });
    await assert.rejects(api.refineNovelTextInChapters({
        ...options, autoInstructionsPerChapter: true, apiParams: {},
    }), /Auto review failed for chapter 1.*Provider unavailable/);
    assert.equal(api.calls.length, 0);
    assert.equal(api.saves.length, 0);
    assert.equal(api.previews.at(-1), options.originalNovel);
});

test('refine forwards existing memory and keeps the backend-validated metadata for subsequent saves', async () => {
    const metadata = { story_state: 'Earlier story', character_state: 'Earlier people',
        needs_memory_rebuild: false, memory_snapshots: [{ chapter: 1, prefix_hash: 'saved' }] };
    const savedMetadata = { ...metadata, needs_memory_rebuild: true, memory_rebuild_from_chapter: 2 };
    const api = await loadRefine(['He returned home.'], { metadata, savedMetadata });
    await api.refineNovelTextInChapters(options);
    const sent = JSON.parse(api.saves[0].metadataJson);
    assert.equal(sent.story_state, metadata.story_state);
    assert.equal(sent.character_state, metadata.character_state);
    assert.deepEqual(sent.memory_snapshots, metadata.memory_snapshots);
    assert.equal(api.session.loadedNovelMetadata, savedMetadata);
    assert.equal(JSON.parse(api.saves.at(-1).metadataJson).memory_rebuild_from_chapter, 2);
});

async function loadAuto(result = '') {
    const context = createContext({});
    const module = new SourceTextModule(sources[2], { context });
    await module.link(() => new SyntheticModule(['invoke'], function () {
        this.setExport('invoke', async () => result);
    }, { context }));
    await module.evaluate();
    return module.namespace;
}

test('auto review accepts zero or a variable number of corrections, caps oversized lists, and rejects empty responses', async () => {
    const api = await loadAuto();
    assert.equal(api.normalizeNovelAutoInstructions(' NO_CHANGES\r\n'), 'NO_CHANGES');
    assert.equal(api.normalizeNovelAutoInstructions('1. Opening -> Keep this scene -> [PRESERVE]'), 'NO_CHANGES');
    const one = '1. Opening -> Clarify the motive -> [MICRO]';
    assert.equal(api.normalizeNovelAutoInstructions(one), one);
    assert.throws(() => api.normalizeNovelAutoInstructions('  '), /empty output/);
    assert.equal(api.normalizeNovelAutoInstructions('도입부의 중복 설명을 줄인다.'), '1. 도입부의 중복 설명을 줄인다. -> [LOCAL]');
    const twelve = Array.from({ length: 12 }, (_, i) => `${i + 1}. Dialogue -> Clarify this reply -> [LOCAL]`).join('\n');
    assert.equal(api.normalizeNovelAutoInstructions(twelve), twelve);
    assert.equal(api.normalizeNovelAutoInstructions(twelve + '\n13. Ending -> Expand -> [LOCAL]'), twelve);
    const prompt = api.buildNovelAutoInstructionPrompt({ lang: 'Korean' });
    assert.match(prompt, /Generate 0 to 12/);
    assert.match(prompt, /NO_CHANGES/);
    assert.doesNotMatch(prompt, /exactly 12|remaining slots/);
});

test('Markdown, indentation, bullet lists, and scope explanations do not fail automatic instruction generation', async () => {
    const cases = [
        'Here are the instructions:\n  1. Opening -> Clarify the motive -> [LOCAL]\n  2. Ending -> Remove repetition -> [MICRO]',
        '```markdown\n## Refinement Instructions\n**1. Opening** -> Clarify the motive -> **[LOCAL]**\n\n**2. Ending** -> Remove repetition -> [MICRO]\n```',
        '- Opening -> Clarify the motive -> [local]\n- Ending -> Remove repetition -> [micro]',
        '(1) Opening -> Clarify the motive -> [LOCAL]\n(2) Ending -> Remove repetition -> [MICRO]',
        '１．Opening -> Clarify the motive -> [LOCAL]\n２．Ending -> Remove repetition -> [MICRO]',
        '1. Opening -> Clarify the motive -> [LOCAL] (one sentence only)\n2. Ending -> Remove repetition -> [MICRO]\nKeep the final event intact.',
        '1. Opening -> Clarify the motive\n2. Ending -> Remove repetition',
        'Opening -> Clarify the motive -> [LOCAL]\nEnding -> Remove repetition -> [MICRO]',
    ];
    for (const response of cases) {
        const api = await loadAuto(response);
        const instructions = await api.generateInstructionForChapter({ lang: 'English', apiParams: {} });
        assert.match(instructions, /^1\. .*Clarify the motive/m, response);
        assert.match(instructions, /^2\. .*Remove repetition/m, response);
        assert.match(instructions, /\[(?:LOCAL|MICRO)\]$/);
        assert.doesNotMatch(instructions, /```|Here are the instructions|Refinement Instructions/);
    }
});

test('formatted no-change and preserve-only reviews remain no-op verdicts', async () => {
    const api = await loadAuto();
    for (const response of [
        '```text\nNO_CHANGES\n```', '**NO_CHANGES**', 'no_changes.',
        '## Refinement Instructions\nNO_CHANGES', '수정할 사항이 없습니다.',
        '- Opening -> Keep the dialogue -> **[preserve]**',
    ]) {
        assert.equal(api.normalizeNovelAutoInstructions(response), 'NO_CHANGES', response);
    }
    assert.notEqual(api.normalizeNovelAutoInstructions('1. Preserve the opening, but fix the final reply -> [LOCAL]'), 'NO_CHANGES');
    assert.notEqual(api.normalizeNovelAutoInstructions('Opening -> Fix the motive -> [LOCAL]\nEnding -> Keep intact -> [PRESERVE]'), 'NO_CHANGES');
    assert.notEqual(api.normalizeNovelAutoInstructions('Opening [LOCAL]: Fix the motive.\nEnding [PRESERVE]: Keep intact.'), 'NO_CHANGES');
    assert.throws(() => api.normalizeNovelAutoInstructions('```text\n\n```'), /empty output/);
});

test('last refinement stores only changed chapter numbers and both manuscript versions in metadata JSON', async () => {
    const originalNovel = 'Chapter 1\n\nFirst stays.\n\nChapter 2\n\nSecond original.\n\nChapter 3\n\nThird stays.';
    const api = await loadRefine(['Second revised.']);
    const result = await api.refineNovelTextInChapters({ originalNovel,
        plotOutline: 'Chapter 1\nFirst.\nChapter 2\nSecond.\nChapter 3\nThird.',
        lang: 'English', totalChapters: 3, chapterRange: { start: 2, end: 2 },
    });
    const save = api.saves.at(-1);
    const revision = JSON.parse(save.metadataJson).last_refinement;
    assert.equal(revision.before_text, originalNovel);
    assert.equal(revision.after_text, result.fullText);
    assert.deepEqual(revision.chapter_numbers, [2]);
    assert.equal(save.textContent, result.fullText);
    assert.doesNotMatch(save.textContent, /before_text|after_text|chapter_numbers|last_refinement/);
});

async function autoRangeHarness({ count = 5, start = '', end = '', responses = [], onReview } = {}) {
    const parser = await loadRefine([]);
    const editor = {
        novel: Array.from({ length: count }, (_, i) => `Chapter ${i + 1}\n\nOriginal body ${i + 1}.`).join('\n\n'),
        plot: Array.from({ length: count }, (_, i) => `Chapter ${i + 1}\nGoal ${i + 1}.`).join('\n\n'),
        novelRefineStartChapter: start, novelRefineEndChapter: end,
    };
    const calls = [], toasts = [], statuses = [];
    const view = { editor, activity: {}, refineInstructions: { novel: 'Keep previous instructions.' },
        apiSettings: { provider: 'LM Studio', apiBase: 'http://local/v1', apiKey: '', modelName: 'test', thinkingLevel: 'default' } };
    const context = createContext({ console: { ...console, error() {} } });
    const scoped = new SourceTextModule(sources[3], { context });
    await scoped.link(() => {}); await scoped.evaluate();
    let saves = 0;
    const overrides = {
        '../modules/novel_instructions.js': scoped.namespace,
        '../modules/novel_refine.js': { ...parser },
        '../modules/novel_auto.js': { generateInstructionForChapter: async params => {
            calls.push(params);
            if (onReview) await onReview({ editor, view, calls });
            const response = responses[calls.length - 1];
            if (response instanceof Error) throw response;
            return response || 'NO_CHANGES';
        } },
        '../modules/toast.js': { showToast: (message, type) => toasts.push({ message, type }) },
        './runtimeSessionStateService.js': { runtimeSessionState: { isWorkerRunning: false, isNovelRefining: false } },
        './runtimeEditorStateService.js': {
            getEditorSnapshot: () => editor, setNovelStatus: (message, state) => statuses.push({ message, state }),
            setNovelRefineChapterRange: update => {
                if (update.end !== undefined) editor.novelRefineEndChapter = String(update.end);
            },
        },
        './runtimeViewStateStore.js': { runtimeViewStateStore: {
            getSnapshot: () => view,
            setActivity: update => Object.assign(view.activity, update),
            setRefineInstructions: update => Object.assign(view.refineInstructions, update),
        } },
    };
    const source = (await transformWithOxc(await readFile(new URL('../src/services/runtimeWorkflowActionsService.ts', import.meta.url), 'utf8'), 'workflow.ts', { target: 'es2022' })).code;
    const imports = new Map(parseSync('workflow.js', source).program.body.filter(node => node.type === 'ImportDeclaration').map(node => [
        node.source.value, Object.fromEntries(node.specifiers.map(item => [item.imported?.name ?? 'default', () => {}])),
    ]));
    const module = new SourceTextModule(source, { context });
    await module.link(specifier => {
        const values = { ...imports.get(specifier), ...overrides[specifier] };
        return new SyntheticModule(Object.keys(values), function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context });
    });
    await module.evaluate();
    const actions = module.namespace.createRuntimeWorkflowActions({ getLang: () => 'English', getProvider: () => 'LM Studio', saveSettings: async () => { saves++; } });
    return { editor, view, actions, calls, toasts, statuses, saves: () => saves, scoped: scoped.namespace };
}

test('Auto Instructions with a blank range analyzes all five chapters and keeps each adjacent context', async () => {
    const api = await autoRangeHarness();
    await api.actions.onAutoNovelInstructions();
    assert.equal(api.calls.length, 5);
    assert.equal(api.calls[0].prevChapterText, 'None.');
    assert.equal(api.calls[0].nextChapterText, 'Original body 2.');
    assert.equal(api.calls[2].prevChapterText, 'Original body 2.');
    assert.equal(api.calls[2].nextChapterText, 'Original body 4.');
    assert.equal(api.calls[4].nextChapterText, 'None.');
    const parsed = api.scoped.parseChapterRefineInstructions(api.view.refineInstructions.novel);
    assert.equal(parsed.chapters.size, 5);
    assert.equal(api.scoped.instructionsForChapter(parsed, 2), 'NO_CHANGES');
    assert.equal(api.saves(), 1);
    assert.ok(api.statuses.some(status => status.message.includes('(5/5)')));
    assert.equal(api.view.activity.isAutoNovelInstructionsRunning, false);
});

test('Auto Instructions rejects more than five chapters before any request and supports a five-chapter subrange', async () => {
    const tooMany = await autoRangeHarness({ count: 6 });
    await tooMany.actions.onAutoNovelInstructions();
    assert.equal(tooMany.calls.length, 0);
    assert.equal(tooMany.view.refineInstructions.novel, 'Keep previous instructions.');
    assert.match(tooMany.toasts.at(-1).message, /up to 5 chapters/);
    const selected = await autoRangeHarness({ count: 7, start: '2', end: '6' });
    await selected.actions.onAutoNovelInstructions();
    assert.equal(selected.calls.length, 5);
    assert.equal(selected.calls[0].prevChapterText, 'Original body 1.');
    assert.equal(selected.calls[4].nextChapterText, 'Original body 7.');
});

test('Auto Instructions respects start-only, end-only, full-width and reversed ranges', async () => {
    for (const [start, end, expected] of [
        ['4', '', [4, 5]], ['', '3', [1, 2, 3]], ['２', '４', [2, 3, 4]], ['4', '2', [4]], ['2', '2', [2]],
    ]) {
        const api = await autoRangeHarness({ start, end });
        await api.actions.onAutoNovelInstructions();
        assert.deepEqual(api.calls.map(call => Number(call.currentChapterText.match(/\d+/)[0])), expected);
        if (start === '4' && end === '') assert.equal(api.editor.novelRefineEndChapter, '');
    }
});

test('multi-chapter instructions refine only their matching chapter and preserve unreviewed or approved chapters', async () => {
    const api = await autoRangeHarness({ start: '2', end: '3', responses: [
        'NO_CHANGES', '1. Third ending -> Clarify only the third reply -> [LOCAL]',
    ] });
    await api.actions.onAutoNovelInstructions();
    const refine = await loadRefine(['Revised third body.']);
    const result = await refine.refineNovelTextInChapters({ originalNovel: api.editor.novel, plotOutline: api.editor.plot,
        lang: 'English', totalChapters: 5, userInstructions: api.view.refineInstructions.novel,
    });
    assert.equal(refine.calls.length, 1);
    assert.match(refine.calls[0].prompt, /Clarify only the third reply/);
    assert.match(result.fullText, /Original body 2\./);
    assert.match(result.fullText, /Revised third body\./);
    assert.match(result.fullText, /Original body 4\./);
    assert.deepEqual(JSON.parse(refine.saves.at(-1).metadataJson).last_refinement.chapter_numbers, [3]);
});

test('failed or stale multi-chapter reviews keep existing instructions instead of publishing partial results', async () => {
    const failed = await autoRangeHarness({ responses: ['NO_CHANGES', new Error('Provider unavailable')] });
    await failed.actions.onAutoNovelInstructions();
    assert.equal(failed.calls.length, 2);
    assert.equal(failed.view.refineInstructions.novel, 'Keep previous instructions.');
    assert.equal(failed.saves(), 0);
    assert.equal(failed.view.activity.isAutoNovelInstructionsRunning, false);
    const stale = await autoRangeHarness({ onReview: ({ editor }) => { editor.novel += ' Manual edit.'; } });
    await stale.actions.onAutoNovelInstructions();
    assert.equal(stale.calls.length, 1);
    assert.equal(stale.view.refineInstructions.novel, 'Keep previous instructions.');
    assert.match(stale.toasts.at(-1).message, /changed during analysis/);
});
