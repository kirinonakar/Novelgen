import { initTauriApi } from '../modules/tauri_api.js';
import { showToast } from '../modules/toast.js';

function installRuntimeErrorHandler() {
    window.onerror = function (msg, url, lineNo, columnNo) {
        const errorMsg = `Error: ${msg}\nLine: ${lineNo}\nColumn: ${columnNo}\nURL: ${url}`;
        console.error(errorMsg);
        showToast('NovelGen Runtime Error', 'error');
        return false;
    };
}

function configureMarkdownRenderer() {
    if (!window.marked) return;

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const renderer = new window.marked.Renderer();
    renderer.html = ({ text }) => escapeHtml(text);

    if (window.markedKatex) {
        window.marked.use(window.markedKatex({
            throwOnError: false,
            displayMode: false,
            nonStandard: true,
        }));
    }

    window.marked.use({
        breaks: true,
        gfm: true,
        renderer,
    });
}

export function initializeRuntimeServices() {
    console.log('[Frontend] React runtime starting...');
    installRuntimeErrorHandler();
    configureMarkdownRenderer();
    initTauriApi(showToast);
}
