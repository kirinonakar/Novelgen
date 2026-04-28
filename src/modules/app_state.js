export const AppState = {
    stopRequested: false,
    isPaused: false,
    isWorkerRunning: false,
    isNovelRefining: false,
    taskQueue: [],
    lastRanJobUid: null,
    pendingProcessQueue: false,
    loadedNovelFilename: null,
    loadedNovelMetadata: null,

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
    },

    clearLoadedNovel() {
        this.loadedNovelFilename = null;
        this.loadedNovelMetadata = null;
    },
};
