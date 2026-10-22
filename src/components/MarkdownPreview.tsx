import { useMemo, memo, type UIEventHandler } from 'react';
import { renderMarkdownToHtml } from '../modules/preview.js';
import {
    registerRuntimeElement,
} from '../services/runtimeDomRegistryService.js';

interface MarkdownPreviewProps {
    active: boolean;
    className: string;
    comfortMode?: boolean;
    content: string;
    id: string;
    onScroll?: UIEventHandler<HTMLDivElement>;
    runtimeElementKey?: 'novelContentPreview';
}

export const MarkdownPreview = memo(function MarkdownPreview({
    active,
    className,
    comfortMode = false,
    content,
    id,
    onScroll,
    runtimeElementKey,
}: MarkdownPreviewProps) {
    const html = useMemo(() => active ? renderMarkdownToHtml(content) : '', [active, content]);
    const resolvedClassName = comfortMode ? `${className} comfort-mode` : className;

    return (
        <div
            id={id}
            className={resolvedClassName}
            onScroll={onScroll}
            ref={element => {
                if (runtimeElementKey) {
                    registerRuntimeElement(runtimeElementKey, element);
                }
            }}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}, (previous, next) => {
    // Bail out while hidden to retain the DOM and scroll position without parsing.
    if (!next.active) return true;
    return previous.active
        && previous.content === next.content
        && previous.className === next.className
        && previous.comfortMode === next.comfortMode
        && previous.id === next.id
        && previous.onScroll === next.onScroll
        && previous.runtimeElementKey === next.runtimeElementKey;
});
