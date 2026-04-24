export const AppState = {
    stopRequested: false,
    isPaused: false,
    isWorkerRunning: false,
    taskQueue: [],
    lastRanJobUid: null,
    loadedNovelFilename: null,
    loadedNovelMetadata: null,

    reset() {
        this.taskQueue = [];
        this.isPaused = false;
        this.lastRanJobUid = null;
        this.stopRequested = false;
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
