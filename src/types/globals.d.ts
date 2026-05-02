export {};

declare global {
    type TauriInvoke = <T = any>(command: string, args?: Record<string, unknown>) => Promise<T>;

    interface TauriChannel<T = any> {
        onmessage: ((message: T) => void) | null;
    }

    type TauriChannelConstructor = new <T = any>() => TauriChannel<T>;

    interface Window {
        __TAURI__?: {
            core?: {
                invoke: TauriInvoke;
                Channel: TauriChannelConstructor;
            };
        };
        marked?: {
            parse(input: string): string;
            use(...extensions: any[]): void;
            Renderer: new () => any;
        };
        markedKatex?: (options: Record<string, unknown>) => any;
        renderMathInElement?: (element: Element, options?: Record<string, unknown>) => void;
        katex?: any;
    }
}
