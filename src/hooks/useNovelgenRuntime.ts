import { useEffect, useSyncExternalStore } from 'react';
import { createNovelgenRuntimeController } from '../services/novelgenRuntimeController.js';
import { runtimeViewStateStore } from '../services/runtimeViewStateStore.js';
import type { NovelgenRuntimeActions, RuntimeViewState } from '../types/app.js';

const runtimeController = createNovelgenRuntimeController();

export function useNovelgenRuntime(): { actions: NovelgenRuntimeActions; viewState: RuntimeViewState } {
    const viewState = useSyncExternalStore(
        runtimeViewStateStore.subscribe,
        runtimeViewStateStore.getSnapshot,
        runtimeViewStateStore.getSnapshot,
    );

    useEffect(() => {
        void runtimeController.initialize();
    }, []);

    return { actions: runtimeController.actions, viewState };
}
