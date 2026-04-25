import { AppState } from './app_state.js';
import { els } from './dom_refs.js';
import { renderMarkdown, schedulePreviewRender } from './preview.js';
import { Channel, invoke } from './tauri_api.js';
import { showToast } from './toast.js';
import { estimateTokenCount, splitPlotIntoChapters } from './text_utils.js';

const FULL_PLOT_CONTEXT_CHARS = 24000;
const PREVIOUS_CONTEXT_CHARS = 2600;
const NEXT_CONTEXT_CHARS = 1600;
const MAX_REFINE_OUTPUT_TOKENS = 16384;

function normalizeDigits(value) {
    return String(value || '').replace(/[０-９]/g, ch =>
        String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    );
}

function parseChapterNumber(value) {
    const parsed = parseInt(normalizeDigits(value), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function chapterHeadingRegex(lang) {
    if (lang === 'Korean') {
        return /^[ \t#>*-]*(?:\*\*)?(?:제\s*)?([0-9０-９]+)\s*장(?:[^\r\n]*)/gim;
    }
    if (lang === 'Japanese') {
        return /^[ \t#>*-]*(?:\*\*)?第?\s*([0-9０-９]+)\s*章(?:[^\r\n]*)/gim;
    }
    return /^[ \t#>*-]*(?:\*\*)?Chapter\s*([0-9０-９]+)(?:[^\r\n]*)/gim;
}

function splitNovelIntoChapterBlocks(text, lang, { fallbackToWhole = true } = {}) {
    const source = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!source) {
        return { intro: '', chapters: [] };
    }

    const matches = [...source.matchAll(chapterHeadingRegex(lang))];
    if (matches.length === 0) {
        return {
            intro: fallbackToWhole ? '' : source,
            chapters: fallbackToWhole
                ? [{ number: 1, header: '', body: source }]
                : [],
        };
    }

    const intro = source.slice(0, matches[0].index).trim();
    const chapters = [];

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const number = parseChapterNumber(match[1]);
        if (!number) continue;

        const headerStart = match.index;
        const bodyStart = headerStart + match[0].length;
        const end = matches[i + 1]?.index ?? source.length;
        chapters.push({
            number,
            header: match[0].trim(),
            body: source.slice(bodyStart, end).trim(),
        });
    }

    return { intro, chapters };
}

function assembleNovel(intro, chapters) {
    const blocks = [];
    const cleanIntro = String(intro || '').trim();
    if (cleanIntro) blocks.push(cleanIntro);

    for (const chapter of chapters) {
        const header = String(chapter.header || '').trim();
        const body = String(chapter.body || '').trim();
        const block = header ? `${header}\n\n${body}`.trim() : body;
        if (block) blocks.push(block);
    }

    return blocks.join('\n\n').trimEnd();
}

function takeHead(text, maxChars) {
    const chars = Array.from(String(text || ''));
    if (chars.length <= maxChars) return String(text || '');
    return `${chars.slice(0, maxChars).join('')}\n[...]`;
}

function takeTail(text, maxChars) {
    const chars = Array.from(String(text || ''));
    if (chars.length <= maxChars) return String(text || '');
    return `[...]${chars.slice(-maxChars).join('')}`;
}

function trimMiddleForPrompt(text, maxChars) {
    const chars = Array.from(String(text || ''));
    if (chars.length <= maxChars) return String(text || '');

    const half = Math.floor((maxChars - 80) / 2);
    return [
        chars.slice(0, half).join(''),
        '[...middle of full plot omitted for context size...]',
        chars.slice(-half).join(''),
    ].join('\n\n');
}

function outputOnlyRule(lang) {
    if (lang === 'Korean') {
        return '수정된 현재 장 본문만 출력한다. 장 제목, 진단, 수정 방향, 설명, 코드펜스, 인사말은 절대 출력하지 않는다.';
    }
    if (lang === 'Japanese') {
        return '修正済みの現在章本文だけを出力する。章見出し、診断、修正方針、説明、コードフェンス、挨拶は出力しない。';
    }
    return 'Output only the revised current chapter body. Do not output the chapter heading, diagnosis, revision notes, explanations, code fences, or greetings.';
}

function overstatementGuide(lang) {
    if (lang === 'Korean') {
        return '현재 원고 안에서 반복되는 추상적 감탄, 과장된 규모감, 직접적인 의미 해설, 인물의 과도한 경외 표현을 줄이고 행동, 감각, 침묵, 구체적 결과로 대체한다.';
    }
    if (lang === 'Japanese') {
        return '現在の原稿内で繰り返される抽象的な賛嘆、過度なスケール感、直接的な意味説明、人物による過剰な崇拝表現を減らし、行動・感覚・沈黙・具体的な結果に置き換える。';
    }
    return 'Reduce repeated abstract awe, inflated scale, direct explanation of meaning, and excessive admiration of any character; replace them with action, sensory detail, silence, and concrete consequences.';
}

function emotionalRepetitionGuide(lang) {
    if (lang === 'Korean') {
        return `- 장면 기능 개선을 목표로 한다.
- 원고의 언어와 장르 안에서 반복되는 감정 장치, 예를 들어 침묵/정적, 온기/차가움, 위태로움/흔들림, 닿고 싶은 충동, 손을 뻗다 멈추는 동작처럼 같은 역할을 하는 표현군을 찾아 줄인다.
- 같은 감정을 반복 설명하지 말고, 각 장면마다 관계가 아주 조금씩 진전되게 한다.
- 추상적인 결론 문장보다 구체적인 행동, 물건, 시선, 호흡, 거리 변화로 마무리한다.
- 전체 플롯과 분위기는 유지하되, 장면마다 감정의 변화값을 더 선명하게 만든다.`;
    }
    if (lang === 'Japanese') {
        return `- 場面機能の改善を目的にする。
- 原稿の言語とジャンル内で繰り返される感情装置、たとえば沈黙/静けさ、温もり/冷たさ、危うさ/揺らぎ、触れたい衝動、手を伸ばしかけて止める動作のように同じ役割を果たす表現群を見つけて減らす。
- 同じ感情を説明し直すのではなく、各場面で関係が少しずつ進むようにする。
- 抽象的な結論文より、具体的な行動、物、視線、呼吸、距離の変化で場面を閉じる。
- 全体のプロットと雰囲気は維持しつつ、場面ごとの感情の変化量をより明確にする。`;
    }
    return `- Improve scene function, not just wording.
- Identify and reduce repeated emotional devices within the manuscript's language and genre, such as silence/stillness, warmth/coldness, fragility/instability, the impulse to touch, or reaching out and stopping when those expressions serve the same emotional function.
- Do not explain the same feeling again; make the relationship move forward by a small but visible degree in each scene.
- End scenes with concrete action, an object, gaze, breath, or a change in physical distance rather than an abstract concluding sentence.
- Preserve the overall plot and atmosphere, but make the emotional change value of each scene clearer.`;
}

function characterVoiceGuide(lang) {
    if (lang === 'Korean') {
        return `- 새 인물이나 새 설정을 임의로 추가하지 않는다.
- 현재 원고와 플롯에서 각 인물의 욕망, 두려움, 판단 기준, 사회적 위치, 관계 긴장을 추론한다.
- 모든 인물이 같은 방식으로 감탄하거나 해설하지 않게 한다.
- 대사는 인물의 목적, 정보 격차, 숨기는 감정, 관계의 힘 차이를 드러내게 한다.
- 주인공의 반응도 장르 역할에만 묶지 말고 관찰, 오판, 망설임, 계산, 피로 같은 인간적인 결을 허용한다.`;
    }
    if (lang === 'Japanese') {
        return `- 新しい人物や新設定を勝手に追加しない。
- 現在の原稿とプロットから、各人物の欲望、恐れ、判断基準、社会的位置、関係の緊張を推定する。
- すべての人物が同じ口調で感嘆したり説明したりしないようにする。
- 台詞は人物の目的、情報差、隠した感情、関係上の力の差を表すようにする。
- 主人公の反応にも、観察、誤判断、ためらい、計算、疲労など人間的な揺れを許す。`;
    }
    return `- Do not invent new characters or new setting rules.
- Infer each character's desire, fear, judgment criteria, social position, and relationship tension from the current manuscript and plot.
- Do not let every character admire, explain, or react in the same way.
- Dialogue should reveal purpose, information gaps, concealed emotion, and power dynamics.
- Give the protagonist human texture through observation, misjudgment, hesitation, calculation, fatigue, or restraint when appropriate.`;
}

function buildAdjacentPlotContext(plotChapters, chapterNumber) {
    const previous = plotChapters[chapterNumber - 1];
    const next = plotChapters[chapterNumber + 1];
    return [
        previous ? `[Previous Chapter Plot]\n${previous}` : '',
        next ? `[Next Chapter Plot]\n${next}` : '',
    ].filter(Boolean).join('\n\n') || 'None.';
}

function buildNovelRefinePrompt({
    lang,
    totalChapters,
    plotOutline,
    plotChapters,
    chapter,
    chapterIndex,
    chapterCount,
    previousRefinedContext,
    nextOriginalContext,
    userInstructions,
}) {
    const currentChapterPlot = plotChapters[chapter.number] || 'No exact chapter plot was found. Infer the chapter goal from the full plot outline and adjacent chapters.';
    const adjacentPlotContext = buildAdjacentPlotContext(plotChapters, chapter.number);

    return `You are a professional fiction developmental editor and line editor. Refine one chapter of an existing ${totalChapters}-chapter novel in ${lang}.

Perform these passes internally, in order:
1. Plot comparison: keep the original plot goal and event order, and make cause-action-result clearer.
2. Scene function check: make each scene earn its place through setup, pressure, choice, payoff/reversal, or hook.
3. Character emotion/conflict: add concrete inner movement, small costs, unease, choices, and non-repeating emotional progression where the chapter resolves too easily.
4. Style cleanup: ${overstatementGuide(lang)}
5. Character voice pass: separate speech, judgment criteria, and desire by character.
6. Connection check: strengthen the final hook without changing the next chapter's required direction.

REFINE GOALS:
- Preserve the current chapter's core events, continuity, named characters, world rules, and ending direction.
- Do not rewrite the plot from scratch.
- Keep the revised body close to the original length, or only 10-20% longer when scenes are compressed.
- Prefer specific observable reactions over broad generalized reactions.
- Let readers feel meaning through scene results instead of explanatory commentary.
- Vary sentence length; after a long description, place a short reaction or consequence.
- ${outputOnlyRule(lang)}

REPEATED EMOTION STRUCTURE PASS:
${emotionalRepetitionGuide(lang)}

CHARACTER VOICE GUIDE:
${characterVoiceGuide(lang)}

[Full Plot Outline - continuity reference, may be trimmed]
${trimMiddleForPrompt(plotOutline, FULL_PLOT_CONTEXT_CHARS)}

[Current Chapter]
Chapter number: ${chapter.number}
Progress: ${chapterIndex + 1}/${chapterCount}

[Current Chapter Plot Goal]
${currentChapterPlot}

[Adjacent Plot Context]
${adjacentPlotContext}

[Novel Refine Instructions]
${userInstructions || 'None.'}

[Previous Refined Context - continuity only, do not rewrite]
${previousRefinedContext || 'None.'}

[Next Original Chapter Opening - boundary only, do not rewrite]
${nextOriginalContext || 'None.'}

[Original Current Chapter Body - refine this only]
${chapter.body}`;
}

function stripCodeFence(text) {
    const trimmed = String(text || '').trim();
    const fence = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    return fence ? fence[1].trim() : trimmed;
}

function stripManuscriptLabel(text) {
    const lines = String(text || '').trim().split(/\r?\n/);
    const labelPattern = /^\s*(?:수정\s*원고|수정본|개정\s*원고|Refined\s*(?:Chapter|Draft|Manuscript)?|Revised\s*(?:Chapter|Draft|Manuscript)?|改稿|修正文|本文)\s*[:：-]?\s*/i;
    const markerIndex = lines.findIndex(line => labelPattern.test(line.trim()));

    if (markerIndex >= 0) {
        const sameLineRemainder = lines[markerIndex].replace(labelPattern, '').trim();
        const rest = lines.slice(markerIndex + 1);
        return [sameLineRemainder, ...rest].filter(Boolean).join('\n').trim();
    }

    return lines.join('\n').trim();
}

function sanitizeRefinedChapterBody(rawOutput, chapterNumber, lang) {
    let text = stripManuscriptLabel(stripCodeFence(rawOutput));
    const split = splitNovelIntoChapterBlocks(text, lang, { fallbackToWhole: false });

    if (split.chapters.length > 0) {
        const current = split.chapters.find(chapter => chapter.number === chapterNumber) || split.chapters[0];
        text = current.body || text;
    }

    return stripManuscriptLabel(stripCodeFence(text)).trim();
}

function withApiHint(message) {
    let msg = String(message || 'Unknown API error');
    if (msg.includes('401')) msg += '\n\n[Hint] Unauthorized. Check your API key.';
    else if (msg.includes('403')) msg += '\n\n[Hint] Forbidden. This might be a safety filter block or permission issue.';
    else if (msg.includes('429')) msg += '\n\n[Hint] Quota exceeded. Wait a moment or check your billing.';
    else if (msg.includes('Failed to parse input at pos 0')) {
        msg += '\n\n[Hint] Model mismatch detected. Ensure LM Studio chat template is correctly set for models like Gemma 4.';
    }
    return msg;
}

function maxTokensForChapter(chapterBody, targetTokens) {
    const chapterTokens = estimateTokenCount(chapterBody);
    const target = parseInt(targetTokens, 10) || 2000;
    return Math.min(
        MAX_REFINE_OUTPUT_TOKENS,
        Math.max(2048, Math.ceil(chapterTokens * 1.9), target + 1200),
    );
}

async function generateRefinedChapter(prompt, {
    maxTokens,
    statusText,
    onDelta,
}) {
    let latestContent = '';
    let streamError = null;
    const onEvent = new Channel();

    onEvent.onmessage = (event) => {
        if (AppState.stopRequested && !event.is_finished && !event.error) return;

        latestContent = event.content || latestContent;
        onDelta?.(latestContent, event);

        if (event.error) {
            streamError = withApiHint(event.error);
        }
    };

    els.novelStatus.innerText = statusText;
    await invoke('generate_plot', {
        params: {
            api_base: els.apiBase.value,
            model_name: els.modelName.value,
            api_key: els.apiKeyBox.value || 'lm-studio',
            system_prompt: els.promptBox.value,
            prompt,
            temperature: parseFloat(els.temp.value),
            top_p: parseFloat(els.topP.value),
            repetition_penalty: parseFloat(els.repetitionPenalty.value),
            max_tokens: maxTokens,
        },
        onEvent,
    });

    if (streamError) {
        throw new Error(streamError);
    }

    return latestContent.trim();
}

function setNovelRefineBusy(isBusy) {
    [
        els.btnGenNovel,
        els.btnRefineNovel,
        els.btnClearNovel,
        els.btnLoadNovel,
        els.btnRefreshNovels,
    ].forEach(element => {
        if (element) element.disabled = isBusy;
    });
}

function updateNovelOutput(text, event = null) {
    els.novelContent.value = text;
    schedulePreviewRender(els.novelContent.id, {
        source: 'stream',
        force: event?.is_finished || Boolean(event?.error),
        immediate: event?.is_finished || Boolean(event?.error),
    });
}

function latestChapterNumber(chapters) {
    return chapters
        .map(chapter => chapter.number)
        .filter(Number.isFinite)
        .reduce((max, chapterNumber) => Math.max(max, chapterNumber), 0);
}

async function saveRefinedNovelState({ finalText, lang, chapters, plotOutline }) {
    let filename = AppState.loadedNovelFilename;
    if (!filename) {
        filename = await invoke('get_next_novel_filename');
    }

    const totalChapters = parseInt(els.numChap.value, 10) || chapters.length || 1;
    const currentChapter = Math.min(latestChapterNumber(chapters) || chapters.length || 1, totalChapters);
    const metadata = {
        ...(AppState.loadedNovelMetadata || {}),
        title: AppState.loadedNovelMetadata?.title || 'Novel',
        language: lang,
        num_chapters: totalChapters,
        target_tokens: parseInt(els.targetTokens.value, 10) || 0,
        current_chapter: currentChapter,
        needs_memory_rebuild: true,
        plot_seed: els.seedBox.value || AppState.loadedNovelMetadata?.plot_seed || '',
        plot_outline: plotOutline,
        story_state: '',
        character_state: '',
        current_arc: '',
        current_arc_keywords: [],
        current_arc_start_chapter: 1,
        recent_chapters: [],
        closed_arcs: [],
        expression_cooldown: [],
        continuity_fallback_count: 0,
    };

    await invoke('save_novel_state', {
        filename,
        textContent: finalText,
        metadataJson: JSON.stringify(metadata, null, 2),
    });

    AppState.setLoadedNovel(filename, metadata);
    return filename;
}

export async function refineNovelByChapters({ getLang, detectNextChapter, reloadNovelList }) {
    if (AppState.isWorkerRunning) {
        showToast('A novel generation job is already running.', 'warning');
        return;
    }
    if (AppState.isNovelRefining) return;

    const originalNovel = els.novelContent.value.trim();
    const plotOutline = els.plotContent.value.trim();
    const lang = getLang();
    const totalChapters = parseInt(els.numChap.value, 10) || 1;
    const userInstructions = els.novelRefineInstructions?.value?.trim() || '';

    if (!plotOutline) {
        showToast('Plot is empty! Generate or load a plot before refining the novel.', 'warning');
        return;
    }
    if (!originalNovel) {
        showToast('Novel is empty! Generate or load a novel before refining.', 'warning');
        return;
    }

    const { intro, chapters } = splitNovelIntoChapterBlocks(originalNovel, lang);
    if (chapters.length === 0) {
        showToast('No novel text was found to refine.', 'warning');
        return;
    }

    const plotChapters = splitPlotIntoChapters(plotOutline);
    const refinedChapters = [];

    AppState.stopRequested = false;
    AppState.isNovelRefining = true;
    setNovelRefineBusy(true);
    els.novelStatus.innerText = `Preparing novel refine (${chapters.length} chapter${chapters.length === 1 ? '' : 's'})...`;

    try {
        for (let i = 0; i < chapters.length; i++) {
            if (AppState.stopRequested) break;

            const chapter = chapters[i];
            const previousRefinedContext = takeTail(
                refinedChapters
                    .slice(-2)
                    .map(item => `${item.header}\n\n${item.body}`.trim())
                    .join('\n\n'),
                PREVIOUS_CONTEXT_CHARS,
            );
            const nextOriginalContext = chapters[i + 1]
                ? takeHead(`${chapters[i + 1].header}\n\n${chapters[i + 1].body}`.trim(), NEXT_CONTEXT_CHARS)
                : '';
            const prompt = buildNovelRefinePrompt({
                lang,
                totalChapters,
                plotOutline,
                plotChapters,
                chapter,
                chapterIndex: i,
                chapterCount: chapters.length,
                previousRefinedContext,
                nextOriginalContext,
                userInstructions,
            });
            const statusText = `Refining chapter ${chapter.number} (${i + 1}/${chapters.length})...`;
            const maxTokens = maxTokensForChapter(chapter.body, els.targetTokens.value);

            const rawChapter = await generateRefinedChapter(prompt, {
                maxTokens,
                statusText,
                onDelta: (chunk, event) => {
                    const previewBody = sanitizeRefinedChapterBody(chunk, chapter.number, lang) || chunk;
                    const visibleChapters = [
                        ...refinedChapters,
                        { ...chapter, body: previewBody },
                        ...chapters.slice(i + 1),
                    ];
                    updateNovelOutput(assembleNovel(intro, visibleChapters), event);
                },
            });

            if (AppState.stopRequested) break;

            const refinedBody = sanitizeRefinedChapterBody(rawChapter, chapter.number, lang);
            if (!refinedBody) {
                throw new Error(`Refined chapter ${chapter.number} returned empty content.`);
            }

            refinedChapters.push({ ...chapter, body: refinedBody });
            updateNovelOutput(assembleNovel(intro, [...refinedChapters, ...chapters.slice(i + 1)]), {
                is_finished: false,
            });
        }

        if (AppState.stopRequested) {
            els.novelStatus.innerText = 'Stopped.';
            renderMarkdown(els.novelContent.id);
            return;
        }

        const finalText = assembleNovel(intro, refinedChapters);
        updateNovelOutput(finalText, { is_finished: true });
        const filename = await saveRefinedNovelState({
            finalText,
            lang,
            chapters: refinedChapters,
            plotOutline,
        });

        await reloadNovelList?.();
        await detectNextChapter?.();
        els.novelStatus.innerText = `Done. Saved: ${filename}`;
        showToast(`Refined novel saved: ${filename}`, 'success');
    } catch (e) {
        console.error('[NovelRefine] Error:', e);
        els.novelStatus.innerText = `Error: ${e.message || e}`;
        showToast(`Novel refine failed: ${e.message || e}`, 'error');
    } finally {
        AppState.isNovelRefining = false;
        setNovelRefineBusy(false);
    }
}
