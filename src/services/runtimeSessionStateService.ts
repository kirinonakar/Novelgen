import { novelRevisionStore } from './novelRevisionStore.js';

export const runtimeSessionState = {
    stopRequested: false,
    isPaused: false,
    isWorkerRunning: false,
    isNovelRefining: false,
    taskQueue: [],
    lastRanJobUid: null,
    pendingProcessQueue: false,
    loadedNovelFilename: null,
    loadedNovelMetadata: null,
    activeNovelFilename: null,

    reset({ clearStopRequested = true } = {}) {
        this.taskQueue = [];
        this.isPaused = false;
        this.lastRanJobUid = null;
        this.pendingProcessQueue = false;
        if (clearStopRequested) {
            this.stopRequested = false;
        }
    },

    setLoadedNovel(filename, metadata = null) {
        this.loadedNovelFilename = filename || null;
        this.loadedNovelMetadata = metadata || null;
        novelRevisionStore.load(this.loadedNovelFilename, metadata?.last_refinement);
    },

    setActiveNovel(filename) {
        this.activeNovelFilename = filename || null;
    },

    clearActiveNovel() {
        this.activeNovelFilename = null;
    },

    clearLoadedNovel() {
        this.loadedNovelFilename = null;
        this.loadedNovelMetadata = null;
        novelRevisionStore.load(null);
        this.clearActiveNovel();
    },
};

export function clearLoadedNovelSession() {
    runtimeSessionState.clearLoadedNovel();
}
