// These stubs serve Node unit tests, which key files by fsPath.
/* eslint-disable local-rules/dont-use-fspath */

import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { anything, instance, mock, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { mockedVSCodeNamespaces } from '../vscode-mock';

/**
 * Stubs `workspace.fs.readFile` to yield `contents` as UTF-8 bytes, and points the mocked
 * `workspace.fs` namespace at it. Pass a function to serve different bytes per URI; a URI it
 * returns `undefined` for rejects, as a missing file would.
 *
 * Returns the ts-mockito mock so callers can `verify(mockFs.readFile(anything()))`.
 * Call after `resetVSCodeMocks()` — the reset replaces the namespace mocks this stubs.
 */
export function stubReadFile(
    contents: string | ((uri: Uri) => string | undefined)
): typeof import('vscode').workspace.fs {
    const resolveContents = typeof contents === 'function' ? contents : () => contents;
    const mockFs = mock<typeof import('vscode').workspace.fs>();

    when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
        const resolved = resolveContents(uri);

        return resolved === undefined
            ? Promise.reject(new Error(`no readFile stub for ${uri.fsPath}`))
            : Promise.resolve(new TextEncoder().encode(resolved));
    });
    when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

    return mockFs;
}

/**
 * Serves `.deepnote` files through the mocked `workspace.fs`: a read yields `files(uri)` serialized, rejecting where
 * it returns `undefined`, and each write lands in the returned map, parsed, by `fsPath`. Both `files` and
 * `failWriteFor` are consulted on every call, so a test can change them after stubbing.
 *
 * Call after `resetVSCodeMocks()` — the reset replaces the namespace mocks this stubs.
 */
export function stubDeepnoteFiles(
    files: (uri: Uri) => DeepnoteFile | undefined,
    options: { failWriteFor?: ReadonlySet<string>; onRead?: (uri: Uri) => void; onWrite?: (uri: Uri) => void } = {}
): Map<string, DeepnoteFile> {
    const writes = new Map<string, DeepnoteFile>();
    const mockFs = stubReadFile((uri) => {
        options.onRead?.(uri);

        const file = files(uri);

        return file ? serializeDeepnoteFile(file) : undefined;
    });

    when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri, bytes: Uint8Array) => {
        if (options.failWriteFor?.has(uri.fsPath)) {
            return Promise.reject(new Error(`write failed for ${uri.fsPath}`));
        }

        options.onWrite?.(uri);
        writes.set(uri.fsPath, deserializeDeepnoteFile(new TextDecoder().decode(bytes)));

        return Promise.resolve();
    });

    return writes;
}
