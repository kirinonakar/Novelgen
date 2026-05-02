import type { CSSProperties } from 'react';
import type {
    ApiSettingsViewState,
    BatchSettingsSnapshot,
    GenerationParamsViewState,
    NovelgenRuntimeActions,
    RuntimeActivityViewState,
    RuntimeViewState,
    TypographyScope,
    TypographyScopeViewState,
} from '../types/app.js';

const growStyle: CSSProperties = { flexGrow: 1 };
const hiddenGroupStyle: CSSProperties = { display: 'none' };
const compactSaveButtonStyle: CSSProperties = { padding: '4px 10px', fontSize: '0.75rem', height: 28 };
const readonlyQueueStyle: CSSProperties = { background: 'var(--bg-card)', cursor: 'not-allowed' };
const toplessToggleStyle: CSSProperties = { marginTop: 0 };
const batchButtonsStyle: CSSProperties = { marginTop: 5, gap: 8 };
const halfButtonStyle: CSSProperties = { flex: 1 };
const tabContentColumnStyle: CSSProperties = { display: 'flex', flexDirection: 'column' };
const plotFileControlsStyle: CSSProperties = {
    gap: 4,
    borderLeft: '1px solid var(--border-color)',
    paddingLeft: 12,
    marginLeft: 4,
    flexGrow: 1
};
const novelFileControlsStyle: CSSProperties = {
    gap: 4,
    borderLeft: '1px solid var(--border-color)',
    paddingLeft: 12,
    marginLeft: 8,
    flexGrow: 1
};
const nextChapterControlsStyle: CSSProperties = {
    alignItems: 'center',
    gap: 8,
    border: '1px solid var(--border-color)',
    padding: '2px 8px',
    borderRadius: 8,
    background: 'var(--surface-soft)'
};
const inlineLabelStyle: CSSProperties = {
    whiteSpace: 'nowrap',
    marginBottom: 0,
    fontSize: '0.85rem',
    fontWeight: 600
};
const resumeInputStyle: CSSProperties = { width: 60, height: 32, padding: '2px 8px' };
const smallButtonStyle: CSSProperties = { height: 32, padding: '0 10px', fontSize: '0.85rem' };
const toolbarButtonStyle: CSSProperties = { flexShrink: 0, height: 35 };
const plotSelectStyle: CSSProperties = { flex: 1, minWidth: 150, height: 35 };
const novelSelectStyle: CSSProperties = { flex: 1, minWidth: 250, height: 35 };

function FontControls({
    actions,
    scope,
    settings,
}: ActionProps & { scope: TypographyScope; settings: TypographyScopeViewState }) {
    const labels = {
        seed: { comfort: 'seed-comfort-toggle', fs: 'seed-fs', wrap: 'seed-wrap' },
        plot: { comfort: 'plot-comfort-toggle', fs: 'plot-fs', wrap: 'plot-wrap' },
        novel: { comfort: 'novel-comfort-toggle', fs: 'novel-fs', wrap: 'novel-wrap' },
    }[scope];

    return (
        <div className="fs-control">
            <label className="comfort-toggle" htmlFor={labels.comfort}>
                <input
                    type="checkbox"
                    id={labels.comfort}
                    checked={settings.comfort}
                    onChange={event => actions.onComfortModeChange(scope, event.currentTarget.checked)}
                />
                <span>Comfort</span>
            </label>
            <label>SIZE <span id={`${labels.fs}-val`}>{settings.fontSize}</span></label>
            <input
                type="range"
                id={`${labels.fs}-slider`}
                min="12"
                max="32"
                step="1"
                value={settings.fontSize}
                className="header-slider"
                onChange={event => actions.onFontSizeChange(scope, event.currentTarget.value)}
            />
            <label>WRAP <span id={`${labels.wrap}-val`}>{settings.wrapWidth}</span></label>
            <input
                type="range"
                id={`${labels.wrap}-slider`}
                min="24"
                max="96"
                step="2"
                value={settings.wrapWidth}
                className="header-slider wrap-slider"
                onChange={event => actions.onWrapWidthChange(scope, event.currentTarget.value)}
            />
        </div>
    );
}

interface AppProps {
    actions: NovelgenRuntimeActions;
    viewState: RuntimeViewState;
}

interface ActionProps {
    actions: NovelgenRuntimeActions;
}

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

