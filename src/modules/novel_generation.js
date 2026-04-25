import { els } from './dom_refs.js';
import { renderMarkdown, schedulePreviewRender } from './preview.js';
import { Channel, invoke } from './tauri_api.js';

function normalizeGenerationResult(result, fallbackFilename = null) {
    if (typeof result === 'string') {
        return {
            fullNovelText: result,
            novelFilename: fallbackFilename,
            metadata: null,
        };
    }

    return {
        fullNovelText: result?.full_text || result?.fullNovelText || '',
        novelFilename: result?.novel_filename || result?.novelFilename || fallbackFilename,
        metadata: result?.metadata || null,
    };
}

export async function generateNovel({
    startChapter = 1,
    totalChapters,
    targetTokens,
    lang,
    plotOutline,
    initialText = '',
    novelFilename = null,
    recentChapters = [],
    storyState = '',
    characterState = '',
    currentArc = '',
    currentArcKeywords = [],
    currentArcStartChapter = 1,
    closedArcs = [],
    expressionCooldown = [],
    needsMemoryRebuild = false,
    continuityFallbackCount = 0,
    onStatus = () => {},
    stopSignal = () => false,
    plotSeed = "",
}) {
    let hasError = false;
    let errMsg = "";
    let chapterStreamBaseText = null;
    try {
        const onEvent = new Channel();
        onEvent.onmessage = (event) => {
            if (stopSignal() && !event.is_finished && !event.error) {
                return;
            }

            if (stopSignal() && event.is_finished) {
                console.log("[Frontend] Stop signal active, processing final rolled-back content.");
            }

            if (event.error) {
                hasError = true;
                errMsg = event.error;
            }

            onStatus(event.error ? `❌ Error: ${event.error}` : (event.status || (event.is_finished ? "✅ Done" : `Writing...`)));

            const threshold = 50;
            const isAtBottom = els.novelContent.scrollHeight - els.novelContent.clientHeight <= els.novelContent.scrollTop + threshold;

            if (event.is_chapter_preview) {
                if (chapterStreamBaseText === null) {
                    chapterStreamBaseText = els.novelContent.value;
                }
                els.novelContent.value = chapterStreamBaseText + event.content;
            } else {
                chapterStreamBaseText = null;
                els.novelContent.value = event.content;
            }
            schedulePreviewRender(els.novelContent.id, {
                source: 'stream',
                force: event.is_finished || Boolean(event.error),
                immediate: event.is_finished || Boolean(event.error)
            });

            if (isAtBottom) {
                els.novelContent.scrollTop = els.novelContent.scrollHeight;
            }
        };

        const rawResult = await invoke("generate_novel", {
            params: {
                api_base: els.apiBase.value,
                model_name: els.modelName.value,
                api_key: els.apiKeyBox.value || "lm-studio",
                system_prompt: els.promptBox.value,
                plot_outline: plotOutline,
                initial_text: initialText,
                start_chapter: startChapter,
                total_chapters: totalChapters,
                target_tokens: targetTokens,
                language: lang,
                temperature: parseFloat(els.temp.value),
                top_p: parseFloat(els.topP.value),
                repetition_penalty: parseFloat(els.repetitionPenalty.value),
                plot_seed: plotSeed,
                novel_filename: novelFilename,
                recent_chapters: recentChapters,
                story_state: storyState,
                character_state: characterState,
                current_arc: currentArc,
                current_arc_keywords: currentArcKeywords,
                current_arc_start_chapter: currentArcStartChapter,
                closed_arcs: closedArcs,
                expression_cooldown: expressionCooldown,
                needs_memory_rebuild: needsMemoryRebuild,
                continuity_fallback_count: continuityFallbackCount
            },
            onEvent
        });
        const generationResult = normalizeGenerationResult(rawResult, novelFilename);
        if (hasError) {
            const error = new Error(errMsg);
            error.generationResult = generationResult;
            throw error;
        }
        onStatus("Done");
        els.novelContent.value = generationResult.fullNovelText;
        renderMarkdown(els.novelContent.id);
        return generationResult;
    } catch (e) {
        onStatus(`❌ Error: ${e}`);
        throw e;
    }
}
