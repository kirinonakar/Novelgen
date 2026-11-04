import { useRef } from 'react';
import { createPortal } from 'react-dom';

const appIcon = new URL('../../src-tauri/icons/128x128.png', import.meta.url).href;

export function AboutTitle() {
    const dialogRef = useRef<HTMLDialogElement>(null);

    return (
        <>
            <h1 className="app-title">
                <button className="app-title-button" type="button" title="About NovelGen AI"
                    aria-haspopup="dialog" onClick={() => dialogRef.current?.showModal()}>
                    🖋️ NovelGen AI
                </button>
            </h1>
            {createPortal(
                <dialog ref={dialogRef} className="about-dialog" aria-labelledby="about-title">
                    <img className="about-icon" src={appIcon} width="96" height="96" alt="NovelGen AI icon" />
                    <h2 id="about-title">NovelGen AI</h2>
                    <a className="about-link" href="https://github.com/kirinonakar/Novelgen"
                        target="_blank" rel="noopener noreferrer">
                        https://github.com/kirinonakar/Novelgen
                    </a>
                    <form method="dialog">
                        <button className="btn btn-secondary" type="submit" autoFocus>Close</button>
                    </form>
                </dialog>,
                document.body,
            )}
        </>
    );
}
