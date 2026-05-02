import type { CSSProperties } from 'react';
import type {
    RefineInstructionsViewState,
    RuntimeActivityViewState,
    SavedContentViewState,
    TypographyScopeViewState,
} from '../types/app.js';
import { getTokenEstimate } from '../utils/tokenMetrics.js';
import type { ActionProps, AppProps } from './componentTypes.js';
import { FontControls } from './FontControls.js';

const tabContentColumnStyle: CSSProperties = { display: 'flex', flexDirection: 'column' };
const wrappedActionBarStyle: CSSProperties = { flexWrap: 'wrap' };
const plotFileControlsStyle: CSSProperties = {
    gap: 4,
    borderLeft: '1px solid var(--border-color)',
    paddingLeft: 12,
    marginLeft: 4,
    flexGrow: 1
};
const toolbarButtonStyle: CSSProperties = { flexShrink: 0, height: 35 };
const plotSelectStyle: CSSProperties = { flex: 1, minWidth: 150, height: 35 };

interface SeedEditorProps extends ActionProps {
    seed: string;
    seedTypography: TypographyScopeViewState;
}

function SeedEditor({
    actions,
    seed,
    seedTypography,
}: SeedEditorProps) {
    return (
        <div className="tabs-container" data-for="plot-seed">
            <div className="tabs-header">
                <span className="tab-label">Seed</span>
                <button className="tab-btn active" type="button" data-tab="edit">✍️ Edit</button>
                <button className="tab-btn" type="button" data-tab="preview">👁️ Preview</button>
                <button id="auto-seed-btn" className="btn btn-magic seed-auto-btn" type="button" onClick={actions.onAutoSeed}>🎲 Auto Seed</button>
                <div className="spacer" />
                <FontControls actions={actions} scope="seed" settings={seedTypography} />
            </div>
            <div className="tab-content">
                <div className="tab-pane active" data-pane="edit">
                    <textarea
                        id="plot-seed"
                        className="inputbox textarea-seed"
                        rows={3}
                        placeholder="Enter the core novel idea or auto-generate..."
                        spellCheck={false}
                        value={seed}
                        onChange={event => actions.onSeedChange(event.currentTarget.value)}
                    />
                </div>
                <div className="tab-pane" data-pane="preview">
                    <div id="plot-seed-preview" className="markdown-body inputbox textarea-seed" />
                </div>
            </div>
        </div>
    );
}

function PlotToolbar({
    actions,
    savedContent,
}: ActionProps & { savedContent: SavedContentViewState }) {
    return (
        <div className="action-bar" style={wrappedActionBarStyle}>
            <button className="btn btn-primary" id="btn-gen-plot" type="button" onClick={actions.onGeneratePlot}>✨ Generate Plot Outline</button>
            <button className="btn btn-secondary" id="btn-refine-plot" type="button" onClick={actions.onRefinePlot}>✨ Refine Plot</button>
            <button className="btn btn-danger" id="btn-stop-plot" type="button" onClick={actions.onStopPlot}>⏹️ Stop</button>

            <div className="auto-flex plot-file-controls" style={plotFileControlsStyle}>
                <select
                    id="saved-plots"
                    className="inputbox plot-file-select"
                    style={plotSelectStyle}
                    value={savedContent.selectedPlot}
                    onChange={event => actions.onSavedPlotChange(event.currentTarget.value)}
                >
                    <option value="" disabled>Select a saved plot...</option>
                    {savedContent.plotFiles.map(filename => (
                        <option key={filename} value={filename}>{filename}</option>
                    ))}
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
    refineInstructions,
}: ActionProps & {
    activity: RuntimeActivityViewState;
    refineInstructions: RefineInstructionsViewState;
}) {
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
                value={refineInstructions.plot}
                onChange={event => actions.onPlotRefineInstructionsChange(event.currentTarget.value)}
            />
        </div>
    );
}

interface PlotEditorProps extends ActionProps {
    plotContent: string;
    plotTypography: TypographyScopeViewState;
}

function PlotEditor({
    actions,
    plotContent,
    plotTypography,
}: PlotEditorProps) {
    const tokenEstimate = getTokenEstimate(plotContent);

    return (
        <div className="tabs-container flex-grow" data-for="plot-content">
            <div className="tabs-header">
                <span className="tab-label">Plot</span>
                <button className="tab-btn active" type="button" data-tab="edit">✍️ Edit</button>
                <button className="tab-btn" type="button" data-tab="preview">👁️ Preview</button>
                <span id="plot-token-count" className="token-count" title={tokenEstimate.title}>{tokenEstimate.label}</span>
                <div className="spacer" />
                <FontControls actions={actions} scope="plot" settings={plotTypography} />
            </div>
            <div className="tab-content flex-grow" style={tabContentColumnStyle}>
                <div className="tab-pane active" data-pane="edit">
                    <textarea
                        id="plot-content"
                        className="inputbox textarea-plot"
                        rows={8}
                        placeholder="Generated plot will appear here. You can manually edit it before generating the novel."
                        spellCheck={false}
                        value={plotContent}
                        onChange={event => actions.onPlotContentChange(event.currentTarget.value)}
                    />
                </div>
                <div className="tab-pane" data-pane="preview">
                    <div id="plot-content-preview" className="markdown-body inputbox textarea-plot" />
                </div>
            </div>
        </div>
    );
}

export function SeedPlotSection({
    actions,
    viewState,
}: AppProps) {
    return (
        <section className="card content-section">
            <SeedEditor
                actions={actions}
                seed={viewState.editor.seed}
                seedTypography={viewState.typography.seed}
            />
            <PlotToolbar actions={actions} savedContent={viewState.savedContent} />
            <div className="status-bar">
                <span>Status: </span><span id="plot-status-msg" className="novel-status-text">{viewState.editor.plotStatus.message}</span>
            </div>
            <PlotRefineInstructions
                actions={actions}
                activity={viewState.activity}
                refineInstructions={viewState.refineInstructions}
            />
            <PlotEditor
                actions={actions}
                plotContent={viewState.editor.plot}
                plotTypography={viewState.typography.plot}
            />
        </section>
    );
}
