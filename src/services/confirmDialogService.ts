import { runtimeViewStateStore } from './runtimeViewStateStore.js';

let pendingResolve: ((confirmed: boolean) => void) | null = null;

function closeConfirmDialog(confirmed: boolean) {
    const resolve = pendingResolve;
    pendingResolve = null;
    runtimeViewStateStore.setConfirmDialog({
        isOpen: false,
        title: '',
        message: '',
    });
    resolve?.(confirmed);
}

export function showConfirmDialog(title: string, message: string) {
    if (pendingResolve) {
        closeConfirmDialog(false);
    }

    return new Promise<boolean>((resolve) => {
        pendingResolve = resolve;
        runtimeViewStateStore.setConfirmDialog({
            isOpen: true,
            title,
            message,
        });
    });
}

export function confirmDialog() {
    closeConfirmDialog(true);
}

export function cancelConfirmDialog() {
    closeConfirmDialog(false);
}
