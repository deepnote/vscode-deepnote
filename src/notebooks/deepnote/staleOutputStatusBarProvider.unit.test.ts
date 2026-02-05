import { expect } from 'chai';
import { anything, mock, verify, when, instance } from 'ts-mockito';

import { CancellationToken, NotebookCellKind } from 'vscode';

import { computeHash } from '../../platform/common/crypto';
import type { IDisposableRegistry } from '../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { createMockCell, createMockOutput } from './deepnoteTestHelpers';
import { SnapshotService } from './snapshots/snapshotService';
import { StaleOutputStatusBarProvider } from './staleOutputStatusBarProvider';

suite('StaleOutputStatusBarProvider', () => {
    let provider: StaleOutputStatusBarProvider;
    let mockDisposables: IDisposableRegistry;
    let mockToken: CancellationToken;

    setup(() => {
        mockDisposables = [] as any;
        mockToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined })
        } as any;
        provider = new StaleOutputStatusBarProvider(mockDisposables);
    });

    suite('provideCellStatusBarItems', () => {
        test('should return undefined when cancellation token is requested', () => {
            const cancelledToken: CancellationToken = {
                isCancellationRequested: true,
                onCancellationRequested: () => ({ dispose: () => undefined })
            } as any;

            const cell = createMockCell({
                outputs: [createMockOutput()],
                metadata: { __deepnotePocket: { contentHash: 'sha256:abc123' } }
            });

            const result = provider.provideCellStatusBarItems(cell, cancelledToken);

            expect(result).to.be.undefined;
        });

        test('should return undefined for markdown cells', () => {
            const cell = createMockCell({
                kind: NotebookCellKind.Markup,
                outputs: [createMockOutput()],
                metadata: { __deepnotePocket: { contentHash: 'sha256:abc123' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.be.undefined;
        });

        test('should return undefined for cells without outputs', () => {
            const cell = createMockCell({
                outputs: [],
                metadata: { __deepnotePocket: { contentHash: 'sha256:abc123' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.be.undefined;
        });

        test('should return undefined when no contentHash in pocket (never executed)', () => {
            const cell = createMockCell({
                outputs: [createMockOutput()],
                metadata: { __deepnotePocket: {} }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.be.undefined;
        });

        test('should return undefined when no pocket exists', () => {
            const cell = createMockCell({
                outputs: [createMockOutput()],
                metadata: {}
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.be.undefined;
        });

        test('should return undefined when hashes match (not stale)', async () => {
            const cellContent = 'print("hello")';
            const hash = await computeHash(cellContent, 'SHA-256');
            const storedHash = `sha256:${hash}`;

            const cell = createMockCell({
                text: cellContent,
                outputs: [createMockOutput()],
                metadata: { __deepnotePocket: { contentHash: storedHash } }
            });

            const result = await provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.be.undefined;
        });

        test('should return warning indicator when hashes differ (stale)', async () => {
            const originalContent = 'print("original")';
            const originalHash = await computeHash(originalContent, 'SHA-256');
            const storedHash = `sha256:${originalHash}`;

            // Cell content has changed since execution
            const cell = createMockCell({
                text: 'print("modified")',
                outputs: [createMockOutput()],
                metadata: { __deepnotePocket: { contentHash: storedHash } }
            });

            const result = await provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect((result as any).text).to.include('Output may be stale');
            expect((result as any).alignment).to.equal(1); // Left alignment
            expect((result as any).priority).to.equal(85);
            expect((result as any).tooltip).to.include('Cell content has changed');
            expect((result as any).command.command).to.equal('notebook.cell.execute');
        });
    });

    suite('activate', () => {
        setup(() => {
            resetVSCodeMocks();
            when(
                mockedVSCodeNamespaces.notebooks.registerNotebookCellStatusBarItemProvider(anything(), anything())
            ).thenReturn({ dispose: () => undefined } as any);
            when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything())).thenReturn({
                dispose: () => undefined
            } as any);
        });

        teardown(() => {
            resetVSCodeMocks();
        });

        test('registers notebook cell status bar provider for deepnote notebooks', () => {
            provider.activate();

            verify(
                mockedVSCodeNamespaces.notebooks.registerNotebookCellStatusBarItemProvider('deepnote', provider)
            ).once();
        });

        test('registers workspace.onDidChangeNotebookDocument listener', () => {
            provider.activate();

            verify(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything())).once();
        });

        test('fires status bar update event when deepnote notebook changes', () => {
            let changeHandler: ((e: any) => void) | undefined;
            when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything())).thenCall((handler) => {
                changeHandler = handler;

                return { dispose: () => undefined };
            });

            let eventFired = false;
            provider.onDidChangeCellStatusBarItems(() => {
                eventFired = true;
            });

            provider.activate();
            expect(changeHandler).to.not.be.undefined;

            // Fire the event with a deepnote notebook
            changeHandler!({ notebook: { notebookType: 'deepnote' } });

            expect(eventFired).to.be.true;
        });

        test('does not fire status bar update event for non-deepnote notebooks', () => {
            let changeHandler: ((e: any) => void) | undefined;
            when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything())).thenCall((handler) => {
                changeHandler = handler;

                return { dispose: () => undefined };
            });

            let eventFired = false;
            provider.onDidChangeCellStatusBarItems(() => {
                eventFired = true;
            });

            provider.activate();
            expect(changeHandler).to.not.be.undefined;

            // Fire the event with a jupyter notebook (not deepnote)
            changeHandler!({ notebook: { notebookType: 'jupyter-notebook' } });

            expect(eventFired).to.be.false;
        });
    });

    suite('cleanupHashes', () => {
        test('cleans up hashes when deepnote notebook closes', () => {
            // Simulate a cell execution to populate the hash cache
            const cell = createMockCell({
                text: 'print("hello")',
                outputs: [createMockOutput()],
                metadata: {}
            });

            // Access internal map via any cast to verify cleanup
            const providerAny = provider as any;
            const cellKey = cell.document.uri.toString();
            providerAny.executedContentHashes.set(cellKey, 'sha256:test-hash');

            expect(providerAny.executedContentHashes.has(cellKey)).to.be.true;

            // Close the notebook - call the private cleanupHashes method directly
            const mockNotebook = {
                notebookType: 'deepnote',
                getCells: () => [cell]
            };
            providerAny.cleanupHashes(mockNotebook);

            expect(providerAny.executedContentHashes.has(cellKey)).to.be.false;
        });

        test('cleans up multiple cell hashes when notebook closes', () => {
            const cell1 = createMockCell({
                text: 'print("hello")',
                outputs: [createMockOutput()],
                metadata: {},
                index: 0
            });

            const cell2 = createMockCell({
                text: 'print("world")',
                outputs: [createMockOutput()],
                metadata: {},
                index: 1
            });

            const providerAny = provider as any;
            const cellKey1 = cell1.document.uri.toString();
            const cellKey2 = cell2.document.uri.toString();
            providerAny.executedContentHashes.set(cellKey1, 'sha256:hash1');
            providerAny.executedContentHashes.set(cellKey2, 'sha256:hash2');

            expect(providerAny.executedContentHashes.size).to.equal(2);

            const mockNotebook = {
                notebookType: 'deepnote',
                getCells: () => [cell1, cell2]
            };
            providerAny.cleanupHashes(mockNotebook);

            expect(providerAny.executedContentHashes.size).to.equal(0);
        });

        test('only cleans up hashes for cells in the closed notebook', () => {
            const cell1 = createMockCell({
                text: 'print("hello")',
                outputs: [createMockOutput()],
                metadata: {},
                index: 0
            });

            const cell2 = createMockCell({
                text: 'print("world")',
                outputs: [createMockOutput()],
                metadata: {},
                index: 1
            });

            const providerAny = provider as any;
            const cellKey1 = cell1.document.uri.toString();
            const cellKey2 = cell2.document.uri.toString();
            providerAny.executedContentHashes.set(cellKey1, 'sha256:hash1');
            providerAny.executedContentHashes.set(cellKey2, 'sha256:hash2');

            // Only close notebook with cell1
            const mockNotebook = {
                notebookType: 'deepnote',
                getCells: () => [cell1]
            };
            providerAny.cleanupHashes(mockNotebook);

            // cell1's hash should be removed, cell2's should remain
            expect(providerAny.executedContentHashes.has(cellKey1)).to.be.false;
            expect(providerAny.executedContentHashes.has(cellKey2)).to.be.true;
        });
    });

    suite('snapshot mode behavior', () => {
        let mockSnapshotService: SnapshotService;
        let providerWithSnapshot: StaleOutputStatusBarProvider;

        setup(() => {
            resetVSCodeMocks();
            mockSnapshotService = mock<SnapshotService>();
            providerWithSnapshot = new StaleOutputStatusBarProvider(mockDisposables, instance(mockSnapshotService));
        });

        teardown(() => {
            resetVSCodeMocks();
        });

        test('should use in-memory hash when available (snapshot mode)', async () => {
            when(mockSnapshotService.isSnapshotsEnabled()).thenReturn(true);

            const cellContent = 'print("hello")';
            const hash = await computeHash(cellContent, 'SHA-256');
            const storedHash = `sha256:${hash}`;

            const cell = createMockCell({
                text: cellContent,
                outputs: [createMockOutput()],
                metadata: {} // No pocket - no persisted hash
            });

            // Set in-memory hash
            const providerAny = providerWithSnapshot as any;
            const cellKey = cell.document.uri.toString();
            providerAny.executedContentHashes.set(cellKey, storedHash);

            const result = await providerWithSnapshot.provideCellStatusBarItems(cell, mockToken);

            // Should not show stale indicator since in-memory hash matches
            expect(result).to.be.undefined;
        });

        test('should show stale indicator when in-memory hash differs from current content', async () => {
            when(mockSnapshotService.isSnapshotsEnabled()).thenReturn(true);

            const originalContent = 'print("original")';
            const originalHash = await computeHash(originalContent, 'SHA-256');
            const storedHash = `sha256:${originalHash}`;

            const cell = createMockCell({
                text: 'print("modified")', // Content has changed
                outputs: [createMockOutput()],
                metadata: {}
            });

            // Set in-memory hash from original execution
            const providerAny = providerWithSnapshot as any;
            const cellKey = cell.document.uri.toString();
            providerAny.executedContentHashes.set(cellKey, storedHash);

            const result = await providerWithSnapshot.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect((result as any).text).to.include('Output may be stale');
        });

        test('should fall back to pocket hash when no in-memory hash exists', async () => {
            when(mockSnapshotService.isSnapshotsEnabled()).thenReturn(true);

            const cellContent = 'print("hello")';
            const hash = await computeHash(cellContent, 'SHA-256');
            const storedHash = `sha256:${hash}`;

            const cell = createMockCell({
                text: cellContent,
                outputs: [createMockOutput()],
                metadata: { __deepnotePocket: { contentHash: storedHash } }
            });

            const result = await providerWithSnapshot.provideCellStatusBarItems(cell, mockToken);

            // Should not show stale indicator since pocket hash matches
            expect(result).to.be.undefined;
        });
    });
});
