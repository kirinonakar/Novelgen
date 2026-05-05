import { Channel, invoke } from './tauri_api.js';
import {
    getEditorSnapshot,
    setNovelText,
} from '../services/runtimeEditorStateService.js';
import { getRuntimeElement } from '../services/runtimeDomRegistryService.js';
import { runtimeViewStateStore } from '../services/runtimeViewStateStore.js';

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

function shouldRefreshChapterJumpFromEvent(event) {
    if (!event || event.is_chapter_preview) return false;

    const status = String(event.status || '');
    return event.is_finished || status.startsWith('Summarizing Chapter ');
}

function completedChapterFromEvent(event) {
    if (!event || event.is_chapter_preview || event.error) return null;

    const status = String(event.status || '');
    const match = status.match(/^Summarizing Chapter\s+(\d+)/i);
    if (!match) return null;

    const chapterNumber = parseInt(match[1], 10);
    return Number.isFinite(chapterNumber) ? chapterNumber : null;
}

function parseGenerationNumber(value: string, fallback: number) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
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
    relationshipState = '',
    currentArc = '',
    currentArcKeywords = [],
    currentArcStartChapter = 1,
    closedArcs = [],
    expressionCooldown = [],
    recentScenePatterns = [],
    needsMemoryRebuild = false,
    continuityFallbackCount = 0,
    onStatus = () => {},
    onChapterFinished = () => {},
    onContentUpdated = () => {},
    onFilenameKnown = () => {},
    stopSignal = () => false,
    plotSeed = "",
}: any = {}) {
    let hasError = false;
    let errMsg = "";
    let chapterStreamBaseText = null;
    let lastNotifiedFinishedChapter = 0;
    let workingNovelFilename = novelFilename;
    let latestNovelText = String(initialText || getEditorSnapshot().novel || '');
    try {
        if (workingNovelFilename) {
            onFilenameKnown(workingNovelFilename);
        } else if (startChapter === 1) {
            try {
                workingNovelFilename = await invoke('get_next_novel_filename');
                onFilenameKnown(workingNovelFilename);
            } catch (e) {
                console.warn("[Frontend] Failed to pre-allocate novel filename:", e);
            }
        }

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

            const textarea = getRuntimeElement('novelContent');
            const threshold = 50;
            const isAtBottom = textarea
                ? textarea.scrollHeight - textarea.clientHeight <= textarea.scrollTop + threshold
                : false;

            if (event.is_chapter_preview) {
                if (chapterStreamBaseText === null) {
                    chapterStreamBaseText = latestNovelText;
                }
                latestNovelText = chapterStreamBaseText + (event.content || '');
            } else {
                chapterStreamBaseText = null;
                latestNovelText = event.content || '';
            }
            setNovelText(latestNovelText);
            if (shouldRefreshChapterJumpFromEvent(event)) {
                onContentUpdated();
            }
            const finishedChapter = completedChapterFromEvent(event);
            if (finishedChapter && finishedChapter > lastNotifiedFinishedChapter) {
                lastNotifiedFinishedChapter = finishedChapter;
                onChapterFinished(finishedChapter);
            }
            if (isAtBottom && textarea) {
                requestAnimationFrame(() => {
                    textarea.scrollTop = textarea.scrollHeight;
                });
            }
        };

        const { apiSettings, generationParams, promptEditor } = runtimeViewStateStore.getSnapshot();
        const rawResult = await invoke("generate_novel", {
            params: {
                api_base: apiSettings.apiBase,
                model_name: apiSettings.modelName,
                api_key: apiSettings.apiKey || "lm-studio",
                system_prompt: promptEditor.systemPrompt,
                plot_outline: plotOutline,
                initial_text: initialText,
                start_chapter: startChapter,
                total_chapters: totalChapters,
                target_tokens: targetTokens,
                language: lang,
                temperature: parseGenerationNumber(generationParams.temperature, 1),
                top_p: parseGenerationNumber(generationParams.topP, 0.95),
                repetition_penalty: parseGenerationNumber(generationParams.repetitionPenalty, 1.1),
                plot_seed: plotSeed,
                novel_filename: workingNovelFilename,
                recent_chapters: recentChapters,
                story_state: storyState,
                character_state: characterState,
                relationship_state: relationshipState,
                current_arc: currentArc,
                current_arc_keywords: currentArcKeywords,
                current_arc_start_chapter: currentArcStartChapter,
                closed_arcs: closedArcs,
                expression_cooldown: expressionCooldown,
                recent_scene_patterns: recentScenePatterns,
                needs_memory_rebuild: needsMemoryRebuild,
                continuity_fallback_count: continuityFallbackCount
            },
            onEvent
        });
        const generationResult = normalizeGenerationResult(rawResult, workingNovelFilename);
        if (hasError) {
            const error = new Error(errMsg) as Error & { generationResult?: any };
            error.generationResult = generationResult;
            throw error;
        }
        if (generationResult.novelFilename && generationResult.novelFilename !== workingNovelFilename) {
            workingNovelFilename = generationResult.novelFilename;
            onFilenameKnown(workingNovelFilename);
        }
        const finalFinishedChapter = parseInt(
            generationResult.metadata?.current_chapter ?? generationResult.metadata?.currentChapter,
            10
        );
        if (Number.isFinite(finalFinishedChapter) && finalFinishedChapter > lastNotifiedFinishedChapter) {
            lastNotifiedFinishedChapter = finalFinishedChapter;
            onChapterFinished(finalFinishedChapter);
        }
        onStatus("Done");
        latestNovelText = generationResult.fullNovelText;
        setNovelText(latestNovelText);
        onContentUpdated();
        return generationResult;
    } catch (e) {
        onStatus(`❌ Error: ${e}`);
        throw e;
    }
}
