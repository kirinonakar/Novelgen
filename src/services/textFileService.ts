import { isSupportedTextFile, readTextFile } from '../modules/text_utils.js';

export class UnsupportedTextFileError extends Error {
    constructor(fileName: string) {
        super(`Unsupported text file: ${fileName}`);
        this.name = 'UnsupportedTextFileError';
    }
}

export async function readSupportedTextFile(file: File): Promise<string> {
    if (!isSupportedTextFile(file)) {
        throw new UnsupportedTextFileError(file.name);
    }

    return await readTextFile(file);
}
