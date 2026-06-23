import { Uri, workspace } from 'vscode';

/**
 * Upper bound on the number of `-N` suffix attempts when resolving a collision-free
 * sibling filename. Mirrors the internal cap used by `@deepnote/convert`'s splitter.
 */
export const MAX_SIBLING_ALLOCATION_ATTEMPTS = 10_000;

const DEEPNOTE_EXTENSION = '.deepnote';

/**
 * Default `exists` probe backed by `workspace.fs.stat`. A throwing stat (file not found,
 * permission error, etc.) is treated as "does not exist".
 * @param uri The URI to probe
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
 * Resolve a collision-free sibling URI for a desired basename in `parentDir`.
 *
 * `desiredFilename` is a full basename including the `.deepnote` extension (e.g. convert's
 * `entry.outputFilename`, or `${stem}-${slug}.deepnote`). On a clash, a numeric suffix is
 * inserted immediately before the extension: `name.deepnote` → `name-2.deepnote` →
 * `name-3.deepnote`, … The suffix is applied to the WHOLE basename before `.deepnote`
 * (not a first-dot stem), so `report.backup.deepnote` → `report.backup-2.deepnote`.
 *
 * This helper only allocates NEW URIs; it never returns an existing path. When `reserved`
 * is supplied, the chosen name is added to it before returning, so a batch that allocates
 * several names before writing any of them cannot pick the same name twice.
 *
 * @param parentDir The directory in which to allocate the sibling
 * @param desiredFilename The desired full basename (including `.deepnote` extension)
 * @param exists Injected existence probe (default backs onto `workspace.fs.stat`)
 * @param reserved Optional set of names already chosen in this batch but not yet written
 * @returns A collision-free URI under `parentDir`
 * @throws If a free name cannot be found within `MAX_SIBLING_ALLOCATION_ATTEMPTS`
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

/**
 * Split a basename into the portion before the trailing `.deepnote` extension and the
 * extension itself. Names without the extension are returned unchanged with an empty
 * extension so suffixing still appends to the whole basename.
 */
function splitBasename(filename: string): { base: string; extension: string } {
    if (filename.endsWith(DEEPNOTE_EXTENSION)) {
        return {
            base: filename.slice(0, -DEEPNOTE_EXTENSION.length),
            extension: DEEPNOTE_EXTENSION
        };
    }

    return { base: filename, extension: '' };
}
