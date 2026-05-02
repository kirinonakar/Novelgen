import { els } from './dom_refs.js';
import { invoke } from './tauri_api.js';

const THEME_STORAGE_KEY = 'ui-theme';
const DEFAULT_FONT_SIZE = '16';
const DEFAULT_WRAP_WIDTH = '42';

const PREVIEW_ELEMENT_MAP = {
    seed: 'plotSeedPreview',
    plot: 'plotContentPreview',
    novel: 'novelContentPreview'
};

const FONT_SIZE_STORAGE_KEY_MAP = {
    seed: 'fs-seed',
    plot: 'fs-plot',
    novel: 'fs-novel'
};

const WRAP_WIDTH_STORAGE_KEY_MAP = {
    seed: 'wrap-seed',
    plot: 'wrap-plot',
    novel: 'wrap-novel'
};

const COMFORT_STORAGE_KEY_MAP = {
    seed: 'comfort-seed',
    plot: 'comfort-plot',
    novel: 'comfort-novel'
};

const FONT_SIZE_SLIDER_MAP = {
    seed: 'seedFsSlider',
    plot: 'plotFsSlider',
    novel: 'novelFsSlider'
};

const WRAP_WIDTH_SLIDER_MAP = {
    seed: 'seedWrapSlider',
    plot: 'plotWrapSlider',
    novel: 'novelWrapSlider'
};

function getSavedTheme() {
    try {
        const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
        return savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : null;
    } catch (e) {
        console.warn("[Frontend] Failed to read saved theme:", e);
        return null;
    }
}

function getSystemTheme() {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncThemeToggle(theme) {
    if (!els.themeToggle) return;

    const isDark = theme === 'dark';
    const nextThemeLabel = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    const icon = isDark ? '☀️' : '🌙';
    const iconEl = els.themeToggle.querySelector('.theme-toggle-icon');

    els.themeToggle.dataset.theme = theme;
    els.themeToggle.setAttribute('aria-pressed', String(isDark));
    els.themeToggle.setAttribute('aria-label', nextThemeLabel);
    els.themeToggle.setAttribute('title', nextThemeLabel);
    if (iconEl) iconEl.textContent = icon;
}

function syncNativeWindowTheme(theme) {
    if (typeof invoke !== 'function') return;

    invoke('set_window_theme', { theme }).catch((e) => {
        console.warn("[Frontend] Failed to sync native window theme:", e);
    });
}

function applyTheme(theme, { persist = true } = {}) {
    const resolvedTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = resolvedTheme;
    syncThemeToggle(resolvedTheme);
    syncNativeWindowTheme(resolvedTheme);

    if (!persist) return;

    try {
        localStorage.setItem(THEME_STORAGE_KEY, resolvedTheme);
    } catch (e) {
        console.warn("[Frontend] Failed to persist theme:", e);
    }
}

export function toggleTheme() {
    const currentTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

export function initTheme() {
    const currentTheme = document.documentElement.dataset.theme;
    const resolvedTheme =
        getSavedTheme() ||
        (currentTheme === 'dark' || currentTheme === 'light' ? currentTheme : null) ||
        getSystemTheme();

    applyTheme(resolvedTheme, { persist: false });
}

export function setFontSize(type, size) {
    const valEl = els[`${type}FsVal`];
    if (valEl) valEl.innerText = size;
    document.documentElement.style.setProperty(`--${type}-font-size`, `${size}px`);
}

export function setWrapWidth(type, size) {
    const valEl = els[`${type}WrapVal`];
    const previewKey = PREVIEW_ELEMENT_MAP[type];
    const previewEl = previewKey ? els[previewKey] : null;

    if (valEl) valEl.innerText = size;
    document.documentElement.style.setProperty(`--${type}-wrap-width`, `${size}em`);
    if (previewEl) previewEl.style.setProperty('--preview-wrap-width', `${size}em`);
}

export function setComfortMode(type, enabled, { persist = false } = {}) {
    const previewKey = PREVIEW_ELEMENT_MAP[type];
    const previewEl = previewKey ? els[previewKey] : null;
    const toggleEl = els[`${type}ComfortToggle`];
    const isEnabled = Boolean(enabled);

    if (toggleEl) toggleEl.checked = isEnabled;
    if (previewEl) previewEl.classList.toggle('comfort-mode', isEnabled);
    if (persist && COMFORT_STORAGE_KEY_MAP[type]) {
        localStorage.setItem(COMFORT_STORAGE_KEY_MAP[type], String(isEnabled));
    }
}

export function saveUiSettings() {
    for (const [type, storageKey] of Object.entries(FONT_SIZE_STORAGE_KEY_MAP)) {
        const slider = els[FONT_SIZE_SLIDER_MAP[type]];
        if (slider) localStorage.setItem(storageKey, slider.value);
    }

    for (const [type, storageKey] of Object.entries(WRAP_WIDTH_STORAGE_KEY_MAP)) {
        const slider = els[WRAP_WIDTH_SLIDER_MAP[type]];
        if (slider) localStorage.setItem(storageKey, slider.value);
    }

    for (const [type, storageKey] of Object.entries(COMFORT_STORAGE_KEY_MAP)) {
        const toggle = els[`${type}ComfortToggle`];
        if (toggle) localStorage.setItem(storageKey, String(toggle.checked));
    }
}

export function restoreUiSettings() {
    for (const [type, storageKey] of Object.entries(FONT_SIZE_STORAGE_KEY_MAP)) {
        const savedSize = localStorage.getItem(storageKey) || DEFAULT_FONT_SIZE;
        const slider = els[FONT_SIZE_SLIDER_MAP[type]];
        if (slider) slider.value = savedSize;
        setFontSize(type, savedSize);
    }

    for (const [type, storageKey] of Object.entries(WRAP_WIDTH_STORAGE_KEY_MAP)) {
        const savedWidth = localStorage.getItem(storageKey) || DEFAULT_WRAP_WIDTH;
        const slider = els[WRAP_WIDTH_SLIDER_MAP[type]];
        if (slider) slider.value = savedWidth;
        setWrapWidth(type, savedWidth);
    }

    for (const [type, storageKey] of Object.entries(COMFORT_STORAGE_KEY_MAP)) {
        setComfortMode(type, localStorage.getItem(storageKey) === 'true');
    }
}
