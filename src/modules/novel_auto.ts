import { invoke } from './tauri_api.js';

const NOVEL_AUTO_INSTRUCTION_SYSTEM_PROMPT =
    'You are a professional fiction editor specializing in chapter-level refinement.';

export function buildNovelAutoInstructionPrompt({
    lang,
    plotInfo,
    prevChapterText,
    currentChapterText,
    nextChapterText,
}) {
    return `Your task is to produce a set of Refinement Instructions for the Current Chapter.
These instructions will be handed directly to a rewriter. They must be actionable directives, not critique sentences.

---

## INPUT STRUCTURE

- PLOT AND SETTING INFORMATION: global outline, character settings, worldbuilding rules, tone, genre, and major story direction.
${plotInfo || "None."}

- PREVIOUS CHAPTER:
${prevChapterText || "None."}

- CURRENT CHAPTER:
${currentChapterText || "None."}

- NEXT CHAPTER:
${nextChapterText || "None."}

---

## REVIEW SCOPE

Review ONLY the Current Chapter.
Use the Plot and Setting Information to verify the Current Chapter's consistency with the intended story direction, character settings, worldbuilding rules, tone, and genre.
Use the Previous Chapter and Next Chapter exclusively as context for:
- Continuity of character state, tone, and information
- Emotional momentum across chapter boundaries
- Setup -> payoff chains that span chapters

Do NOT review, rewrite, or critique the Previous or Next Chapter.

---

## WHAT TO ASSESS IN THE CURRENT CHAPTER

Evaluate the following dimensions:

1. Plot logic - cause-and-effect, scene purpose, stakes clarity
2. Character motivation - are actions grounded in established psychology?
3. Emotional continuity - does the emotional arc connect to the previous chapter and set up the next?
4. Pacing and tension - scene rhythm, where the chapter breathes vs. accelerates
5. Dialogue - naturalness, subtext, function (does each exchange do work?)
6. Exposition - is it earned, or is it dumped? Is worldbuilding embedded in action?
7. Sensory and atmospheric detail - specific enough to be immersive, not generic
8. Transitions - between scenes, between interiority and action, between chapters
9. Foreshadowing and payoff - anything planted or resolved well vs. underdeveloped
10. Contradictions and gaps - character, logic, or continuity breaks

---

## OUTPUT: REFINEMENT INSTRUCTIONS

Generate 0 to 12 Refinement Instructions in ${lang}, only for concrete issues that need correction.
Number actual instructions consecutively starting at 1. Never fill a quota.
If no correction is needed, output exactly NO_CHANGES and nothing else.

Each instruction must follow this format:

[LOCATION] -> [DIRECTIVE] -> [SCOPE]

- LOCATION: Specify where in the Current Chapter (for example, "Opening paragraph", "The confrontation scene", "The protagonist's internal monologue after X event"). Be precise enough that a rewriter can find it without guessing.
- DIRECTIVE: A single, clear action verb phrase. Use language like Sharpen, Condense, Expand, Replace, Reorder, Remove, Add, Preserve, Reframe, Ground, or Mark DO NOT ALTER.
- SCOPE: Indicate the permitted scale of change - use one of: [MICRO] (word/phrase level), [LOCAL] (sentence or short paragraph), [SCENE] (scene-level restructure), or [PRESERVE] (protect a working passage from accidental over-editing). Never suggest changes beyond scene level unless a fatal plot contradiction requires it.

---

## CALIBRATION RULES

These rules prevent over-editing. Follow them strictly.

1. Preserve what works. If a passage is functioning well - strong voice, clear purpose, good pacing - do not issue an instruction targeting it. Silence means approval.
2. No structural dismantling. Do not issue instructions that would delete or relocate major expository passages, character introductions, or scene-establishing blocks unless they are factually contradictory with established plot or character.
3. Maximum one [SCENE] instruction. If more than one scene-level change feels necessary, select only the single most critical one. Prefer [LOCAL] or [MICRO] alternatives for the others.
4. Do not change what adjacent chapters depend on. If the Previous or Next Chapter relies on a specific piece of information, tone, or character state established in the Current Chapter, mark it as DO NOT ALTER and use [PRESERVE] rather than issuing a change directive.
5. Voice preservation. Stylistic quirks (sentence fragments, tonal shifts, unconventional punctuation) are intentional unless they cause genuine reader confusion. Do not sand them down.

---

## OUTPUT CONSTRAINTS

- Write in ${lang}.
- Each instruction must be one to three sentences maximum.
- No praise, summary, meta-commentary, headings beyond numbering, or explanation of why you chose these points.
- Do not rewrite any part of the chapter.
- Do not address the author. Write as if the instructions are a task list for a rewriter.
- Do not fill unused slots with [PRESERVE] directives. Mention a protected passage only when an actual correction elsewhere risks disturbing it.
- If the chapter already works, return NO_CHANGES. Do not invent issues or request cosmetic rewrites merely to produce instructions.`;
}

