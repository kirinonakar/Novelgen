import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PromptEditorViewState } from '../types/app.js';
import type { ActionProps } from './componentTypes.js';

export type PresetOperation = 'save' | 'delete' | 'reset';

const titles = {
    save: 'Save system prompt',
    delete: 'Delete system preset',
    reset: 'Reset system presets',
};

export function SystemPromptPresetDialog({
    actions,
    operation,
    promptEditor,
    onClose,
}: ActionProps & {
    operation: PresetOperation;
    promptEditor: PromptEditorViewState;
    onClose: () => void;
}) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const [destination, setDestination] = useState('');
    const [newName, setNewName] = useState('');
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState('');
    const isSaving = operation === 'save';
    const presetName = destination || newName.trim();
    const saveLabel = promptEditor.presetOptions.includes(presetName) ? 'Overwrite' : 'Save';

    useLayoutEffect(() => {
        dialogRef.current?.showModal();
    }, []);

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (isPending || (isSaving && !presetName)) return;

        setIsPending(true);
        setError('');
        try {
            if (isSaving) await actions.onSavePrompt(presetName);
            else if (operation === 'delete') await actions.onDeletePrompt(promptEditor.selectedPreset);
            else await actions.onResetPrompts();
            dialogRef.current?.close();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
            setIsPending(false);
        }
    }

    return createPortal(
        <dialog
            ref={dialogRef}
            className="prompt-preset-dialog"
            aria-labelledby="prompt-preset-dialog-title"
            onClose={onClose}
            onCancel={event => { if (isPending) event.preventDefault(); }}
        >
            <h2 id="prompt-preset-dialog-title">{titles[operation]}</h2>
            <form onSubmit={submit} aria-busy={isPending}>
                {isSaving ? (
                    <>
                        <div className="input-group">
                            <label htmlFor="prompt-save-destination">Save to</label>
                            <select
                                id="prompt-save-destination"
                                className="inputbox"
                                value={destination}
                                disabled={isPending}
                                onChange={event => setDestination(event.currentTarget.value)}
                            >
                                <option value="">New preset</option>
                                {promptEditor.presetOptions.map(name => <option key={name} value={name}>{name}</option>)}
                            </select>
                        </div>
                        {!destination ? (
                            <div className="input-group">
                                <label htmlFor="prompt-preset-name">Preset name</label>
                                <input
                                    id="prompt-preset-name"
                                    className="inputbox"
                                    value={newName}
                                    required
                                    disabled={isPending}
                                    onChange={event => setNewName(event.currentTarget.value)}
                                />
                            </div>
                        ) : null}
                    </>
                ) : operation === 'delete' ? (
                    <p>Delete “{promptEditor.selectedPreset}” from System Preset?</p>
                ) : (
                    <p>Restore the built-in presets and delete all custom presets? The file default will reload from <code>system_prompt.txt</code>.</p>
                )}
                {error ? <p className="prompt-preset-error" role="alert">{error}</p> : null}
                <div className="auto-flex prompt-preset-dialog-actions">
                    <button className="btn btn-secondary" type="button" disabled={isPending} onClick={() => dialogRef.current?.close()}>
                        Cancel
                    </button>
                    <button
                        className={`btn ${isSaving ? 'btn-primary' : 'btn-danger'}`}
                        type="submit"
                        disabled={isPending || (isSaving && !presetName)}
                    >
                        {isSaving ? saveLabel : operation === 'delete' ? 'Delete' : 'Reset'}
                    </button>
                </div>
            </form>
        </dialog>,
        document.body,
    );
}
