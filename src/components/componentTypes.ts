import type { NovelgenRuntimeActions, RuntimeViewState } from '../types/app.js';

export interface AppProps {
    actions: NovelgenRuntimeActions;
    viewState: RuntimeViewState;
}

export interface ActionProps {
    actions: NovelgenRuntimeActions;
}
