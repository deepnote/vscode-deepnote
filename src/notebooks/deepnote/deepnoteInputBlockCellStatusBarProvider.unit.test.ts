// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect } from 'chai';
import { DeepnoteInputBlockCellStatusBarItemProvider } from './deepnoteInputBlockCellStatusBarProvider';
import { NotebookCell, NotebookCellKind, NotebookDocument } from 'vscode';
import { Uri } from 'vscode';

suite('DeepnoteInputBlockCellStatusBarItemProvider', () => {
    let provider: DeepnoteInputBlockCellStatusBarItemProvider;

    setup(() => {
        provider = new DeepnoteInputBlockCellStatusBarItemProvider();
    });

    teardown(() => {
        provider.dispose();
    });

    function createMockCell(metadata?: Record<string, unknown>): NotebookCell {
        return {
            index: 0,
            notebook: {} as NotebookDocument,
            kind: NotebookCellKind.Code,
            document: {
                uri: Uri.file('/test/notebook.deepnote'),
                fileName: '/test/notebook.deepnote',
                isUntitled: false,
                languageId: 'json',
                version: 1,
                isDirty: false,
                isClosed: false,
                getText: () => '',
                save: async () => true,
                eol: 1,
                lineCount: 1,
                lineAt: () => ({}) as any,
                offsetAt: () => 0,
                positionAt: () => ({}) as any,
                validateRange: () => ({}) as any,
                validatePosition: () => ({}) as any
            } as any,
            metadata: metadata || {},
            outputs: [],
            executionSummary: undefined
        } as any;
    }

    suite('Input Block Type Detection', () => {
        test('Should return status bar item for input-text block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-text' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.not.be.undefined;
            expect(item?.text).to.equal('Input Text');
        });

        test('Should return status bar item for input-textarea block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-textarea' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.not.be.undefined;
            expect(item?.text).to.equal('Input Textarea');
        });

        test('Should return status bar item for input-select block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-select' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.not.be.undefined;
            expect(item?.text).to.equal('Input Select');
        });

        test('Should return status bar item for input-slider block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-slider' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.not.be.undefined;
            expect(item?.text).to.equal('Input Slider');
        });

        test('Should return status bar item for input-checkbox block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-checkbox' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.not.be.undefined;
            expect(item?.text).to.equal('Input Checkbox');
        });

        test('Should return status bar item for input-date block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-date' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.not.be.undefined;
            expect(item?.text).to.equal('Input Date');
        });

        test('Should return status bar item for input-date-range block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-date-range' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.not.be.undefined;
            expect(item?.text).to.equal('Input Date Range');
        });

        test('Should return status bar item for input-file block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-file' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.not.be.undefined;
            expect(item?.text).to.equal('Input File');
        });

        test('Should return status bar item for button block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'button' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.not.be.undefined;
            expect(item?.text).to.equal('Button');
        });
    });

    suite('Non-Input Block Types', () => {
        test('Should return undefined for code block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'code' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.be.undefined;
        });

        test('Should return undefined for sql block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'sql' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.be.undefined;
        });

        test('Should return undefined for markdown block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'text-cell-p' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.be.undefined;
        });

        test('Should return undefined for cell with no type metadata', () => {
            const cell = createMockCell({});
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.be.undefined;
        });

        test('Should return undefined for cell with undefined metadata', () => {
            const cell = createMockCell(undefined);
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.be.undefined;
        });
    });

    suite('Status Bar Item Properties', () => {
        test('Should have correct tooltip for input-text', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-text' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item?.tooltip).to.equal('Deepnote Input Text');
        });

        test('Should have correct tooltip for button', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'button' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item?.tooltip).to.equal('Deepnote Button');
        });

        test('Should format multi-word block types correctly', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-date-range' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item?.text).to.equal('Input Date Range');
            expect(item?.tooltip).to.equal('Deepnote Input Date Range');
        });
    });

    suite('Case Insensitivity', () => {
        test('Should handle uppercase block type', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'INPUT-TEXT' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.not.be.undefined;
            expect(item?.text).to.equal('INPUT TEXT');
        });

        test('Should handle mixed case block type', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'Input-Text' } });
            const item = provider.provideCellStatusBarItems(cell);

            expect(item).to.not.be.undefined;
            expect(item?.text).to.equal('Input Text');
        });
    });
});
