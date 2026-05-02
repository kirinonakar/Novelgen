import { Channel, invoke } from '../modules/tauri_api.js';
import type { Language } from '../types/app.js';

export interface GenerateSeedParams {
    apiBase: string;
    modelName: string;
    apiKey: string;
    systemPrompt: string;
    language: Language;
    temperature: number;
    topP: number;
    inputSeed: string;
}

export interface GeneratePlotParams {
    apiBase: string;
    modelName: string;
    apiKey: string;
    systemPrompt: string;
    prompt: string;
    temperature: number;
    topP: number;
    repetitionPenalty: number;
    maxTokens?: number;
}

export interface PlotStreamEvent {
    content: string;
    error?: string;
    is_finished?: boolean;
}

export async function generateSeed(params: GenerateSeedParams): Promise<string> {
    return await invoke<string>('generate_seed', { ...params });
}

export async function generatePlotStream(
    params: GeneratePlotParams,
    onMessage: (event: PlotStreamEvent) => void,
): Promise<void> {
    const onEvent = new Channel<PlotStreamEvent>();
    onEvent.onmessage = onMessage;

    await invoke('generate_plot', {
        params: {
            api_base: params.apiBase,
            model_name: params.modelName,
            api_key: params.apiKey,
            system_prompt: params.systemPrompt,
            prompt: params.prompt,
            temperature: params.temperature,
            top_p: params.topP,
            repetition_penalty: params.repetitionPenalty,
            max_tokens: params.maxTokens ?? 8192,
        },
        onEvent,
    });
}
