import type { CSSProperties } from 'react';
import type {
    RefineInstructionsViewState,
    RuntimeActivityViewState,
    SavedContentViewState,
    TypographyScopeViewState,
} from '../types/app.js';
import type { ActionProps, AppProps } from './componentTypes.js';
import { FontControls } from './FontControls.js';

const tabContentColumnStyle: CSSProperties = { display: 'flex', flexDirection: 'column' };
const wrappedActionBarStyle: CSSProperties = { flexWrap: 'wrap' };
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
const novelSelectStyle: CSSProperties = { flex: 1, minWidth: 250, height: 35 };

function NovelToolbar({
    actions,
    nextChapter,
    savedContent,
}: ActionProps & {
    nextChapter: string;
    savedContent: SavedContentViewState;
}) {
    return (
        <div className="section-header">
            <div className="action-bar header-actions" style={wrappedActionBarStyle}>
                <button className="btn btn-primary pulse-hover" id="btn-gen-novel" type="button" onClick={actions.onGenerateNovel}>🚀 Start Novel Generation</button>
                <button className="btn btn-secondary" id="btn-refine-novel" type="button" title="Refine the current novel chapter-by-chapter against the plot" onClick={actions.onRefineNovel}>✨ Refine Novel</button>
                <button className="btn btn-danger" id="btn-stop-novel" type="button" onClick={actions.onStopNovel}>⏹️ Stop</button>
                <button className="btn btn-ghost" id="btn-clear-novel" type="button" title="Clear current novel content" onClick={actions.onClearNovel}>🗑️ Clear</button>

                <div className="auto-flex" style={nextChapterControlsStyle}>
                    <label htmlFor="resume-chapter" style={inlineLabelStyle}>Next Chapter</label>
                    <input
                        type="number"
                        id="resume-chapter"
                        className="inputbox"
                        value={nextChapter}
                        min="1"
                        style={resumeInputStyle}
                        onChange={event => actions.onNextChapterChange(event.currentTarget.value)}
                    />
                    <button id="find-ch-btn" className="btn btn-secondary" type="button" title="Auto-detect next chapter from main text" style={smallButtonStyle} onClick={actions.onFindNextChapter}>🔄</button>
                </div>

                <div className="auto-flex" style={novelFileControlsStyle}>
                    <button className="btn btn-secondary" id="open-out-folder-btn" type="button" style={toolbarButtonStyle} onClick={actions.onOpenOutputFolder}>📂 Open Output Folder</button>
                    <select
                        id="saved-novels"
                        className="inputbox"
                        style={novelSelectStyle}
                        value={savedContent.selectedNovel}
                        onChange={event => actions.onSavedNovelChange(event.currentTarget.value)}
                    >
                        <option value="" disabled>Select a novel...</option>
                        {savedContent.novelFiles.map(filename => (
                            <option key={filename} value={filename}>{filename}</option>
                        ))}
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
    refineInstructions,
    refineStartChapter,
    refineEndChapter,
}: ActionProps & {
    activity: RuntimeActivityViewState;
    refineInstructions: RefineInstructionsViewState;
    refineStartChapter: string;
    refineEndChapter: string;
}) {
    return (
        <div className="refine-instructions-block">
            <div className="refine-instructions-header">
                <div className="refine-title-actions">
                    <label htmlFor="novel-refine-instructions">Novel Refine Instructions</label>
                    <div className="chapter-range-controls" aria-label="Novel refine chapter range">
                        <label htmlFor="novel-refine-start-chapter">Start Chapter</label>
                        <input
                            type="number"
                            id="novel-refine-start-chapter"
                            className="inputbox chapter-range-input"
                            min="1"
                            placeholder="All"
                            value={refineStartChapter}
                            onChange={event => actions.onNovelRefineStartChapterChange(event.currentTarget.value)}
                        />
                        <label htmlFor="novel-refine-end-chapter">End Chapter</label>
                        <input
                            type="number"
                            id="novel-refine-end-chapter"
                            className="inputbox chapter-range-input"
                            min="1"
                            placeholder="All"
                            value={refineEndChapter}
                            onChange={event => actions.onNovelRefineEndChapterChange(event.currentTarget.value)}
                        />
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
                value={refineInstructions.novel}
                onChange={event => actions.onNovelRefineInstructionsChange(event.currentTarget.value)}
            />
        </div>
    );
}

interface NovelEditorProps extends ActionProps {
    novelContent: string;
    novelTypography: TypographyScopeViewState;
}

function NovelEditor({
    actions,
    novelContent,
    novelTypography,
}: NovelEditorProps) {
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
                <FontControls actions={actions} scope="novel" settings={novelTypography} />
            </div>
            <div className="tab-content flex-grow" style={tabContentColumnStyle}>
                <div className="tab-pane active" data-pane="edit">
                    <textarea
                        id="novel-content"
                        className="inputbox textarea-novel"
                        placeholder="The generated novel will stream here..."
                        spellCheck={false}
                        value={novelContent}
                        onChange={event => actions.onNovelContentChange(event.currentTarget.value)}
                    />
                </div>
                <div className="tab-pane" data-pane="preview">
                    <div id="novel-content-preview" className="markdown-body inputbox textarea-novel" />
                </div>
            </div>
        </div>
    );
}

export function NovelSection({
    actions,
    viewState,
}: AppProps) {
    return (
        <section className="card content-section flex-grow">
            <NovelToolbar
                actions={actions}
                nextChapter={viewState.editor.nextChapter}
                savedContent={viewState.savedContent}
            />
            <div className="status-bar">
                <span>Status: </span><span id="novel-status" className="novel-status-text">{viewState.editor.novelStatus.message}</span>
            </div>
            <NovelRefineInstructions
                actions={actions}
                activity={viewState.activity}
                refineInstructions={viewState.refineInstructions}
                refineStartChapter={viewState.editor.novelRefineStartChapter}
                refineEndChapter={viewState.editor.novelRefineEndChapter}
            />
            <NovelEditor
                actions={actions}
                novelContent={viewState.editor.novel}
                novelTypography={viewState.typography.novel}
            />
        </section>
    );
}
