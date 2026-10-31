import { useLayoutEffect, useRef } from 'react';
import type { TypographyScope, TypographyScopeViewState } from '../types/app.js';
import type { ActionProps } from './componentTypes.js';

interface FontControlsProps extends ActionProps {
    scope: TypographyScope;
    settings: TypographyScopeViewState;
}

export function FontControls({
    actions,
    scope,
    settings,
}: FontControlsProps) {
    const slotRef = useRef<HTMLDivElement>(null);
    const controlsRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const slot = slotRef.current;
        const controls = controlsRef.current;
        const header = slot?.parentElement;
        if (!slot || !controls || !header) return;

        const items = Array.from(controls.children);
        const fitCapsule = () => {
            if (slot.clientWidth === 0) return;

            const style = getComputedStyle(controls);
            const gap = parseFloat(style.columnGap);
            const insets = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
                + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
            const widths = items.map(item => item.getBoundingClientRect().width);
            const naturalWidth = widths.reduce((sum, width) => sum + width, 0)
                + gap * (widths.length - 1) + insets;

            // Measure the natural flex allocation before returning unused width to the header.
            slot.style.setProperty('--fs-control-width', `${Math.ceil(naturalWidth)}px`);
            slot.style.setProperty('--fs-control-min-width', `${Math.ceil(Math.max(...widths) + insets)}px`);
            slot.style.flexShrink = '1';

            const availableWidth = slot.getBoundingClientRect().width - insets;
            let rowWidth = 0;
            let widestRow = 0;
            for (const width of widths) {
                const nextWidth = rowWidth === 0 ? width : rowWidth + gap + width;
                rowWidth = nextWidth > availableWidth ? width : nextWidth;
                widestRow = Math.max(widestRow, rowWidth);
            }
            const fittedWidth = `${Math.ceil(widestRow + insets)}px`;
            controls.style.width = fittedWidth;
            slot.style.setProperty('--fs-control-width', fittedWidth);
            slot.style.flexShrink = '0';
        };

        let pendingFrame: number | null = null;
        // Resize notifications must not resize observed elements during delivery.
        const scheduleFit = () => {
            if (pendingFrame !== null) return;
            pendingFrame = requestAnimationFrame(() => {
                pendingFrame = null;
                fitCapsule();
            });
        };
        const observer = new ResizeObserver(scheduleFit);
        observer.observe(header);
        observer.observe(slot);
        items.forEach(item => observer.observe(item));
        // Status text can change its preferred width without resizing the header.
        const contentObserver = new MutationObserver(scheduleFit);
        contentObserver.observe(header, { childList: true, characterData: true, subtree: true });
        fitCapsule();
        return () => {
            observer.disconnect();
            contentObserver.disconnect();
            if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
        };
    }, []);

    const labels = {
        seed: { comfort: 'seed-comfort-toggle', fs: 'seed-fs', wrap: 'seed-wrap' },
        plot: { comfort: 'plot-comfort-toggle', fs: 'plot-fs', wrap: 'plot-wrap' },
        novel: { comfort: 'novel-comfort-toggle', fs: 'novel-fs', wrap: 'novel-wrap' },
    }[scope];

    return (
        <div className="fs-control-slot" ref={slotRef}>
            <div className="fs-control" ref={controlsRef}>
                <label className="comfort-toggle" htmlFor={labels.comfort}>
                    <input
                        type="checkbox"
                        id={labels.comfort}
                        checked={settings.comfort}
                        onChange={event => actions.onComfortModeChange(scope, event.currentTarget.checked)}
                    />
                    <span>Comfort</span>
                </label>
                <label>SIZE <span id={`${labels.fs}-val`}>{settings.fontSize}</span></label>
                <input
                    type="range"
                    id={`${labels.fs}-slider`}
                    min="12"
                    max="32"
                    step="1"
                    value={settings.fontSize}
                    className="header-slider"
                    onChange={event => actions.onFontSizeChange(scope, event.currentTarget.value)}
                />
                <div className="fs-control-group">
                    <label htmlFor={`${labels.wrap}-slider`}>WRAP <span id={`${labels.wrap}-val`}>{settings.wrapWidth}</span></label>
                    <input
                        type="range"
                        id={`${labels.wrap}-slider`}
                        min="24"
                        max="96"
                        step="2"
                        value={settings.wrapWidth}
                        className="header-slider wrap-slider"
                        onChange={event => actions.onWrapWidthChange(scope, event.currentTarget.value)}
                    />
                </div>
            </div>
        </div>
    );
}
