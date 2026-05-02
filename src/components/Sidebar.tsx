import type { CSSProperties } from 'react';
import type {
    ApiSettingsViewState,
    BatchSettingsSnapshot,
    GenerationParamsViewState,
    PromptEditorViewState,
} from '../types/app.js';
import type { ActionProps, AppProps } from './componentTypes.js';

const growStyle: CSSProperties = { flexGrow: 1 };
const hiddenGroupStyle: CSSProperties = { display: 'none' };
const compactSaveButtonStyle: CSSProperties = { padding: '4px 10px', fontSize: '0.75rem', height: 28 };
const readonlyQueueStyle: CSSProperties = { background: 'var(--bg-card)', cursor: 'not-allowed' };
const toplessToggleStyle: CSSProperties = { marginTop: 0 };
const batchButtonsStyle: CSSProperties = { marginTop: 5, gap: 8 };
const halfButtonStyle: CSSProperties = { flex: 1 };

function ApiSettingsCard({
    actions,
    apiSettings,
}: ActionProps & { apiSettings: ApiSettingsViewState }) {
    return (
        <div className="card settings-group">
            <h2>🛠️ API SETTINGS</h2>

            <div className="input-group provider-toggle">
                <label>Provider</label>
                <div className="segmented-control">
                    <input
                        type="radio"
                        id="prov-lmstudio"
                        name="provider"
                        value="LM Studio"
                        checked={apiSettings.provider === 'LM Studio'}
                        onChange={() => actions.onProviderChange('LM Studio')}
                    />
                    <label htmlFor="prov-lmstudio">LM Studio</label>

                    <input
                        type="radio"
                        id="prov-google"
                        name="provider"
                        value="Google"
                        checked={apiSettings.provider === 'Google'}
                        onChange={() => actions.onProviderChange('Google')}
                    />
                    <label htmlFor="prov-google">Google</label>
                </div>
            </div>

            <div className="input-group">
                <label htmlFor="api-base">Endpoint URL</label>
                <input
                    id="api-base"
                    className="inputbox"
                    value={apiSettings.apiBase}
                    onChange={event => actions.onApiBaseChange(event.currentTarget.value)}
                />
            </div>

            <div className="input-group" id="group-api-key" style={apiSettings.showApiKey ? undefined : hiddenGroupStyle}>
                <label htmlFor="api-key">Google API Key</label>
                <input
                    id="api-key"
                    type="password"
                    className="inputbox"
                    placeholder="Enter API Key"
                    value={apiSettings.apiKey}
                    onChange={event => actions.onApiKeyChange(event.currentTarget.value)}
                />
            </div>

            <div className="input-group">
                <div className="label-header">
                    <label htmlFor="model-name">Model Name</label>
                    <span id="api-status" className="status-msg">{apiSettings.apiStatus}</span>
                </div>
                <div className="auto-flex">
                    <select
                        id="model-name"
                        className="inputbox"
                        style={growStyle}
                        value={apiSettings.modelName}
                        onChange={event => actions.onModelChange(event.currentTarget.value)}
                    >
                        {apiSettings.modelOptions.map(model => (
                            <option key={model} value={model}>{model}</option>
                        ))}
                    </select>
                    <button
                        id="refresh-models-btn"
                        className="btn btn-icon"
                        type="button"
                        title="Refresh Models"
                        disabled={apiSettings.isRefreshingModels}
                        onClick={actions.onRefreshModels}
                    >
                        🔄
                    </button>
                </div>
            </div>
        </div>
    );
}

