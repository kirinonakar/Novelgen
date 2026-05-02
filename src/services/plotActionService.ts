import { AppState } from '../modules/app_state.js';
import { updateBatchButtons } from '../modules/batch_queue.js';
import { els } from '../modules/dom_refs.js';
import { schedulePreviewRender } from '../modules/preview.js';
import { invoke } from '../modules/tauri_api.js';
import { showToast } from '../modules/toast.js';
import type { ApiProvider, Language } from '../types/app.js';
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
        els.autoSeedBtn.disabled = true;
        els.seedBox.value = '⏳ Generating seed...';
        setSeedText('⏳ Generating seed...');
        try {
            const seed = await generateSeed({
                apiBase: els.apiBase.value,
                modelName: els.modelName.value,
                apiKey: els.apiKeyBox.value || 'lm-studio',
                systemPrompt: els.promptBox.value,
                language: getLang(),
                temperature: parseFloat(els.temp.value),
                topP: parseFloat(els.topP.value),
                inputSeed: currentSeed,
            });
            els.seedBox.value = seed;
            setSeedText(seed);
        } catch (e) {
            const message = `❌ Error: ${appendProviderHint(String(e))}`;
            els.seedBox.value = message;
            setSeedText(message);
        } finally {
            els.autoSeedBtn.disabled = false;
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
        if (getProvider() === 'Google' && !els.apiKeyBox.value.trim()) {
            showToast('Please enter a Google API Key in the sidebar.', 'warning');
            return;
        }
        if (!seed.trim()) {
            showToast("Please enter a plot seed or use 'Auto Seed' first.", 'info');
            return;
        }

        const totalChapters = parseInt(els.numChap.value, 10) || 1;
        const prompt = buildPlotOutlinePrompt({
            seed,
            language: getLang(),
            totalChapters,
        });

        void streamPlot(prompt, els.plotContent);
    }

    async function streamPlot(prompt: string, textarea: HTMLTextAreaElement) {
        AppState.stopRequested = false;
        els.btnGenPlot.disabled = true;
        els.btnRefinePlot.disabled = true;
        els.plotStatusMsg.innerText = '⏳ Generating...';
        setPlotStatus('⏳ Generating...', 'generating');

        textarea.value = '';
        setPlotText('');
        updatePlotTokenCount();

        const handlePlotStreamEvent = (event: PlotStreamEvent) => {
            if (AppState.stopRequested && !event.is_finished && !event.error) return;

            textarea.value = event.content;
            setPlotText(event.content);
            if (textarea.id === 'plot-content') {
                updatePlotTokenCount();
            }

            if (event.error) {
                const msg = appendPlotStreamHint(event.error);
                textarea.value += `\n\n[Error]: ${msg}`;
                setPlotText(textarea.value);
                if (textarea.id === 'plot-content') {
                    updatePlotTokenCount();
                }
                if (msg.includes('Failed to parse input at pos 0')) {
                    textarea.value += '\n\n💡 [Hint] Model mismatch detected. Ensure LM Studio chat template is correctly set for models like Gemma 4.';
                    setPlotText(textarea.value);
                }
                els.plotStatusMsg.innerText = '❌ Error';
                setPlotStatus('❌ Error', 'error');
            }

            schedulePreviewRender(textarea.id, {
                source: 'stream',
                force: event.is_finished || Boolean(event.error),
                immediate: event.is_finished || Boolean(event.error),
            });

            if (event.is_finished && !event.error) {
                const message = AppState.stopRequested ? '🛑 Stopped' : '✅ Done';
                els.plotStatusMsg.innerText = message;
                setPlotStatus(message, AppState.stopRequested ? 'cancelled' : 'completed');
            }
        };

        try {
            await generatePlotStream({
                apiBase: els.apiBase.value,
                modelName: els.modelName.value,
                apiKey: els.apiKeyBox.value || 'lm-studio',
                systemPrompt: els.promptBox.value,
                prompt,
                temperature: parseFloat(els.temp.value),
                topP: parseFloat(els.topP.value),
                repetitionPenalty: parseFloat(els.repetitionPenalty.value),
                maxTokens: 8192,
            }, handlePlotStreamEvent);
        } catch (e) {
            textarea.value += `\n[Error]: ${e}`;
            setPlotText(textarea.value);
            els.plotStatusMsg.innerText = '❌ Error';
            setPlotStatus('❌ Error', 'error');
        } finally {
            els.btnGenPlot.disabled = false;
            els.btnRefinePlot.disabled = false;
        }
    }

    return {
        autoGenerateSeed,
        generatePlotOutline,
        stopPlotGeneration,
    };
}
