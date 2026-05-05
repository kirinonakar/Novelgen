import { useSyncExternalStore } from 'react';
import {
    dismissToast,
    getToastSnapshot,
    subscribeToToasts,
    type ToastType,
} from '../modules/toast.js';

const TOAST_ICONS: Record<ToastType, string> = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️',
};

export function ToastContainer() {
    const toasts = useSyncExternalStore(
        subscribeToToasts,
        getToastSnapshot,
        getToastSnapshot,
    );

    return (
        <div id="toast-container" aria-live="polite" aria-atomic="true">
            {toasts.map(toast => (
                <div
                    key={toast.id}
                    className={`toast toast-${toast.type}${toast.removing ? ' removing' : ''}`}
                    role="status"
                >
                    <div className="toast-icon" aria-hidden="true">{TOAST_ICONS[toast.type]}</div>
                    <div className="toast-message">{toast.message}</div>
                    <button
                        className="toast-close"
                        type="button"
                        aria-label="Dismiss notification"
                        onClick={() => dismissToast(toast.id)}
                    >
                        ✕
                    </button>
                </div>
            ))}
        </div>
    );
}
