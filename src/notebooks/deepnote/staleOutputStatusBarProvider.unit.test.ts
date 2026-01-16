import { expect } from 'chai';
import { anything, verify, when } from 'ts-mockito';

import { CancellationToken, NotebookCell, NotebookCellKind, NotebookCellOutput, NotebookDocument, Uri } from 'vscode';

import { computeHash } from '../../platform/common/crypto';
import type { IDisposableRegistry } from '../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
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

    function createMockCell(options: {
        kind?: NotebookCellKind;
        outputs?: NotebookCellOutput[];
        metadata?: Record<string, unknown>;
        text?: string;
    }): NotebookCell {
        const notebookUri = Uri.file('/test/notebook.deepnote');

        return {
            index: 0,
            notebook: {
                uri: notebookUri,
                notebookType: 'deepnote'
            } as NotebookDocument,
            kind: options.kind ?? NotebookCellKind.Code,
            document: {
                uri: Uri.file('/test/notebook.deepnote#cell0'),
                fileName: '/test/notebook.deepnote#cell0',
                isUntitled: false,
                languageId: 'python',
                version: 1,
                isDirty: false,
                isClosed: false,
                getText: () => options.text ?? 'print("hello")',
                save: async () => true,
                eol: 1,
                lineCount: 1,
                lineAt: () => ({ text: '' }) as any,
                offsetAt: () => 0,
                positionAt: () => ({}) as any,
                validateRange: () => ({}) as any,
                validatePosition: () => ({}) as any
            } as any,
            metadata: options.metadata || {},
            outputs: options.outputs ?? [],
            executionSummary: undefined
        } as any;
    }

    function createMockOutput(): NotebookCellOutput {
        return {
            items: [{ mime: 'text/plain', data: new Uint8Array() }],
            metadata: undefined
        } as NotebookCellOutput;
    }

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
});
