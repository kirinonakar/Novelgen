import { type DragEventHandler, useCallback, useRef, useState } from 'react';
import {
    eventHasDroppedFiles,
    readDroppedTextFromEvent,
} from '../services/fileDropService.js';
import type { TextDropTarget } from '../types/app.js';

type DropTargetElement = HTMLElement;

export function useTextFileDropTarget(
    target: TextDropTarget,
    label: string,
    onTextLoaded: (target: TextDropTarget, text: string) => void | Promise<void>,
) {
    const dragDepth = useRef(0);
    const [isDropActive, setIsDropActive] = useState(false);

    const onDragEnter = useCallback<DragEventHandler<DropTargetElement>>((event) => {
        if (!eventHasDroppedFiles(event.nativeEvent)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setIsDropActive(true);
    }, []);

    const onDragOver = useCallback<DragEventHandler<DropTargetElement>>((event) => {
        if (!eventHasDroppedFiles(event.nativeEvent)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setIsDropActive(true);
    }, []);

    const onDragLeave = useCallback<DragEventHandler<DropTargetElement>>((event) => {
        if (!eventHasDroppedFiles(event.nativeEvent)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
            setIsDropActive(false);
        }
    }, []);

    const onDrop = useCallback<DragEventHandler<DropTargetElement>>(async (event) => {
        if (!eventHasDroppedFiles(event.nativeEvent)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setIsDropActive(false);

        const text = await readDroppedTextFromEvent(event.nativeEvent, label);
        if (text === null) return;

        await onTextLoaded(target, text);
    }, [label, onTextLoaded, target]);

    return {
        isDropActive,
        dropTargetProps: {
            onDragEnter,
            onDragOver,
            onDragLeave,
            onDrop,
        },
    };
}
