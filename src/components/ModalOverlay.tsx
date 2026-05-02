import type { ConfirmDialogViewState } from '../types/app.js';

interface ModalOverlayProps {
    dialog: ConfirmDialogViewState;
    onCancel: () => void;
    onConfirm: () => void;
}

export function ModalOverlay({
    dialog,
    onCancel,
    onConfirm,
}: ModalOverlayProps) {
    if (!dialog.isOpen) return null;

    return (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
            <div className="modal-box">
                <h3 id="confirm-dialog-title">{dialog.title}</h3>
                <p>{dialog.message}</p>
                <div className="modal-actions">
                    <button className="btn btn-secondary" type="button" onClick={onCancel}>Cancel</button>
                    <button className="btn btn-danger" type="button" onClick={onConfirm}>Confirm</button>
                </div>
            </div>
        </div>
    );
}
