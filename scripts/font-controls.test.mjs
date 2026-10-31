import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { transformWithOxc } from 'vite';

async function harness() {
    let slotWidth = 340;
    let writes = 0;
    let nextFrame = 0;
    let observer;
    let contentObserver;
    const frames = new Map();
    const effects = [];
    function style() {
        const values = {};
        const set = (key, value) => {
            if (values[key] !== value) writes++;
            values[key] = value;
        };
        return {
            setProperty: set,
            getPropertyValue: key => values[key],
            set flexShrink(value) { set('flexShrink', value); },
            get flexShrink() { return values.flexShrink; },
            set width(value) { set('width', value); },
            get width() { return values.width; },
        };
    }
    const header = {};
    const slot = {
        parentElement: header,
        style: style(),
        get clientWidth() { return slotWidth; },
        getBoundingClientRect() {
            const basis = parseFloat(this.style.getPropertyValue('--fs-control-width')) || slotWidth;
            return { width: this.style.flexShrink === '0' ? basis : Math.min(slotWidth, basis) };
        },
    };
    const controls = {
        style: style(),
        children: [70, 40, 60, 120].map(width => ({ getBoundingClientRect: () => ({ width }) })),
    };
    const refs = [slot, controls];
    const context = createContext({
        getComputedStyle: () => ({ columnGap: '8px', paddingLeft: '12px', paddingRight: '12px',
            borderLeftWidth: '1px', borderRightWidth: '1px' }),
        requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame: id => frames.delete(id),
        ResizeObserver: class {
            constructor(callback) { this.callback = callback; this.disconnected = false; this.targets = []; observer = this; }
            observe(target) { this.targets.push(target); }
            disconnect() { this.disconnected = true; }
        },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; this.disconnected = false; contentObserver = this; }
            observe() {}
            disconnect() { this.disconnected = true; }
        },
    });
    const source = (await transformWithOxc(
        await readFile(new URL('../src/components/FontControls.tsx', import.meta.url), 'utf8'),
        'FontControls.tsx', { target: 'es2022' },
    )).code;
    const module = new SourceTextModule(source, { context });
    const jsx = (type, props) => ({ type, props });
    const imports = {
        react: { useRef: () => ({ current: refs.shift() }), useLayoutEffect: effect => effects.push(effect) },
        'react/jsx-runtime': { jsx, jsxs: jsx },
    };
    await module.link(specifier => {
        const values = imports[specifier];
        return new SyntheticModule(Object.keys(values), function () {
            for (const [name, value] of Object.entries(values)) this.setExport(name, value);
        }, { context });
    });
    await module.evaluate();
    module.namespace.FontControls({ actions: {}, scope: 'novel',
        settings: { comfort: false, fontSize: 16, wrapWidth: 42 } });
    const cleanup = effects[0]();
    return {
        slot, header, controls, frames, observer, contentObserver, cleanup,
        get writes() { return writes; },
        resize(width) { slotWidth = width; observer.callback(); },
        updateStatus(width) { slotWidth = width; contentObserver.callback(); },
        paint() {
            const pending = [...frames.values()];
            frames.clear();
            pending.forEach(callback => callback());
        },
    };
}

test('resize delivery does not change layout; the next frame fits and later expands the capsule', async () => {
    const api = await harness();
    assert.equal(api.controls.style.width, '340px');
    const initialWrites = api.writes;
    api.resize(240);
    assert.equal(api.writes, initialWrites, 'layout writes must happen outside ResizeObserver delivery');
    api.paint();
    assert.equal(api.controls.style.width, '212px');
    api.resize(340);
    api.paint();
    assert.equal(api.controls.style.width, '340px');
});

test('rapid resize notifications use one frame and the latest available width', async () => {
    const api = await harness();
    api.resize(240);
    api.resize(200);
    assert.equal(api.frames.size, 1);
    api.paint();
    assert.equal(api.controls.style.width, '146px');
    api.resize(200);
    api.paint();
    assert.equal(api.controls.style.width, '146px');
    assert.equal(api.frames.size, 0);
});

test('wrapped controls return unused header width to the status and expand on later header changes', async () => {
    const api = await harness();
    assert.ok(api.observer.targets.includes(api.header), 'observe the header even when the fitted slot stays fixed');
    api.resize(240);
    api.paint();
    assert.equal(api.slot.getBoundingClientRect().width, 212, 'release the 28px left over after wrapping');
    assert.equal(api.slot.style.flexShrink, '0', 'keep the fitted capsule from overflowing its slot');
    api.updateStatus(340);
    assert.equal(api.frames.size, 1);
    api.paint();
    assert.equal(api.slot.getBoundingClientRect().width, 340);
    assert.equal(api.controls.style.width, '340px');
});

test('unmount cancels pending layout work and disconnects observation', async () => {
    const api = await harness();
    api.resize(240);
    assert.equal(api.frames.size, 1);
    api.cleanup();
    assert.equal(api.frames.size, 0);
    assert.equal(api.observer.disconnected, true);
    assert.equal(api.contentObserver.disconnected, true);
    api.paint();
    assert.equal(api.controls.style.width, '340px');
});