function PersonaPromptCard({
    actions,
    promptEditor,
}: ActionProps & { promptEditor: PromptEditorViewState }) {
    return (
        <div className="card settings-group">
            <h2>🎭 PERSONA &amp; PROMPT</h2>
            <div className="input-group">
                <label htmlFor="system-preset">System Preset</label>
                <select
                    id="system-preset"
                    className="inputbox"
                    value={promptEditor.selectedPreset}
                    onChange={event => actions.onSystemPresetChange(event.currentTarget.value)}
                >
                    {promptEditor.presetOptions.map(preset => (
                        <option key={preset} value={preset}>{preset}</option>
                    ))}
                </select>
            </div>
            <div className="input-group">
                <div className="label-header">
                    <label htmlFor="system-prompt">System Prompt Details</label>
                    <div className="auto-flex">
                        <span id="prompt-status-msg" className="status-msg">{promptEditor.promptStatus}</span>
                        <button id="save-prompt-btn" className="btn btn-secondary" type="button" style={compactSaveButtonStyle} onClick={actions.onSavePrompt}>💾 Save Prompt</button>
                    </div>
                </div>
                <textarea
                    id="system-prompt"
                    className="inputbox textarea-small"
                    rows={4}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    value={promptEditor.systemPrompt}
                    onChange={event => actions.onSystemPromptChange(event.currentTarget.value)}
                />
            </div>
        </div>
    );
}

function GenerationParamsCard({
    actions,
    generationParams,
}: ActionProps & { generationParams: GenerationParamsViewState }) {
    return (
        <div className="card settings-group">
            <h2>⚙️ GENERATION PARAMS</h2>

            <div className="input-group provider-toggle">
                <label>Language</label>
                <div className="segmented-control">
                    <input type="radio" id="lang-ko" name="language" value="Korean" checked={generationParams.language === 'Korean'} onChange={() => actions.onLanguageChange('Korean')} />
                    <label htmlFor="lang-ko">Korean</label>
                    <input type="radio" id="lang-jp" name="language" value="Japanese" checked={generationParams.language === 'Japanese'} onChange={() => actions.onLanguageChange('Japanese')} />
                    <label htmlFor="lang-jp">Japanese</label>
                    <input type="radio" id="lang-en" name="language" value="English" checked={generationParams.language === 'English'} onChange={() => actions.onLanguageChange('English')} />
                    <label htmlFor="lang-en">English</label>
                </div>
            </div>

            <div className="auto-flex">
                <div className="input-group">
                    <label htmlFor="num-chapters">Total Chapters</label>
                    <input type="number" id="num-chapters" className="inputbox" defaultValue="5" min="1" max="100" />
                </div>
                <div className="input-group">
                    <label htmlFor="target-tokens">Target Tokens</label>
                    <input type="number" id="target-tokens" className="inputbox" defaultValue="2000" min="500" step="500" />
                </div>
            </div>

            <details className="advanced-params">
                <summary>📐 Advanced Sampling Params</summary>
                <div className="collapsible-content">
                    <div className="input-group">
                        <label htmlFor="temperature">Temperature (<span id="temp-val">{parseFloat(generationParams.temperature).toFixed(1)}</span>)</label>
                        <input type="range" id="temperature" min="0" max="2" step="0.1" value={generationParams.temperature} className="slider" onChange={event => actions.onTemperatureChange(event.currentTarget.value)} />
                    </div>
                    <div className="input-group">
                        <label htmlFor="top-p">Top-P (<span id="topp-val">{parseFloat(generationParams.topP).toFixed(2)}</span>)</label>
                        <input type="range" id="top-p" min="0" max="1" step="0.05" value={generationParams.topP} className="slider" onChange={event => actions.onTopPChange(event.currentTarget.value)} />
                    </div>
                    <div className="input-group">
                        <label htmlFor="repetition-penalty">Repetition Penalty (<span id="rp-val">{parseFloat(generationParams.repetitionPenalty).toFixed(2)}</span>)</label>
                        <input type="range" id="repetition-penalty" min="1" max="2" step="0.05" value={generationParams.repetitionPenalty} className="slider" onChange={event => actions.onRepetitionPenaltyChange(event.currentTarget.value)} />
                    </div>
                </div>
            </details>
        </div>
    );
}

