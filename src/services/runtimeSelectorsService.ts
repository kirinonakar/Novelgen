import type { ApiProvider, Language } from '../types/app.js';
import { runtimeViewStateStore } from './runtimeViewStateStore.js';

export const getSelectedLanguage = (): Language => {
    return runtimeViewStateStore.getSnapshot().generationParams.language;
};

export const getSelectedProvider = (): ApiProvider => {
    return runtimeViewStateStore.getSnapshot().apiSettings.provider;
};
