import { runtimeViewStateStore } from './runtimeViewStateStore.js';

function parsePositiveInt(value: string, fallback: number) {
    const parsed = parseInt(String(value || '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getTotalChaptersParam(fallback = 1) {
    return parsePositiveInt(runtimeViewStateStore.getSnapshot().generationParams.totalChapters, fallback);
}

export function getTargetTokensParam(fallback = 2000) {
    return parsePositiveInt(runtimeViewStateStore.getSnapshot().generationParams.targetTokens, fallback);
}