function BatchModeCard({
    actions,
    batchSettings,
}: ActionProps & { batchSettings: BatchSettingsSnapshot }) {
    return (
        <div className="card settings-group">
            <h2>📦 BATCH MODE</h2>
            <div className="auto-flex">
                <div className="input-group">
                    <label htmlFor="batch-count">Batch Count</label>
                    <input type="number" id="batch-count" className="inputbox" defaultValue="1" min="1" />
                </div>
                <div className="input-group">
                    <label>Queue Size</label>
                    <input type="text" id="queue-count" className="inputbox" defaultValue="0" readOnly style={readonlyQueueStyle} />
                </div>
            </div>
            <div className="auto-flex batch-option-group">
                <label className="comfort-toggle" htmlFor="batch-auto-refine-plot" style={toplessToggleStyle}>
                    <input
                        type="checkbox"
                        id="batch-auto-refine-plot"
                        checked={batchSettings.autoRefinePlot}
                        onChange={event => actions.onBatchAutoRefinePlotChange(event.currentTarget.checked)}
                    />
                    <span>Auto refine plot</span>
                </label>
                <label className={`comfort-toggle${batchSettings.autoRefinePlot ? '' : ' dimmed'}`} htmlFor="batch-auto-refine-plot-instructions" style={toplessToggleStyle}>
                    <input
                        type="checkbox"
                        id="batch-auto-refine-plot-instructions"
                        checked={batchSettings.autoRefinePlotInstructions}
                        disabled={!batchSettings.autoRefinePlot}
                        onChange={event => actions.onBatchAutoRefinePlotInstructionsChange(event.currentTarget.checked)}
                    />
                    <span>Auto instructions</span>
                </label>
            </div>
            <div className="auto-flex batch-option-group">
                <label className="comfort-toggle" htmlFor="batch-auto-refine-novel" style={toplessToggleStyle}>
                    <input
                        type="checkbox"
                        id="batch-auto-refine-novel"
                        checked={batchSettings.autoRefineNovel}
                        onChange={event => actions.onBatchAutoRefineNovelChange(event.currentTarget.checked)}
                    />
                    <span>Auto refine novel</span>
                </label>
                <label className={`comfort-toggle${batchSettings.autoRefineNovel ? '' : ' dimmed'}`} htmlFor="batch-auto-refine-novel-instructions" style={toplessToggleStyle}>
                    <input
                        type="checkbox"
                        id="batch-auto-refine-novel-instructions"
                        checked={batchSettings.autoRefineNovelInstructions}
                        disabled={!batchSettings.autoRefineNovel}
                        onChange={event => actions.onBatchAutoRefineNovelInstructionsChange(event.currentTarget.checked)}
                    />
                    <span>Auto instructions</span>
                </label>
            </div>
            <div className="auto-flex" style={batchButtonsStyle}>
                <button id="batch-start-btn" className="btn btn-magic pulse-hover" type="button" style={halfButtonStyle} onClick={actions.onBatchStart}>🚀 Batch Start</button>
                <button id="batch-stop-btn" className="btn btn-danger" type="button" style={halfButtonStyle} onClick={actions.onBatchStop}>⏹️ Stop Queue</button>
            </div>
        </div>
    );
}

export function Sidebar({ actions, viewState }: AppProps) {
    return (
        <aside className="sidebar">
            <div className="sidebar-header">
                <div className="brand-row">
                    <h1 className="app-title">🖋️ NovelGen AI</h1>
                    <button
                        id="theme-toggle"
                        className="theme-toggle"
                        type="button"
                        aria-label="Switch to dark mode"
                        title="Switch to dark mode"
                        aria-pressed="false"
                        onClick={actions.onThemeToggle}
                    >
                        <span className="theme-toggle-icon" aria-hidden="true">🌙</span>
                    </button>
                </div>
            </div>

            <ApiSettingsCard actions={actions} apiSettings={viewState.apiSettings} />
            <PersonaPromptCard actions={actions} promptEditor={viewState.promptEditor} />
            <GenerationParamsCard actions={actions} generationParams={viewState.generationParams} />
            <BatchModeCard actions={actions} batchSettings={viewState.batchSettings} />
        </aside>
    );
}
