import { useEffect, useRef } from 'react';
import { useGlobalFileDropGuards } from '../hooks/useGlobalFileDropGuards.js';
import { installSidebarResizer } from '../services/sidebarResizerService.js';
import type { AppProps } from './componentTypes.js';
import { ModalOverlay } from './ModalOverlay.js';
import { NovelSection } from './NovelSection.js';
import { SeedPlotSection } from './SeedPlotSection.js';
import { Sidebar } from './Sidebar.js';
import { ToastContainer } from './ToastContainer.js';

export function NovelgenApp({ actions, viewState }: AppProps) {
    const sidebarRef = useRef<HTMLElement | null>(null);
    const resizerRef = useRef<HTMLDivElement | null>(null);

    useGlobalFileDropGuards();

    useEffect(() => {
        if (!sidebarRef.current || !resizerRef.current) return;
        return installSidebarResizer({
            resizer: resizerRef.current,
            sidebar: sidebarRef.current,
        });
    }, []);

    return (
        <>
            <ToastContainer />
            <div className="app-container">
                <Sidebar actions={actions} sidebarRef={sidebarRef} viewState={viewState} />
                <div className="resizer" id="sidebar-resizer" ref={resizerRef} />
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
