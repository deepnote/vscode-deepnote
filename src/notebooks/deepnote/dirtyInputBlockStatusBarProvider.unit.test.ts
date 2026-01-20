import { expect } from 'chai';
import { anything, verify, when } from 'ts-mockito';

import { CancellationToken, NotebookCellKind } from 'vscode';

import type { IDisposableRegistry } from '../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { createMockCell } from './deepnoteTestHelpers';
import { DirtyInputBlockStatusBarProvider } from './dirtyInputBlockStatusBarProvider';

suite('DirtyInputBlockStatusBarProvider', () => {
    let provider: DirtyInputBlockStatusBarProvider;
    let mockDisposables: IDisposableRegistry;
    let mockToken: CancellationToken;

    setup(() => {
        mockDisposables = [] as unknown as IDisposableRegistry;
        mockToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined })
        } as CancellationToken;
        provider = new DirtyInputBlockStatusBarProvider(mockDisposables);
    });

    suite('provideCellStatusBarItems', () => {
        test('should return undefined when cancellation token is requested', () => {
            const cancelledToken: CancellationToken = {
                isCancellationRequested: true,
                onCancellationRequested: () => ({ dispose: () => undefined })
            } as CancellationToken;

            const cell = createMockCell({
                text: 'test value',
                metadata: { __deepnotePocket: { type: 'input-text' } }
            });

            const result = provider.provideCellStatusBarItems(cell, cancelledToken);

            expect(result).to.be.undefined;
        });

        test('should return undefined for markdown cells', () => {
            const cell = createMockCell({
                kind: NotebookCellKind.Markup,
                text: 'test value',
                metadata: { __deepnotePocket: { type: 'input-text' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.be.undefined;
        });

        test('should return undefined for code cells (not input blocks)', () => {
            const cell = createMockCell({
                text: 'print("hello")',
                metadata: { __deepnotePocket: { type: 'code' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.be.undefined;
        });

        test('should return undefined for cells without pocket', () => {
            const cell = createMockCell({
                text: 'test value',
                metadata: {}
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.be.undefined;
        });

        test('should return undefined for cells without type in pocket', () => {
            const cell = createMockCell({
                text: 'test value',
                metadata: { __deepnotePocket: {} }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.be.undefined;
        });

        test('should recognize input-text blocks', () => {
            const cell = createMockCell({
                text: 'test value',
                metadata: { __deepnotePocket: { type: 'input-text' } }
            });

            // Should return a promise (not undefined) because it's an input block
            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect(result).to.be.instanceOf(Promise);
        });

        test('should recognize input-textarea blocks', () => {
            const cell = createMockCell({
                text: 'textarea content',
                metadata: { __deepnotePocket: { type: 'input-textarea' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect(result).to.be.instanceOf(Promise);
        });

        test('should recognize input-slider blocks', () => {
            const cell = createMockCell({
                text: '50',
                metadata: { __deepnotePocket: { type: 'input-slider' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect(result).to.be.instanceOf(Promise);
        });

        test('should recognize input-select blocks', () => {
            const cell = createMockCell({
                text: '["option1"]',
                metadata: { __deepnotePocket: { type: 'input-select' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect(result).to.be.instanceOf(Promise);
        });

        test('should recognize input-checkbox blocks', () => {
            const cell = createMockCell({
                text: 'True',
                metadata: { __deepnotePocket: { type: 'input-checkbox' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect(result).to.be.instanceOf(Promise);
        });

        test('should recognize input-date blocks', () => {
            const cell = createMockCell({
                text: '"2024-01-01"',
                metadata: { __deepnotePocket: { type: 'input-date' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect(result).to.be.instanceOf(Promise);
        });

        test('should recognize input-date-range blocks', () => {
            const cell = createMockCell({
                text: '("2024-01-01", "2024-12-31")',
                metadata: { __deepnotePocket: { type: 'input-date-range' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect(result).to.be.instanceOf(Promise);
        });

        test('should recognize input-file blocks', () => {
            const cell = createMockCell({
                text: '"/path/to/file.txt"',
                metadata: { __deepnotePocket: { type: 'input-file' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect(result).to.be.instanceOf(Promise);
        });

        test('should recognize button blocks', () => {
            const cell = createMockCell({
                text: '# Buttons only work in Deepnote apps',
                metadata: { __deepnotePocket: { type: 'button' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect(result).to.be.instanceOf(Promise);
        });

        test('should be case insensitive for block type', () => {
            const cell = createMockCell({
                text: 'test value',
                metadata: { __deepnotePocket: { type: 'INPUT-TEXT' } }
            });

            const result = provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.not.be.undefined;
            expect(result).to.be.instanceOf(Promise);
        });

        test('should capture hash and return undefined on first call for new cell', async () => {
            const cell = createMockCell({
                text: 'test value',
                metadata: { __deepnotePocket: { type: 'input-text' } }
            });

            // First call should capture the hash and return undefined
            const result = await provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.be.undefined;
        });

        test('should return undefined when content matches on subsequent calls', async () => {
            const cell = createMockCell({
                text: 'test value',
                metadata: { __deepnotePocket: { type: 'input-text' } }
            });

            // First call captures the hash
            await provider.provideCellStatusBarItems(cell, mockToken);

            // Second call with same content should return undefined
            const result = await provider.provideCellStatusBarItems(cell, mockToken);

            expect(result).to.be.undefined;
        });

        test('should return dirty indicator when content changes', async () => {
            const originalCell = createMockCell({
                text: 'original value',
                metadata: { __deepnotePocket: { type: 'input-text' } }
            });

            // First call captures the hash for the original content
            await provider.provideCellStatusBarItems(originalCell, mockToken);

            // Create a new cell with different content but same URI
            const modifiedCell = createMockCell({
                text: 'modified value',
                metadata: { __deepnotePocket: { type: 'input-text' } }
            });

            // Second call with different content should return dirty indicator
            const result = await provider.provideCellStatusBarItems(modifiedCell, mockToken);

            expect(result).to.not.be.undefined;
            expect((result as any).text).to.include('Stale input');
            expect((result as any).alignment).to.equal(1); // Left alignment
            expect((result as any).priority).to.equal(85);
            expect((result as any).tooltip).to.include('Re-run the cell to apply');
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
