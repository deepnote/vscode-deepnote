import { Uri, workspace } from 'vscode';

// Upper bound on `-N` suffix attempts; mirrors the cap used by `@deepnote/convert`'s splitter.
export const MAX_SIBLING_ALLOCATION_ATTEMPTS = 10_000;

const DEEPNOTE_EXTENSION = '.deepnote';

/**
 * Default `exists` probe backed by `workspace.fs.stat`; a throwing stat is treated as "does not exist".
 */
export async function deepnoteFileExists(uri: Uri): Promise<boolean> {
    try {
        await workspace.fs.stat(uri);

        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve a collision-free sibling URI for a desired full basename (including `.deepnote`).
 * On a clash a numeric suffix is inserted before the extension, applied to the WHOLE basename
 * (not a first-dot stem), so `report.backup.deepnote` → `report.backup-2.deepnote`. When
 * `reserved` is supplied, the chosen name is added to it so a batch cannot pick the same name twice.
 */
export async function allocateSiblingUri(
    parentDir: Uri,
    desiredFilename: string,
    exists: (uri: Uri) => Promise<boolean>,
    reserved?: Set<string>
): Promise<Uri> {
    const { base, extension } = splitBasename(desiredFilename);

    for (let attempt = 1; attempt <= MAX_SIBLING_ALLOCATION_ATTEMPTS; attempt++) {
        const candidateName = attempt === 1 ? `${base}${extension}` : `${base}-${attempt}${extension}`;
        const candidateUri = Uri.joinPath(parentDir, candidateName);

        if (!reserved?.has(candidateName) && !(await exists(candidateUri))) {
            reserved?.add(candidateName);

            return candidateUri;
        }
    }

    throw new Error(
        `Unable to allocate a free sibling filename for "${desiredFilename}" after ${MAX_SIBLING_ALLOCATION_ATTEMPTS} attempts.`
    );
}

// Names without the extension get an empty extension so suffixing still appends to the whole basename.
function splitBasename(filename: string): { base: string; extension: string } {
    if (filename.endsWith(DEEPNOTE_EXTENSION)) {
        return {
            base: filename.slice(0, -DEEPNOTE_EXTENSION.length),
            extension: DEEPNOTE_EXTENSION
        };
    }

    return { base: filename, extension: '' };
}
