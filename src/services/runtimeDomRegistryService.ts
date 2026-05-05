type RuntimeDomElementMap = {
    novelContent: HTMLTextAreaElement;
    novelContentPreview: HTMLElement;
};

const runtimeDomElements: Partial<RuntimeDomElementMap> = {};

export function registerRuntimeElement<K extends keyof RuntimeDomElementMap>(
    key: K,
    element: RuntimeDomElementMap[K] | null,
) {
    if (element) {
        runtimeDomElements[key] = element;
        return;
    }

    delete runtimeDomElements[key];
}

export function getRuntimeElement<K extends keyof RuntimeDomElementMap>(
    key: K,
): RuntimeDomElementMap[K] | null {
    return (runtimeDomElements[key] || null) as RuntimeDomElementMap[K] | null;
}
