export let invoke;
export let Channel;

export function initTauriApi(showToast = () => {}) {
    try {
        if (window.__TAURI__ && window.__TAURI__.core) {
            invoke = window.__TAURI__.core.invoke;
            Channel = window.__TAURI__.core.Channel;
            console.log("[Frontend] Tauri API initialized from window.__TAURI__.core");
        } else {
            throw new Error("window.__TAURI__.core not found. Check tauri.conf.json withGlobalTauri.");
        }
    } catch (e) {
        console.error("[Frontend] API Initialization failed", e);
        showToast("API Initialization failed: " + e.message, 'error');
    }
}
