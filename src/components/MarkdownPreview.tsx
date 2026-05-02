import { useMemo } from 'react';
import { renderMarkdownToHtml } from '../modules/preview.js';

interface MarkdownPreviewProps {
    className: string;
    content: string;
    id: string;
}

export function MarkdownPreview({
    className,
    content,
    id,
}: MarkdownPreviewProps) {
    const html = useMemo(() => renderMarkdownToHtml(content), [content]);

    return (
        <div
            id={id}
            className={className}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}
