import type { ThemeMode, TypographyScope, TypographyViewState } from '../types/app.js';
import { els } from './dom_refs.js';
import { invoke } from './tauri_api.js';

const THEME_STORAGE_KEY = 'ui-theme';
const DEFAULT_FONT_SIZE = '16';
const DEFAULT_WRAP_WIDTH = '42';

const TYPOGRAPHY_SCOPES: TypographyScope[] = ['seed', 'plot', 'novel'];

const PREVIEW_ELEMENT_MAP: Record<TypographyScope, keyof typeof els> = {
    seed: 'plotSeedPreview',
    plot: 'plotContentPreview',
    novel: 'novelContentPreview'
};

const FONT_SIZE_STORAGE_KEY_MAP: Record<TypographyScope, string> = {
    seed: 'fs-seed',
    plot: 'fs-plot',
    novel: 'fs-novel'
};

const WRAP_WIDTH_STORAGE_KEY_MAP: Record<TypographyScope, string> = {
    seed: 'wrap-seed',
    plot: 'wrap-plot',
    novel: 'wrap-novel'
};

const COMFORT_STORAGE_KEY_MAP: Record<TypographyScope, string> = {
    seed: 'comfort-seed',
    plot: 'comfort-plot',
    novel: 'comfort-novel'
};

function getSavedTheme(): ThemeMode | null {
    try {
        const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
        return savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : null;
    } catch (e) {
        console.warn("[Frontend] Failed to read saved theme:", e);
        return null;
    }
}

function getSystemTheme(): ThemeMode {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncNativeWindowTheme(theme: ThemeMode) {
    if (typeof invoke !== 'function') return;

    invoke('set_window_theme', { theme }).catch((e) => {
        console.warn("[Frontend] Failed to sync native window theme:", e);
    });
}

function applyTheme(theme: ThemeMode, { persist = true } = {}): ThemeMode {
    const resolvedTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = resolvedTheme;
    syncNativeWindowTheme(resolvedTheme);

    if (!persist) return resolvedTheme;

    try {
        localStorage.setItem(THEME_STORAGE_KEY, resolvedTheme);
    } catch (e) {
        console.warn("[Frontend] Failed to persist theme:", e);
    }

    return resolvedTheme;
}

export function toggleTheme(): ThemeMode {
    const currentTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    return applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

export function initTheme(): ThemeMode {
    const currentTheme = document.documentElement.dataset.theme;
    const resolvedTheme =
        getSavedTheme() ||
        (currentTheme === 'dark' || currentTheme === 'light' ? currentTheme : null) ||
        getSystemTheme();

    return applyTheme(resolvedTheme, { persist: false });
}

export function setFontSize(type: TypographyScope, size: string) {
    document.documentElement.style.setProperty(`--${type}-font-size`, `${size}px`);
}

export function setWrapWidth(type: TypographyScope, size: string) {
    const previewKey = PREVIEW_ELEMENT_MAP[type];
    const previewEl = previewKey ? els[previewKey] : null;

    document.documentElement.style.setProperty(`--${type}-wrap-width`, `${size}em`);
    if (previewEl) previewEl.style.setProperty('--preview-wrap-width', `${size}em`);
}

export function setComfortMode(type: TypographyScope, enabled: boolean, { persist = false } = {}) {
    const previewKey = PREVIEW_ELEMENT_MAP[type];
    const previewEl = previewKey ? els[previewKey] : null;
    const isEnabled = Boolean(enabled);

    if (previewEl) previewEl.classList.toggle('comfort-mode', isEnabled);
    if (persist && COMFORT_STORAGE_KEY_MAP[type]) {
        localStorage.setItem(COMFORT_STORAGE_KEY_MAP[type], String(isEnabled));
    }
}

export function saveUiSettings(typography: TypographyViewState) {
    for (const scope of TYPOGRAPHY_SCOPES) {
        const settings = typography[scope];
        localStorage.setItem(FONT_SIZE_STORAGE_KEY_MAP[scope], settings.fontSize);
        localStorage.setItem(WRAP_WIDTH_STORAGE_KEY_MAP[scope], settings.wrapWidth);
        localStorage.setItem(COMFORT_STORAGE_KEY_MAP[scope], String(settings.comfort));
    }
}

export function restoreUiSettings(): TypographyViewState {
    const restored = {} as TypographyViewState;

    for (const scope of TYPOGRAPHY_SCOPES) {
        const fontSize = localStorage.getItem(FONT_SIZE_STORAGE_KEY_MAP[scope]) || DEFAULT_FONT_SIZE;
        const wrapWidth = localStorage.getItem(WRAP_WIDTH_STORAGE_KEY_MAP[scope]) || DEFAULT_WRAP_WIDTH;
        const comfort = localStorage.getItem(COMFORT_STORAGE_KEY_MAP[scope]) === 'true';

        restored[scope] = { fontSize, wrapWidth, comfort };
        setFontSize(scope, fontSize);
        setWrapWidth(scope, wrapWidth);
        setComfortMode(scope, comfort);
    }

    return restored;
}
