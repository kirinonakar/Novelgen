import { runtimeSessionState } from './runtimeSessionStateService.js';

const STORAGE_KEY = 'novelgen.batchQueue.v1';

export function persistBatchQueue() {
    try {
        if (runtimeSessionState.taskQueue.length === 0) {
            localStorage.removeItem(STORAGE_KEY);
            return;
        }
        const jobs = runtimeSessionState.taskQueue.map(job => {
            const { rateLimitRetryCountdownId, rateLimitRetryTimeoutId, initialText, ...saved } = job;
            return job.novelFilename ? saved : { ...saved, initialText };
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            jobs,
            lastRanJobUid: runtimeSessionState.lastRanJobUid,
        }));
    } catch (error) {
        console.warn('[Batch] Cannot persist queue checkpoint:', error);
    }
}

export function restoreBatchQueue() {
    if (runtimeSessionState.taskQueue.length > 0) return false;
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (!Array.isArray(saved?.jobs) || saved.jobs.length === 0) return false;
        if (!saved.jobs.every(job => job && ['single', 'batch'].includes(job.type)
            && Number.isFinite(job.uid) && Number.isInteger(job.totalChapters) && job.totalChapters > 0
            && (!job.novelFilename || /^novel_[^/\\:]+\.txt$/.test(job.novelFilename)))) {
            throw new Error('Invalid saved batch queue');
        }
        runtimeSessionState.taskQueue = saved.jobs.map(job => ({
            ...job,
            rateLimitRetryCountdownId: null,
            rateLimitRetryTimeoutId: null,
            rateLimitRetryLabel: null,
            // Recovery always waits for an explicit Resume; timers never survive a restart.
            canResumeNovelGeneration: true,
        }));
        runtimeSessionState.lastRanJobUid = saved.lastRanJobUid;
        runtimeSessionState.isPaused = true;
        return true;
    } catch (error) {
        console.warn('[Batch] Cannot restore queue checkpoint:', error);
        return false;
    }
}
