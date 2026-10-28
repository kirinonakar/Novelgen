export interface NovelRefinementRevision {
    before_text: string;
    after_text: string;
    language: string;
    chapter_numbers: number[];
}

export interface LoadedNovelRevision extends NovelRefinementRevision { filename: string }

let revision: LoadedNovelRevision | null = null;
const listeners = new Set<() => void>();

export const novelRevisionStore = {
    getSnapshot: () => revision,
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
    load(filename: string | null, value?: NovelRefinementRevision | null) {
        const next = filename && value && typeof value.before_text === 'string' && typeof value.after_text === 'string'
            && Array.isArray(value.chapter_numbers) ? { ...value, filename } : null;
        if (revision?.filename === next?.filename && revision?.before_text === next?.before_text
            && revision?.after_text === next?.after_text && revision?.language === next?.language
            && JSON.stringify(revision?.chapter_numbers) === JSON.stringify(next?.chapter_numbers)) return;
        revision = next;
        listeners.forEach(listener => listener());
    },
};
