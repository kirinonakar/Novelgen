import { AppState } from '../modules/app_state.js';
import { updateBatchButtons } from '../modules/batch_queue.js';
import { invoke } from '../modules/tauri_api.js';
import { showToast } from '../modules/toast.js';
import type { ApiProvider, Language } from '../types/app.js';
import { getTotalChaptersParam } from './generationParamsService.js';
import {
    generatePlotStream,
    generateSeed,
    type PlotStreamEvent,
} from './plotGenerationService.js';
import { buildPlotOutlinePrompt } from './plotPromptService.js';
import {
    getEditorSnapshot,
    setPlotStatus,
    setPlotText,
    setSeedText,
} from './runtimeEditorStateService.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';

interface PlotActionControllerOptions {
    getLang: () => Language;
    getProvider: () => ApiProvider;
    updatePlotTokenCount: () => void;
}

export interface PlotActionController {
    autoGenerateSeed: () => Promise<void>;
    generatePlotOutline: () => void;
    stopPlotGeneration: () => void;
}

function appendProviderHint(message: string) {
    if (message.includes('401')) {
        return `${message}\n\n💡 [Hint] Unauthorized. Check if your Google API Key is correctly entered.`;
    }
    if (message.includes('403')) {
        return `${message}\n\n💡 [Hint] Forbidden. Check your API key and project permissions.`;
    }
    if (message.includes('429')) {
        return `${message}\n\n💡 [Hint] Quota exceeded. You might have hit the free tier limit.`;
    }
    return message;
}

function appendPlotStreamHint(message: string) {
    if (message.includes('401')) {
        return `${message}\n\n💡 [Hint] Unauthorized. Check your API key.`;
    }
    if (message.includes('403')) {
        return `${message}\n\n💡 [Hint] Forbidden. This might be a safety filter block or permission issue.`;
    }
    if (message.includes('429')) {
        return `${message}\n\n💡 [Hint] Quota exceeded. Wait a moment or check your billing.`;
    }
    return message;
}

export function createPlotActions({
    getLang,
    getProvider,
    updatePlotTokenCount,
}: PlotActionControllerOptions): PlotActionController {
    async function autoGenerateSeed() {
        const currentSeed = getEditorSnapshot().seed;
        runtimeViewStateStore.setActivity({ isAutoSeedRunning: true });
        setSeedText('⏳ Generating seed...');
        try {
            const { apiSettings, generationParams, promptEditor } = runtimeViewStateStore.getSnapshot();
            const seed = await generateSeed({
                apiBase: apiSettings.apiBase,
                modelName: apiSettings.modelName,
                apiKey: apiSettings.apiKey || 'lm-studio',
                systemPrompt: promptEditor.systemPrompt,
                language: getLang(),
                temperature: parseFloat(generationParams.temperature),
                topP: parseFloat(generationParams.topP),
                inputSeed: currentSeed,
            });
            setSeedText(seed);
        } catch (e) {
            const message = `❌ Error: ${appendProviderHint(String(e))}`;
            setSeedText(message);
        } finally {
            runtimeViewStateStore.setActivity({ isAutoSeedRunning: false });
        }
    }

    function stopPlotGeneration() {
        if (AppState.isWorkerRunning && !AppState.stopRequested) {
            AppState.stopRequested = true;
            AppState.isPaused = true;
            invoke('stop_generation');
            updateBatchButtons();
            return;
        }

        AppState.stopRequested = true;
        invoke('stop_generation');
    }

    function generatePlotOutline() {
        const seed = getEditorSnapshot().seed;
        const { apiKey } = runtimeViewStateStore.getSnapshot().apiSettings;
        if (getProvider() === 'Google' && !apiKey.trim()) {
            showToast('Please enter a Google API Key in the sidebar.', 'warning');
            return;
        }
        if (!seed.trim()) {
            showToast("Please enter a plot seed or use 'Auto Seed' first.", 'info');
            return;
        }

        const totalChapters = getTotalChaptersParam(1);
        const prompt = buildPlotOutlinePrompt({
            seed,
            language: getLang(),
            totalChapters,
        });

        void streamPlot(prompt);
    }

    async function streamPlot(prompt: string) {
        AppState.stopRequested = false;
        runtimeViewStateStore.setActivity({ isPlotRunning: true });
        setPlotStatus('⏳ Generating...', 'generating');

        setPlotText('');
        updatePlotTokenCount();

        const handlePlotStreamEvent = (event: PlotStreamEvent) => {
            if (AppState.stopRequested && !event.is_finished && !event.error) return;

            setPlotText(event.content);
            updatePlotTokenCount();

            if (event.error) {
                const msg = appendPlotStreamHint(event.error);
                let errorContent = `${event.content}\n\n[Error]: ${msg}`;
                if (msg.includes('Failed to parse input at pos 0')) {
                    errorContent += '\n\n💡 [Hint] Model mismatch detected. Ensure LM Studio chat template is correctly set for models like Gemma 4.';
                }
                setPlotText(errorContent);
                updatePlotTokenCount();
                setPlotStatus('❌ Error', 'error');
            }

            if (event.is_finished && !event.error) {
                const message = AppState.stopRequested ? '🛑 Stopped' : '✅ Done';
                setPlotStatus(message, AppState.stopRequested ? 'cancelled' : 'completed');
            }
        };

        try {
            const { apiSettings, generationParams, promptEditor } = runtimeViewStateStore.getSnapshot();
            await generatePlotStream({
                apiBase: apiSettings.apiBase,
                modelName: apiSettings.modelName,
                apiKey: apiSettings.apiKey || 'lm-studio',
                systemPrompt: promptEditor.systemPrompt,
                prompt,
                temperature: parseFloat(generationParams.temperature),
                topP: parseFloat(generationParams.topP),
                repetitionPenalty: parseFloat(generationParams.repetitionPenalty),
                maxTokens: 8192,
            }, handlePlotStreamEvent);
        } catch (e) {
            const currentPlot = getEditorSnapshot().plot;
            setPlotText(`${currentPlot}\n[Error]: ${e}`);
            setPlotStatus('❌ Error', 'error');
        } finally {
            runtimeViewStateStore.setActivity({ isPlotRunning: false });
        }
    }

    return {
        autoGenerateSeed,
        generatePlotOutline,
        stopPlotGeneration,
    };
}
