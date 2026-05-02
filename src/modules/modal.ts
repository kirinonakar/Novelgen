import { els } from './dom_refs.js';

export function showConfirm(title, message) {
    return new Promise((resolve) => {
        els.modalTitle.innerText = title;
        els.modalMessage.innerText = message;
        els.modalOverlay.style.display = 'flex';

        const onConfirm = () => {
            cleanup();
            resolve(true);
        };
        const onCancel = () => {
            cleanup();
            resolve(false);
        };
        const cleanup = () => {
            els.modalOverlay.style.display = 'none';
            els.modalConfirmBtn.removeEventListener('click', onConfirm);
            els.modalCancelBtn.removeEventListener('click', onCancel);
        };

        els.modalConfirmBtn.addEventListener('click', onConfirm);
        els.modalCancelBtn.addEventListener('click', onCancel);
    });
}
