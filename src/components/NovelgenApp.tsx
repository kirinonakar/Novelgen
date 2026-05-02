import type { AppProps } from './componentTypes.js';
import { ModalOverlay } from './ModalOverlay.js';
import { NovelSection } from './NovelSection.js';
import { SeedPlotSection } from './SeedPlotSection.js';
import { Sidebar } from './Sidebar.js';

export function NovelgenApp({ actions, viewState }: AppProps) {
    return (
        <>
            <div id="toast-container" />
            <div className="app-container">
                <Sidebar actions={actions} viewState={viewState} />
                <div className="resizer" id="sidebar-resizer" />
                <main className="main-content">
                    <SeedPlotSection actions={actions} viewState={viewState} />
                    <NovelSection actions={actions} viewState={viewState} />
                </main>
            </div>
            <ModalOverlay
                dialog={viewState.confirmDialog}
                onCancel={actions.onConfirmDialogCancel}
                onConfirm={actions.onConfirmDialogConfirm}
            />
        </>
    );
}
