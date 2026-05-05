export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
    id: number;
    message: string;
    removing: boolean;
    type: ToastType;
}

const TOAST_EXIT_DELAY_MS = 300;
let nextToastId = 1;
let toasts: ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
    listeners.forEach(listener => listener());
}

export function subscribeToToasts(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getToastSnapshot() {
    return toasts;
}

export function dismissToast(id: number) {
    const timer = timers.get(id);
    if (timer) {
        clearTimeout(timer);
        timers.delete(id);
    }

    const toast = toasts.find(item => item.id === id);
    if (!toast || toast.removing) return;

    toasts = toasts.map(item =>
        item.id === id ? { ...item, removing: true } : item
    );
    emit();

    timers.set(id, setTimeout(() => {
        timers.delete(id);
        toasts = toasts.filter(item => item.id !== id);
        emit();
    }, TOAST_EXIT_DELAY_MS));
}

export function showToast(message: string, type: ToastType = 'info', duration = 4000) {
    const id = nextToastId++;
    toasts = [
        ...toasts,
        {
            id,
            message,
            removing: false,
            type,
        },
    ];
    emit();

    timers.set(id, setTimeout(() => {
        dismissToast(id);
    }, duration));
}
