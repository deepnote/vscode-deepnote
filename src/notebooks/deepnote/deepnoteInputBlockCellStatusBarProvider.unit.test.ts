// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect } from 'chai';
import { anything, verify, when } from 'ts-mockito';

import { CancellationToken, NotebookCell, NotebookCellKind, NotebookDocument, Uri } from 'vscode';

import type { IExtensionContext } from '../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { DeepnoteInputBlockCellStatusBarItemProvider } from './deepnoteInputBlockCellStatusBarProvider';

suite('DeepnoteInputBlockCellStatusBarItemProvider', () => {
    let provider: DeepnoteInputBlockCellStatusBarItemProvider;
    let mockExtensionContext: IExtensionContext;
    let mockToken: CancellationToken;

    setup(() => {
        mockExtensionContext = {
            subscriptions: []
        } as any;
        mockToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => {} })
        } as any;
        provider = new DeepnoteInputBlockCellStatusBarItemProvider(mockExtensionContext);
    });

    teardown(() => {
        provider.dispose();
    });

    function createMockCell(metadata?: Record<string, unknown>): NotebookCell {
        const notebookUri = Uri.file('/test/notebook.deepnote');
        return {
            index: 0,
            notebook: {
                uri: notebookUri
            } as NotebookDocument,
            kind: NotebookCellKind.Code,
            document: {
                uri: Uri.file('/test/notebook.deepnote#cell0'),
                fileName: '/test/notebook.deepnote#cell0',
                isUntitled: false,
                languageId: 'json',
                version: 1,
                isDirty: false,
                isClosed: false,
                getText: () => '',
                save: async () => true,
                eol: 1,
                lineCount: 1,
                lineAt: () => ({ text: '' }) as any,
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
        test('Should return status bar items for input-text block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-text' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items).to.have.length.at.least(2);
            expect(items?.[0].text).to.equal('Input Text');
            expect(items?.[0].alignment).to.equal(1); // Left
        });

        test('Should return status bar items for input-textarea block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-textarea' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items).to.have.length.at.least(2);
            expect(items?.[0].text).to.equal('Input Textarea');
        });

        test('Should return status bar items for input-select block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-select' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items).to.have.length.at.least(2); // Type label, variable, and selection button
            expect(items?.[0].text).to.equal('Input Select');
        });

        test('Should return status bar items for input-slider block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-slider' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items).to.have.length.at.least(2); // Type label, variable, min, and max buttons
            expect(items?.[0].text).to.equal('Input Slider');
        });

        test('Should return status bar items for input-checkbox block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-checkbox' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items).to.have.length.at.least(2); // Type label, variable, and toggle button
            expect(items?.[0].text).to.equal('Input Checkbox');
        });

        test('Should return status bar items for input-date block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-date' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items).to.have.length.at.least(2); // Type label, variable, and date button
            expect(items?.[0].text).to.equal('Input Date');
        });

        test('Should return status bar items for input-date-range block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-date-range' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items).to.have.length.at.least(2); // Type label, variable, start, and end buttons
            expect(items?.[0].text).to.equal('Input Date Range');
        });

        test('Should return status bar items for input-file block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-file' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items).to.have.lengthOf(3); // Type label, variable, and choose file button
            expect(items?.[0].text).to.equal('Input File');
        });

        test('Should return status bar items for button block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'button' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items).to.have.length.at.least(2);
            expect(items?.[0].text).to.equal('Button');
        });
    });

    suite('Non-Input Block Types', () => {
        test('Should return undefined for code block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'code' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined for sql block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'sql' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined for markdown block', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'text-cell-p' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined for cell with no type metadata', () => {
            const cell = createMockCell({});
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined for cell with undefined metadata', () => {
            const cell = createMockCell(undefined);
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });
    });

    suite('Status Bar Item Properties', () => {
        test('Should have correct tooltip for input-text', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-text' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items?.[0].tooltip).to.equal('Deepnote Input Text');
        });

        test('Should have correct tooltip for button', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'button' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items?.[0].tooltip).to.equal('Deepnote Button');
        });

        test('Should format multi-word block types correctly', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'input-date-range' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items?.[0].text).to.equal('Input Date Range');
            expect(items?.[0].tooltip).to.equal('Deepnote Input Date Range');
        });
    });

    suite('Case Insensitivity', () => {
        test('Should handle uppercase block type', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'INPUT-TEXT' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items?.[0].text).to.equal('INPUT TEXT');
        });

        test('Should handle mixed case block type', () => {
            const cell = createMockCell({ __deepnotePocket: { type: 'Input-Text' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items?.[0].text).to.equal('Input Text');
        });
    });

    suite('Command Handlers', () => {
        setup(() => {
            resetVSCodeMocks();
        });

        teardown(() => {
            resetVSCodeMocks();
        });

        suite('deepnote.updateInputBlockVariableName', () => {
            test('should update variable name when valid input is provided', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-text' },
                    deepnote_variable_name: 'old_var'
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('new_var'));
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).updateVariableName(cell);

                verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });

            test('should not update if user cancels input', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-text' },
                    deepnote_variable_name: 'old_var'
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

                await (provider as any).updateVariableName(cell);

                verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });

            test('should not update if variable name is unchanged', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-text' },
                    deepnote_variable_name: 'my_var'
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('my_var'));

                await (provider as any).updateVariableName(cell);

                verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });

            test('should show error if workspace edit fails', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-text' },
                    deepnote_variable_name: 'old_var'
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('new_var'));
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(false));

                await (provider as any).updateVariableName(cell);

                verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
            });
        });

        suite('deepnote.checkboxToggle', () => {
            test('should toggle checkbox from false to true', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-checkbox' },
                    deepnote_variable_value: false
                });

                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).checkboxToggle(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });

            test('should toggle checkbox from true to false', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-checkbox' },
                    deepnote_variable_value: true
                });

                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).checkboxToggle(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });

            test('should default to false if value is undefined', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-checkbox' }
                });

                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).checkboxToggle(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });
        });

        suite('deepnote.sliderSetMin', () => {
            test('should update slider min value', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-slider' },
                    deepnote_slider_min_value: 0
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('5'));
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).sliderSetMin(cell);

                verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });

            test('should not update if user cancels', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-slider' },
                    deepnote_slider_min_value: 0
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

                await (provider as any).sliderSetMin(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });
        });

        suite('deepnote.sliderSetMax', () => {
            test('should update slider max value', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-slider' },
                    deepnote_slider_max_value: 10
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('20'));
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).sliderSetMax(cell);

                verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });

            test('should not update if user cancels', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-slider' },
                    deepnote_slider_max_value: 10
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

                await (provider as any).sliderSetMax(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });
        });

        suite('deepnote.sliderSetStep', () => {
            test('should update slider step value', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-slider' },
                    deepnote_slider_step: 1
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('0.5'));
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).sliderSetStep(cell);

                verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });

            test('should not update if user cancels', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-slider' },
                    deepnote_slider_step: 1
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

                await (provider as any).sliderSetStep(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });
        });

        suite('deepnote.selectInputChooseOption', () => {
            test('should update single select value', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-select' },
                    deepnote_variable_select_type: 'from-options',
                    deepnote_variable_options: ['option1', 'option2', 'option3'],
                    deepnote_variable_value: 'option1',
                    deepnote_allow_multiple_values: false
                });

                when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                    Promise.resolve({ label: 'option2' } as any)
                );
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).selectInputChooseOption(cell);

                verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });

            test('should not update if user cancels single select', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-select' },
                    deepnote_variable_select_type: 'from-options',
                    deepnote_variable_options: ['option1', 'option2'],
                    deepnote_allow_multiple_values: false
                });

                when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                    Promise.resolve(undefined)
                );

                await (provider as any).selectInputChooseOption(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });

            test('should show info message for from-variable select type', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-select' },
                    deepnote_variable_select_type: 'from-variable',
                    deepnote_variable_selected_variable: 'my_options'
                });

                await (provider as any).selectInputChooseOption(cell);

                verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });

            test('should show warning if no options available', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-select' },
                    deepnote_variable_select_type: 'from-options',
                    deepnote_variable_options: []
                });

                await (provider as any).selectInputChooseOption(cell);

                verify(mockedVSCodeNamespaces.window.showWarningMessage(anything())).once();
            });
        });

        suite('deepnote.selectInputSettings', () => {
            test('should open settings webview and fire status bar update', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-select' }
                });

                // Mock the webview show method
                const webview = (provider as any).selectInputSettingsWebview;
                let showCalled = false;
                webview.show = async () => {
                    showCalled = true;
                };

                // Track if the event was fired
                let eventFired = false;
                const disposable = provider.onDidChangeCellStatusBarItems(() => {
                    eventFired = true;
                });

                try {
                    await (provider as any).selectInputSettings(cell);

                    expect(showCalled).to.be.true;
                    expect(eventFired).to.be.true;
                } finally {
                    disposable.dispose();
                }
            });
        });

        suite('deepnote.fileInputChooseFile', () => {
            test('should update file path when file is selected', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-file' }
                });

                const mockUri = Uri.file('/path/to/file.txt');
                when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve([mockUri]));
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).fileInputChooseFile(cell);

                verify(mockedVSCodeNamespaces.window.showOpenDialog(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });

            test('should not update if user cancels file selection', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-file' }
                });

                when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve(undefined));

                await (provider as any).fileInputChooseFile(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });

            test('should not update if empty array is returned', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-file' }
                });

                when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenReturn(Promise.resolve([]));

                await (provider as any).fileInputChooseFile(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });
        });

        suite('deepnote.dateInputChooseDate', () => {
            test('should update date value when valid date is provided', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-date' },
                    deepnote_variable_value: '2024-01-01'
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('2024-12-31'));
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).dateInputChooseDate(cell);

                verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });

            test('should not update if user cancels date input', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-date' }
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

                await (provider as any).dateInputChooseDate(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });
        });

        suite('deepnote.dateRangeChooseStart', () => {
            test('should update start date in date range', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-date-range' },
                    deepnote_variable_value: ['2024-01-01', '2024-12-31']
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('2024-02-01'));
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).dateRangeChooseStart(cell);

                verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });

            test('should not update if user cancels start date input', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-date-range' },
                    deepnote_variable_value: ['2024-01-01', '2024-12-31']
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

                await (provider as any).dateRangeChooseStart(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });

            test('should show warning if start date is after end date', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-date-range' },
                    deepnote_variable_value: ['2024-01-01', '2024-06-30']
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('2024-12-31'));
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).dateRangeChooseStart(cell);

                verify(mockedVSCodeNamespaces.window.showWarningMessage(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });
        });

        suite('deepnote.dateRangeChooseEnd', () => {
            test('should update end date in date range', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-date-range' },
                    deepnote_variable_value: ['2024-01-01', '2024-12-31']
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('2024-11-30'));
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).dateRangeChooseEnd(cell);

                verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });

            test('should not update if user cancels end date input', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-date-range' },
                    deepnote_variable_value: ['2024-01-01', '2024-12-31']
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

                await (provider as any).dateRangeChooseEnd(cell);

                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });

            test('should show warning if end date is before start date', async () => {
                const cell = createMockCell({
                    __deepnotePocket: { type: 'input-date-range' },
                    deepnote_variable_value: ['2024-06-01', '2024-12-31']
                });

                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('2024-01-01'));
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

                await (provider as any).dateRangeChooseEnd(cell);

                verify(mockedVSCodeNamespaces.window.showWarningMessage(anything())).once();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            });
        });
    });
});
