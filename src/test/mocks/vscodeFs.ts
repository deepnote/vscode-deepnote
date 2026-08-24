import { anything, instance, mock, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { mockedVSCodeNamespaces } from '../vscode-mock';

/**
 * Stubs `workspace.fs.readFile` to yield `contents` as UTF-8 bytes, and points the mocked
 * `workspace.fs` namespace at it. Pass a function to serve different bytes per URI.
 *
 * Returns the ts-mockito mock so callers can `verify(mockFs.readFile(anything()))`.
 * Call after `resetVSCodeMocks()` — the reset replaces the namespace mocks this stubs.
 */
export function stubReadFile(contents: string | ((uri: Uri) => string)): typeof import('vscode').workspace.fs {
    const resolveContents = typeof contents === 'function' ? contents : () => contents;
    const mockFs = mock<typeof import('vscode').workspace.fs>();

    when(mockFs.readFile(anything())).thenCall((uri: Uri) =>
        Promise.resolve(new TextEncoder().encode(resolveContents(uri)))
    );
    when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

    return mockFs;
}
