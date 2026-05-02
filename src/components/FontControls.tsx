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
    const labels = {
        seed: { comfort: 'seed-comfort-toggle', fs: 'seed-fs', wrap: 'seed-wrap' },
        plot: { comfort: 'plot-comfort-toggle', fs: 'plot-fs', wrap: 'plot-wrap' },
        novel: { comfort: 'novel-comfort-toggle', fs: 'novel-fs', wrap: 'novel-wrap' },
    }[scope];

    return (
        <div className="fs-control">
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
            <label>WRAP <span id={`${labels.wrap}-val`}>{settings.wrapWidth}</span></label>
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
    );
}
