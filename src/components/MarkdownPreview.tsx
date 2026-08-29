import { useMemo, type UIEventHandler } from 'react';
import { renderMarkdownToHtml } from '../modules/preview.js';
import {
    registerRuntimeElement,
} from '../services/runtimeDomRegistryService.js';

interface MarkdownPreviewProps {
    className: string;
    comfortMode?: boolean;
    content: string;
    id: string;
    onScroll?: UIEventHandler<HTMLDivElement>;
    runtimeElementKey?: 'novelContentPreview';
}

export function MarkdownPreview({
    className,
    comfortMode = false,
    content,
    id,
    onScroll,
    runtimeElementKey,
}: MarkdownPreviewProps) {
    const html = useMemo(() => renderMarkdownToHtml(content), [content]);
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
}
