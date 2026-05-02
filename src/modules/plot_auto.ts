import { invoke } from './tauri_api.js';

const PLOT_AUTO_INSTRUCTION_SYSTEM_PROMPT =
    'You are an expert fiction development editor with deep experience in serialized web novels, light novels, and genre fiction (fantasy, romance-thriller, isekai, etc.).';

export function buildPlotAutoInstructionPrompt({ lang, plotOutline }) {
    return `You will be given a novel plot outline document. The document may include a title, core themes, character profiles, worldbuilding notes, and one or more parts, each containing multiple chapters with structured metadata.

Your task is to analyze the plot outline and produce a REFINEMENT INSTRUCTION DOCUMENT — a precise set of numbered editor's rules tailored to this specific outline that will guide an AI (or human writer) to refine it without letting it drift out of scope, inflate in scale, or lose tonal consistency.

Write the refinement instructions in ${lang}, unless the input outline is clearly written in another language, and keep all quoted proper nouns, chapter numbers, part numbers, system names, metadata field names, and score field names exactly as they appear in the input.

---

## YOUR ANALYSIS PROCESS

Before writing any instructions, silently perform the following diagnostic checks on the input outline. You do not need to output this analysis — use it to ground your instructions in actual problems found in the document.

**A. Scope Diagnosis — per part**
- For each part, how many chapters does it cover?
- For each part, how many distinct conflict axes are simultaneously active at its midpoint?
- Across all parts, does the number of active conflict axes grow at a sustainable rate, or does it spike?
- Are any conflict axes introduced in the final third of a part that were not established in its first third?
- Are there any worldbuilding elements whose implied lore weight exceeds what their introducing part can reasonably pay off?

**B. Thread Continuity Diagnosis — across all parts**
- Identify any concept, mechanic, or rule introduced early (in any part) that disappears from subsequent chapters within the same part or across parts.
- Identify any reveal or escalation in later chapters that lacks a clear causal chain traceable to earlier chapters.
- Identify any character arc or relationship dynamic that is set up in one part but not carried forward into subsequent parts.

**C. Tone Diagnosis**
- What is the intended tonal blend (e.g., comedy + thriller, dark + heartwarming)?
- Identify chapters — across all parts — where the must_include or content description would likely push the tone outside that blend.
- Identify any character backstory or setting detail that could cause an AI generator to drift into an unintended tone.

**D. Scale Diagnosis — across all parts**
- Are any named factions, systems, or proper nouns carrying implied importance that no part actually develops?
- Does any single chapter try to introduce more than one new major variable (character, faction, mechanic, or revelation)?
- Does the overall scale of the conflict (personal → national → world-ending, etc.) escalate at a pace appropriate to the total number of parts and chapters?

---

## OUTPUT: REFINEMENT INSTRUCTION DOCUMENT

Based on your diagnosis, produce a single numbered list of refinement instructions.

### Format Rules for the Instruction List
- Number each instruction sequentially: 1, 2, 3, ...
- Each instruction must be ONE sentence. No exceptions.
- The total number of instructions must be between 5 and 10. No exceptions.
- Do not insert blank lines between numbered instructions.
- Every instruction must reference a specific element found in the input outline (chapter number, part number, character name, system name, metadata field, etc.). Generic advice is not permitted.
- Each instruction must be an actionable directive. Use imperative language: "Remove," "Add," "Reframe," "Limit," "Ensure," "Move," etc.
- Where a rule requires judgment, append a parenthetical contrast in the same sentence showing compliant vs. non-compliant execution. Example: "(e.g., 'Kai grimaced — more attention, exactly what he didn't need' ✓ vs. a full introspective paragraph on his past trauma ✗)"

---


Do not include any preface, diagnostic notes, summaries, code fences, or meta-explanation outside the required instruction document.

[Novel Plot Outline]
${plotOutline}`;
}

export function normalizePlotAutoInstructions(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trimEnd())
        .filter(line => line.trim())
        .join('\n')
        .trim();
}

export async function generatePlotAutoInstructions({ lang, plotOutline, apiParams }) {
    const result = await invoke('chat_completion', {
        apiBase: apiParams.apiBase,
        modelName: apiParams.modelName,
        apiKey: apiParams.apiKey || 'lm-studio',
        systemPrompt: PLOT_AUTO_INSTRUCTION_SYSTEM_PROMPT,
        prompt: buildPlotAutoInstructionPrompt({ lang, plotOutline }),
        temperature: 0.45,
        topP: 0.9,
        maxTokens: 4096,
        repetitionPenalty: 1.1
    });

    return normalizePlotAutoInstructions(result);
}
