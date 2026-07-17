// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { anything, instance, mock, when } from 'ts-mockito';
/* eslint-disable no-invalid-this, @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import { format } from '../platform/common/helpers';
import { noop } from '../platform/common/utils/misc';
import * as vscodeMocks from './mocks/vsc';

type VSCode = typeof vscode;

export const mockedVSCode: Partial<VSCode> = {};
export const mockedVSCodeNamespaces: { [P in keyof VSCode]: VSCode[P] } = {} as any;

function generateMock<K extends keyof VSCode>(name: K): void {
    const mockedObj = mock<VSCode[K]>();
    mockedVSCode[name] = instance(mockedObj);
    mockedVSCodeNamespaces[name] = mockedObj;
}

export class MockCommands {
    public log: string[] = [];
    public registerCommand(_command: string, _callback: (...args: any[]) => any, _thisArg?: any): vscode.Disposable {
        return { dispose: noop };
    }

    public registerTextEditorCommand(
        _command: string,
        _callback: (textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, ...args: any[]) => void,
        _thisArg?: any
    ): vscode.Disposable {
        return { dispose: noop };
    }

    public executeCommand<T>(command: string, ..._rest: any[]): Thenable<T | undefined> {
        this.log.push(command);
        return Promise.resolve(undefined);
    }

    public getCommands(_filterInternal?: boolean): Thenable<string[]> {
        return Promise.resolve([]);
    }
}

class MockClipboard {
    private text: string = '';
    public readText(): Promise<string> {
        return Promise.resolve(this.text);
    }
    public async writeText(value: string): Promise<void> {
        this.text = value;
    }
}

export function resetVSCodeMocks() {
    generateMock('workspace');
    generateMock('window');
    generateMock('languages');
    generateMock('env');
    generateMock('debug');
    generateMock('scm');
    generateMock('env');
    generateMock('notebooks');
    generateMock('commands');
    generateMock('extensions');

    // Workspace event emitters
    const onDidChangeConfiguration = new vscodeMocks.vscMock.EventEmitter<vscode.ConfigurationChangeEvent>();
    const onDidCloseNotebookDocument = new vscodeMocks.vscMock.EventEmitter<vscode.NotebookDocument>();
    const onDidOpenNotebookDocument = new vscodeMocks.vscMock.EventEmitter<vscode.NotebookDocument>();
    const onDidGrantWorkspaceTrust = new vscodeMocks.vscMock.EventEmitter<void>();

    when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);
    when(mockedVSCodeNamespaces.workspace.onDidChangeConfiguration).thenReturn(onDidChangeConfiguration.event);
    when(mockedVSCodeNamespaces.workspace.onDidCloseNotebookDocument).thenReturn(onDidCloseNotebookDocument.event);
    when(mockedVSCodeNamespaces.workspace.onDidOpenNotebookDocument).thenReturn(onDidOpenNotebookDocument.event);
    when(mockedVSCodeNamespaces.workspace.onDidGrantWorkspaceTrust).thenReturn(onDidGrantWorkspaceTrust.event);
    when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(undefined);
    when(mockedVSCodeNamespaces.workspace.isTrusted).thenReturn(true);

    when(mockedVSCodeNamespaces.window.visibleNotebookEditors).thenReturn([]);
    when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(undefined);
    when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);

    // Window dialog methods with overloads (1-5 parameters)
    // showInformationMessage
    when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything())).thenResolve(
        undefined as any
    );
    when(
        mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
    ).thenResolve(undefined as any);
    when(
        mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything(), anything())
    ).thenResolve(undefined as any);

    // showErrorMessage
    when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything(), anything())).thenResolve(
        undefined as any
    );
    when(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything(), anything(), anything())).thenResolve(
        undefined as any
    );
    when(
        mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything(), anything(), anything(), anything())
    ).thenResolve(undefined as any);

    // showWarningMessage
    when(mockedVSCodeNamespaces.window.showWarningMessage(anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenResolve(
        undefined as any
    );
    when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything(), anything())).thenResolve(
        undefined as any
    );
    when(
        mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything(), anything(), anything())
    ).thenResolve(undefined as any);

    // showQuickPick
    when(mockedVSCodeNamespaces.window.showQuickPick(anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything(), anything())).thenResolve(undefined as any);

    // showInputBox
    when(mockedVSCodeNamespaces.window.showInputBox()).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showInputBox(anything(), anything())).thenResolve(undefined as any);

    // showTextDocument
    when(mockedVSCodeNamespaces.window.showTextDocument(anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showTextDocument(anything(), anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showTextDocument(anything(), anything(), anything())).thenResolve(
        undefined as any
    );

    // showNotebookDocument
    when(mockedVSCodeNamespaces.window.showNotebookDocument(anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.window.showNotebookDocument(anything(), anything())).thenResolve(undefined as any);

    // showOpenDialog
    when(mockedVSCodeNamespaces.window.showOpenDialog(anything())).thenResolve(undefined as any);

    // withProgress - execute the callback and return its result
    when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_options, callback) => {
        return Promise.resolve(
            callback(
                { report: () => {} },
                { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) as any }
            )
        );
    });

    // createOutputChannel - return a mock output channel
    const mockOutputChannel = {
        name: 'Mock Output Channel',
        append: () => {},
        appendLine: () => {},
        replace: () => {},
        clear: () => {},
        show: () => {},
        hide: () => {},
        dispose: () => {}
    };
    when(mockedVSCodeNamespaces.window.createOutputChannel(anything())).thenReturn(mockOutputChannel as any);
    when(mockedVSCodeNamespaces.window.createOutputChannel(anything(), anything())).thenReturn(
        mockOutputChannel as any
    );

    // Workspace methods
    // getConfiguration - return a mock configuration object
    const mockConfiguration = {
        get: () => undefined,
        has: () => false,
        inspect: () => undefined,
        update: () => Promise.resolve()
    };
    when(mockedVSCodeNamespaces.workspace.getConfiguration()).thenReturn(mockConfiguration as any);
    when(mockedVSCodeNamespaces.workspace.getConfiguration(anything())).thenReturn(mockConfiguration as any);
    when(mockedVSCodeNamespaces.workspace.getConfiguration(anything(), anything())).thenReturn(
        mockConfiguration as any
    );

    // applyEdit
    when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenResolve(true as any);

    // openTextDocument
    when(mockedVSCodeNamespaces.workspace.openTextDocument(anything())).thenResolve(undefined as any);

    // openNotebookDocument
    when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenResolve(undefined as any);
    when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything(), anything())).thenResolve(undefined as any);

    // Use mock clipboard fo testing purposes.
    const clipboard = new MockClipboard();
    when(mockedVSCodeNamespaces.env.clipboard).thenReturn(clipboard);
    when(mockedVSCodeNamespaces.env.appName).thenReturn('Insider');

    // Apply mockedVSCode customizations
    mockedVSCode.l10n = {
        bundle: undefined,
        t: (
            arg1: string | { message: string; args?: string[] | Record<string, string> },
            ...restOfArguments: string[]
        ) => {
            if (typeof arg1 === 'string') {
                if (restOfArguments.length === 0) {
                    return arg1;
                }
                if (typeof restOfArguments === 'object' && !Array.isArray(restOfArguments)) {
                    throw new Error('Records for l10n.t() are not supported in the mock');
                }
                return format(arg1, ...restOfArguments);
            }
            if (typeof arg1 === 'object') {
                const message = arg1.message;
                const args = arg1.args || [];
                if (typeof args === 'object' && !Array.isArray(args)) {
                    throw new Error('Records for l10n.t() are not supported in the mock');
                }
                if (args.length === 0) {
                    return message;
                }
                return format(message, ...args);
            }
            return arg1;
        },
        uri: undefined
    } as any;
    mockedVSCode.MarkdownString = vscodeMocks.vscMock.MarkdownString;
    mockedVSCode.MarkdownString = vscodeMocks.vscMock.MarkdownString;
    mockedVSCode.Hover = vscodeMocks.vscMock.Hover;
    mockedVSCode.Disposable = vscodeMocks.vscMock.Disposable as any;
    mockedVSCode.TabInputNotebook = vscodeMocks.vscMock.TabInputNotebook as any;
    mockedVSCode.ExtensionKind = vscodeMocks.vscMock.ExtensionKind;
    mockedVSCode.ExtensionMode = vscodeMocks.vscMock.ExtensionMode;
    mockedVSCode.CodeAction = vscodeMocks.vscMock.CodeAction;
    mockedVSCode.EventEmitter = vscodeMocks.vscMock.EventEmitter;
    mockedVSCode.CancellationError = vscodeMocks.vscMock.CancellationError;
    mockedVSCode.CancellationTokenSource = vscodeMocks.vscMock.CancellationTokenSource;
    mockedVSCode.CompletionItemKind = vscodeMocks.vscMock.CompletionItemKind;
    mockedVSCode.SymbolKind = vscodeMocks.vscMock.SymbolKind;
    mockedVSCode.IndentAction = vscodeMocks.vscMock.IndentAction;
    mockedVSCode.Uri = vscodeMocks.vscUri.URI as any;
    mockedVSCode.Range = vscodeMocks.vscMockExtHostedTypes.Range;
    mockedVSCode.Position = vscodeMocks.vscMockExtHostedTypes.Position;
    mockedVSCode.Selection = vscodeMocks.vscMockExtHostedTypes.Selection;
    mockedVSCode.Location = vscodeMocks.vscMockExtHostedTypes.Location;
    mockedVSCode.SymbolInformation = vscodeMocks.vscMockExtHostedTypes.SymbolInformation;
    mockedVSCode.CompletionItem = vscodeMocks.vscMockExtHostedTypes.CompletionItem;
    mockedVSCode.CompletionItemKind = vscodeMocks.vscMockExtHostedTypes.CompletionItemKind;
    mockedVSCode.CodeLens = vscodeMocks.vscMockExtHostedTypes.CodeLens;
    mockedVSCode.Diagnostic = vscodeMocks.vscMockExtHostedTypes.Diagnostic;
    mockedVSCode.CallHierarchyItem = vscodeMocks.vscMockExtHostedTypes.CallHierarchyItem;
    mockedVSCode.DiagnosticSeverity = vscodeMocks.vscMockExtHostedTypes.DiagnosticSeverity;
    mockedVSCode.SnippetString = vscodeMocks.vscMockExtHostedTypes.SnippetString;
    mockedVSCode.ConfigurationTarget = vscodeMocks.vscMockExtHostedTypes.ConfigurationTarget;
    mockedVSCode.StatusBarAlignment = vscodeMocks.vscMockExtHostedTypes.StatusBarAlignment;
    mockedVSCode.SignatureHelp = vscodeMocks.vscMockExtHostedTypes.SignatureHelp;
    mockedVSCode.DocumentLink = vscodeMocks.vscMockExtHostedTypes.DocumentLink;
    mockedVSCode.TextEdit = vscodeMocks.vscMockExtHostedTypes.TextEdit;
    mockedVSCode.WorkspaceEdit = vscodeMocks.vscMockExtHostedTypes.WorkspaceEdit;
    mockedVSCode.RelativePattern = vscodeMocks.vscMockExtHostedTypes.RelativePattern;
    mockedVSCode.ProgressLocation = vscodeMocks.vscMockExtHostedTypes.ProgressLocation;
    mockedVSCode.ViewColumn = vscodeMocks.vscMockExtHostedTypes.ViewColumn;
    mockedVSCode.TextEditorRevealType = vscodeMocks.vscMockExtHostedTypes.TextEditorRevealType;
    mockedVSCode.TreeItem = vscodeMocks.vscMockExtHostedTypes.TreeItem;
    mockedVSCode.TreeItemCollapsibleState = vscodeMocks.vscMockExtHostedTypes.TreeItemCollapsibleState;
    mockedVSCode.CodeActionKind = vscodeMocks.vscMock.CodeActionKind;
    mockedVSCode.CompletionItemKind = vscodeMocks.vscMock.CompletionItemKind;
    mockedVSCode.CompletionTriggerKind = vscodeMocks.vscMock.CompletionTriggerKind;
    mockedVSCode.DebugAdapterExecutable = vscodeMocks.vscMock.DebugAdapterExecutable;
    mockedVSCode.DebugAdapterServer = vscodeMocks.vscMock.DebugAdapterServer;
    mockedVSCode.QuickInputButtons = vscodeMocks.vscMockExtHostedTypes.QuickInputButtons;
    mockedVSCode.FileType = vscodeMocks.vscMock.FileType;
    mockedVSCode.UIKind = vscodeMocks.vscMock.UIKind;
    mockedVSCode.ThemeIcon = vscodeMocks.vscMockExtHostedTypes.ThemeIcon;
    mockedVSCode.ThemeColor = vscodeMocks.vscMockExtHostedTypes.ThemeColor;
    mockedVSCode.FileSystemError = vscodeMocks.vscMockExtHostedTypes.FileSystemError;
    mockedVSCode.FileDecoration = vscodeMocks.vscMockExtHostedTypes.FileDecoration;
    mockedVSCode.PortAutoForwardAction = vscodeMocks.vscMockExtHostedTypes.PortAutoForwardAction;
    mockedVSCode.PortAttributes = vscodeMocks.vscMockExtHostedTypes.PortAttributes;
    mockedVSCode.NotebookRendererScript = vscodeMocks.vscMockExtHostedTypes.NotebookRendererScript;
    mockedVSCode.NotebookEdit = vscodeMocks.vscMockExtHostedTypes.NotebookEdit;
    mockedVSCode.NotebookRange = vscodeMocks.vscMockExtHostedTypes.NotebookRange;
    mockedVSCode.QuickPickItemKind = vscodeMocks.vscMockExtHostedTypes.QuickPickItemKind;
    (mockedVSCode as any).LogLevel = vscodeMocks.vscMockExtHostedTypes.LogLevel;
    (mockedVSCode.NotebookCellData as any) = vscodeMocks.vscMockExtHostedTypes.NotebookCellData;
    (mockedVSCode as any).NotebookCellKind = vscodeMocks.vscMockExtHostedTypes.NotebookCellKind;
    (mockedVSCode as any).NotebookCellRunState = vscodeMocks.vscMockExtHostedTypes.NotebookCellRunState;
    (mockedVSCode as any).NotebookControllerAffinity = vscodeMocks.vscMockExtHostedTypes.NotebookControllerAffinity;
    mockedVSCode.NotebookCellOutput = vscodeMocks.vscMockExtHostedTypes.NotebookCellOutput;
    (mockedVSCode as any).NotebookCellOutputItem = vscodeMocks.vscMockExtHostedTypes.NotebookCellOutputItem;
    (mockedVSCode as any).NotebookCellExecutionState = vscodeMocks.vscMockExtHostedTypes.NotebookCellExecutionState;
    (mockedVSCode as any).NotebookEditorRevealType = vscodeMocks.vscMockExtHostedTypes.NotebookEditorRevealType;
    // Mock ColorThemeKind enum
    (mockedVSCode as any).ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
    mockedVSCode.EndOfLine = vscodeMocks.vscMockExtHostedTypes.EndOfLine;
}

export function initialize() {
    resetVSCodeMocks();

    // In ESM, module mocking is handled by the mocha-esm-loader.js
    // No need to override Module._load anymore
}

// Initialize mocks at module load time to ensure they're available when the mocha-esm-loader
// creates the vscode module exports
resetVSCodeMocks();