export function normalizeNovelAutoInstructions(text) {
    let normalized = String(text || '')
        .replace(/\r\n/g, '\n')
        .trim();
    // Models often wrap a valid list in Markdown despite the output instructions.
    const fenced = normalized.match(/^(```|~~~)[^\n]*\n([\s\S]*?)\n\1$/);
    if (fenced) normalized = fenced[2].trim();
    const lines = normalized
        .split('\n')
        .map(line => line.trim().replace(/^#{1,6}\s+/, ''))
        .filter(Boolean);
    if (!lines.length) throw new Error('Auto review returned empty output.');

    const noChanges = value => /^(?:NO_CHANGES|수정(?:할)?\s*(?:사항|필요)(?:이|가)?\s*없(?:음|습니다)|修正(?:は|の必要は)?(?:不要|ありません)|No changes (?:are )?(?:needed|required))[.!。]?$/i
        .test(value.replace(/^[*_`]+|[*_`]+$/g, '').trim());
    if (noChanges(lines.join(' ')) || (lines.every(line => noChanges(line)
        || /^(?:Refinement Instructions|Auto Review|퇴고 지시(?:사항)?|수정 지시(?:사항)?|修正指示)\s*[:：]?$/i.test(line))
        && lines.some(line => noChanges(line)))) return 'NO_CHANGES';

    // Accept indentation, bold numbering, bullets, full-width numbers, and scopes
    // followed by explanations. Formatting differences must not fail a review.
    const numbered = line => line.replace(/^[*_`]+/, '')
        .match(/^(?:[-*+]\s+)?\(?[0-9０-９]+[.．)）、:：]\s*(?:\*\*|__)?\s*(.*)$/);
    const bulleted = line => line.match(/^[-*+•]\s+(.*)$/);
    const scopedRow = line => /\[(?:MICRO|LOCAL|SCENE|PRESERVE)\]/i.test(line)
        && /(?:->|→|\|)/.test(line) ? [line, line] : null;
    const startOfItem = lines.some(line => numbered(line)) ? numbered
        : lines.some(line => bulleted(line)) ? bulleted
        : lines.some(line => scopedRow(line)) ? scopedRow : null;
    const directives = [];
    if (startOfItem) {
        for (const line of lines) {
            const item = startOfItem(line);
            if (item) directives.push(item[1]);
            else if (directives.length) directives[directives.length - 1] += `\n${line}`;
        }
    } else {
        // A plain-language directive is still useful. Default to a limited edit
        // scope instead of rejecting it or authorizing a general rewrite.
        directives.push(lines.join('\n'));
    }
    const scoped = directives.filter(item => item.trim()).slice(0, 12).map(item => {
        const body = item.replace(/(?:\*\*|__|`)?\[\s*(MICRO|LOCAL|SCENE|PRESERVE)\s*\](?:\*\*|__|`)?/gi,
            (_, scope) => `[${scope.toUpperCase()}]`);
        const scopes = [...body.matchAll(/\[(MICRO|LOCAL|SCENE|PRESERVE)\]/g)];
        // Mixed unnumbered instructions must not become a preserve-only verdict
        // just because their last scope protects a passage.
        const scopeMatch = scopes.filter(match => match[1] !== 'PRESERVE').at(-1) || scopes.at(-1);
        const scope = scopeMatch?.[1] || 'LOCAL';
        const directive = scopeMatch
            ? `${body.slice(0, scopeMatch.index)}${body.slice(scopeMatch.index + scopeMatch[0].length)}`
            : body;
        return { scope, directive: directive.trim().replace(/(?:->|→)\s*$/, '').trim() };
    });
    if (!scoped.length) throw new Error('Auto review returned empty output.');
    if (scoped.every(item => item.scope === 'PRESERVE')) return 'NO_CHANGES';
    return scoped.map(({ directive, scope }, index) => `${index + 1}. ${directive} -> [${scope}]`).join('\n');
}

export async function generateInstructionForChapter({
    lang,
    plotInfo,
    prevChapterText,
    currentChapterText,
    nextChapterText,
    apiParams,
}) {
    const result = await invoke('chat_completion', {
        provider: apiParams.provider,
        apiBase: apiParams.apiBase,
        modelName: apiParams.modelName,
        apiKey: apiParams.apiKey || 'lm-studio',
        thinkingLevel: apiParams.thinkingLevel,
        systemPrompt: NOVEL_AUTO_INSTRUCTION_SYSTEM_PROMPT,
        prompt: buildNovelAutoInstructionPrompt({
            lang,
            plotInfo,
            prevChapterText,
            currentChapterText,
            nextChapterText,
        }),
        temperature: 0.45,
        topP: 0.9,
        maxTokens: 3000,
        repetitionPenalty: 1.1,
    });

    return normalizeNovelAutoInstructions(result);
}
