export let invoke: TauriInvoke;
export let Channel: TauriChannelConstructor;

export function initTauriApi(showToast: (message: string, type?: string) => void = () => {}) {
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
        const message = e instanceof Error ? e.message : String(e);
        showToast("API Initialization failed: " + message, 'error');
    }
}