function PersonaPromptCard({ actions }: ActionProps) {
    return (
        <div className="card settings-group">
            <h2>🎭 PERSONA &amp; PROMPT</h2>
            <div className="input-group">
                <label htmlFor="system-preset">System Preset</label>
                <select
                    id="system-preset"
                    className="inputbox"
                    defaultValue="Custom (File Default)"
                    onChange={event => actions.onSystemPresetChange(event.currentTarget.value)}
                >
                    <option value="Custom (File Default)">Custom (File Default)</option>
                </select>
            </div>
            <div className="input-group">
                <div className="label-header">
                    <label htmlFor="system-prompt">System Prompt Details</label>
                    <div className="auto-flex">
                        <span id="prompt-status-msg" className="status-msg" />
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

function Sidebar({ actions, viewState }: AppProps) {
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
            <PersonaPromptCard actions={actions} />
            <GenerationParamsCard actions={actions} generationParams={viewState.generationParams} />
            <BatchModeCard actions={actions} batchSettings={viewState.batchSettings} />
        </aside>
    );
}

function SeedEditor({
    actions,
    viewState,
}: AppProps) {
    return (
        <div className="tabs-container" data-for="plot-seed">
            <div className="tabs-header">
                <span className="tab-label">Seed</span>
                <button className="tab-btn active" type="button" data-tab="edit">✍️ Edit</button>
                <button className="tab-btn" type="button" data-tab="preview">👁️ Preview</button>
                <button id="auto-seed-btn" className="btn btn-magic seed-auto-btn" type="button" onClick={actions.onAutoSeed}>🎲 Auto Seed</button>
                <div className="spacer" />
                <FontControls actions={actions} scope="seed" settings={viewState.typography.seed} />
            </div>
            <div className="tab-content">
                <div className="tab-pane active" data-pane="edit">
                    <textarea
                        id="plot-seed"
                        className="inputbox textarea-seed"
                        rows={3}
                        placeholder="Enter the core novel idea or auto-generate..."
                        spellCheck={false}
                    />
                </div>
                <div className="tab-pane" data-pane="preview">
                    <div id="plot-seed-preview" className="markdown-body inputbox textarea-seed" />
                </div>
            </div>
        </div>
    );
}

function PlotToolbar({ actions }: ActionProps) {
    return (
        <div className="action-bar" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-primary" id="btn-gen-plot" type="button" onClick={actions.onGeneratePlot}>✨ Generate Plot Outline</button>
            <button className="btn btn-secondary" id="btn-refine-plot" type="button" onClick={actions.onRefinePlot}>✨ Refine Plot</button>
            <button className="btn btn-danger" id="btn-stop-plot" type="button" onClick={actions.onStopPlot}>⏹️ Stop</button>

            <div className="auto-flex plot-file-controls" style={plotFileControlsStyle}>
                <select id="saved-plots" className="inputbox plot-file-select" style={plotSelectStyle} defaultValue="">
                    <option value="" disabled>Select a saved plot...</option>
                </select>
                <button className="btn btn-secondary" id="btn-load-plot" type="button" style={toolbarButtonStyle} onClick={actions.onLoadPlot}>📂 Load</button>
                <button className="btn btn-secondary" id="btn-refresh-plots" type="button" style={toolbarButtonStyle} onClick={actions.onRefreshPlots}>🔄 Refresh</button>
                <button className="btn btn-secondary" id="btn-save-plot" type="button" style={toolbarButtonStyle} onClick={actions.onSavePlot}>💾 Save Plot</button>
            </div>
        </div>
    );
}

function PlotRefineInstructions({
    actions,
    activity,
}: ActionProps & { activity: RuntimeActivityViewState }) {
    return (
        <div className="refine-instructions-block">
            <div className="refine-instructions-header">
                <div className="refine-title-actions">
                    <label htmlFor="plot-refine-instructions">Plot Refine Instructions</label>
                    <button
                        id="btn-auto-plot-instructions"
                        className="btn btn-secondary"
                        type="button"
                        title="Auto-analyze plot and suggest improvements"
                        disabled={activity.isAutoPlotInstructionsRunning}
                        onClick={actions.onAutoPlotInstructions}
                    >
                        {activity.isAutoPlotInstructionsRunning ? '⏳ Analyzing...' : '✨ Auto Instructions'}
                    </button>
                </div>
            </div>
            <textarea
                id="plot-refine-instructions"
                className="inputbox textarea-refine"
                rows={1}
                placeholder="Optional: Add specific instructions for Refine Plot, such as pacing, tone, relationship focus, part expansion, conflict changes, or things to preserve."
                spellCheck={false}
                onChange={actions.onPlotRefineInstructionsChange}
            />
        </div>
    );
}

function PlotEditor({
    actions,
    viewState,
}: AppProps) {
    return (
        <div className="tabs-container flex-grow" data-for="plot-content">
            <div className="tabs-header">
                <span className="tab-label">Plot</span>
                <button className="tab-btn active" type="button" data-tab="edit">✍️ Edit</button>
                <button className="tab-btn" type="button" data-tab="preview">👁️ Preview</button>
                <span id="plot-token-count" className="token-count" title="Estimated plot outline tokens">~0 tokens</span>
                <div className="spacer" />
                <FontControls actions={actions} scope="plot" settings={viewState.typography.plot} />
            </div>
            <div className="tab-content flex-grow" style={tabContentColumnStyle}>
                <div className="tab-pane active" data-pane="edit">
                    <textarea
                        id="plot-content"
                        className="inputbox textarea-plot"
                        rows={8}
                        placeholder="Generated plot will appear here. You can manually edit it before generating the novel."
                        spellCheck={false}
                    />
                </div>
                <div className="tab-pane" data-pane="preview">
                    <div id="plot-content-preview" className="markdown-body inputbox textarea-plot" />
                </div>
            </div>
        </div>
    );
}

function SeedPlotSection({
    actions,
    viewState,
}: AppProps) {
    return (
        <section className="card content-section">
            <SeedEditor actions={actions} viewState={viewState} />
            <PlotToolbar actions={actions} />
            <div className="status-bar">
                <span>Status: </span><span id="plot-status-msg" className="novel-status-text">Idle</span>
            </div>
            <PlotRefineInstructions actions={actions} activity={viewState.activity} />
            <PlotEditor actions={actions} viewState={viewState} />
        </section>
    );
}

function NovelToolbar({ actions }: ActionProps) {
    return (
        <div className="section-header">
            <div className="action-bar header-actions" style={{ flexWrap: 'wrap' }}>
                <button className="btn btn-primary pulse-hover" id="btn-gen-novel" type="button" onClick={actions.onGenerateNovel}>🚀 Start Novel Generation</button>
                <button className="btn btn-secondary" id="btn-refine-novel" type="button" title="Refine the current novel chapter-by-chapter against the plot" onClick={actions.onRefineNovel}>✨ Refine Novel</button>
                <button className="btn btn-danger" id="btn-stop-novel" type="button" onClick={actions.onStopNovel}>⏹️ Stop</button>
                <button className="btn btn-ghost" id="btn-clear-novel" type="button" title="Clear current novel content" onClick={actions.onClearNovel}>🗑️ Clear</button>

                <div className="auto-flex" style={nextChapterControlsStyle}>
                    <label htmlFor="resume-chapter" style={inlineLabelStyle}>Next Chapter</label>
                    <input type="number" id="resume-chapter" className="inputbox" defaultValue="1" min="1" style={resumeInputStyle} />
                    <button id="find-ch-btn" className="btn btn-secondary" type="button" title="Auto-detect next chapter from main text" style={smallButtonStyle} onClick={actions.onFindNextChapter}>🔄</button>
                </div>

                <div className="auto-flex" style={novelFileControlsStyle}>
                    <button className="btn btn-secondary" id="open-out-folder-btn" type="button" style={toolbarButtonStyle} onClick={actions.onOpenOutputFolder}>📂 Open Output Folder</button>
                    <select id="saved-novels" className="inputbox" style={novelSelectStyle} defaultValue="">
                        <option value="" disabled>Select a novel...</option>
                    </select>
                    <button id="btn-load-novel" className="btn btn-secondary" type="button" title="Load selected novel" style={toolbarButtonStyle} onClick={actions.onLoadNovel}>📂 Load</button>
                    <button id="btn-refresh-novels" className="btn btn-secondary" type="button" title="Refresh novel list" style={toolbarButtonStyle} onClick={actions.onRefreshNovels}>🔄 Refresh</button>
                    <button id="btn-save-novel" className="btn btn-secondary" type="button" title="Save current novel" style={toolbarButtonStyle} onClick={actions.onSaveNovel}>💾 Save</button>
                </div>
            </div>
        </div>
    );
}

function NovelRefineInstructions({
    actions,
    activity,
}: ActionProps & { activity: RuntimeActivityViewState }) {
    return (
        <div className="refine-instructions-block">
            <div className="refine-instructions-header">
                <div className="refine-title-actions">
                    <label htmlFor="novel-refine-instructions">Novel Refine Instructions</label>
                    <div className="chapter-range-controls" aria-label="Novel refine chapter range">
                        <label htmlFor="novel-refine-start-chapter">Start Chapter</label>
                        <input type="number" id="novel-refine-start-chapter" className="inputbox chapter-range-input" min="1" placeholder="All" />
                        <label htmlFor="novel-refine-end-chapter">End Chapter</label>
                        <input type="number" id="novel-refine-end-chapter" className="inputbox chapter-range-input" min="1" placeholder="All" />
                    </div>
                    <button
                        id="btn-auto-novel-instructions"
                        className="btn btn-secondary"
                        type="button"
                        title="Auto-analyze novel chapter and suggest improvements"
                        disabled={activity.isAutoNovelInstructionsRunning}
                        onClick={actions.onAutoNovelInstructions}
                    >
                        {activity.isAutoNovelInstructionsRunning ? '⏳ Analyzing...' : '✨ Auto Instructions'}
                    </button>
                </div>
            </div>
            <textarea
                id="novel-refine-instructions"
                className="inputbox textarea-refine"
                rows={1}
                placeholder="Optional: Add specific instructions for Refine Novel, such as pacing, inner life, dialogue, scene expansion, prose cleanup, or things to preserve."
                spellCheck={false}
                onChange={actions.onNovelRefineInstructionsChange}
            />
        </div>
    );
}

function NovelEditor({
    actions,
    viewState,
}: AppProps) {
    return (
        <div className="tabs-container flex-grow" data-for="novel-content">
            <div className="tabs-header">
                <span className="tab-label">Novel</span>
                <button className="tab-btn active" type="button" data-tab="edit">✍️ Edit</button>
                <button className="tab-btn" type="button" data-tab="preview">👁️ Preview</button>
                <select id="novel-chapter-jump" className="inputbox chapter-jump-select" title="Jump to chapter" defaultValue="">
                    <option value="">Chapter...</option>
                </select>
                <div className="spacer" />
                <FontControls actions={actions} scope="novel" settings={viewState.typography.novel} />
            </div>
            <div className="tab-content flex-grow" style={tabContentColumnStyle}>
                <div className="tab-pane active" data-pane="edit">
                    <textarea
                        id="novel-content"
                        className="inputbox textarea-novel"
                        placeholder="The generated novel will stream here..."
                        spellCheck={false}
                    />
                </div>
                <div className="tab-pane" data-pane="preview">
                    <div id="novel-content-preview" className="markdown-body inputbox textarea-novel" />
                </div>
            </div>
        </div>
    );
}

function NovelSection({
    actions,
    viewState,
}: AppProps) {
    return (
        <section className="card content-section flex-grow">
            <NovelToolbar actions={actions} />
            <div className="status-bar">
                <span>Status: </span><span id="novel-status" className="novel-status-text">Idle</span>
            </div>
            <NovelRefineInstructions actions={actions} activity={viewState.activity} />
            <NovelEditor actions={actions} viewState={viewState} />
        </section>
    );
}

function MainContent({
    actions,
    viewState,
}: AppProps) {
    return (
        <main className="main-content">
            <SeedPlotSection actions={actions} viewState={viewState} />
            <NovelSection actions={actions} viewState={viewState} />
        </main>
    );
}

function ModalOverlay() {
    return (
        <div id="modal-overlay" className="modal-overlay" style={hiddenGroupStyle}>
            <div className="modal-box">
                <h3 id="modal-title">Confirm</h3>
                <p id="modal-message">Are you sure?</p>
                <div className="modal-actions">
                    <button id="modal-cancel" className="btn btn-secondary" type="button">Cancel</button>
                    <button id="modal-confirm" className="btn btn-danger" type="button">Confirm</button>
                </div>
            </div>
        </div>
    );
}

export function NovelgenApp({ actions, viewState }: AppProps) {
    return (
        <>
            <div id="toast-container" />
            <div className="app-container">
                <Sidebar actions={actions} viewState={viewState} />
                <div className="resizer" id="sidebar-resizer" />
                <MainContent actions={actions} viewState={viewState} />
            </div>
            <ModalOverlay />
        </>
    );
}
