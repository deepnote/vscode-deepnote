import { assert, expect } from 'chai';
import { anything, capture, verify, when } from 'ts-mockito';
import {
    EventEmitter,
    NotebookDocument,
    NotebookDocumentChangeEvent,
    NotebookEditor,
    StatusBarItem,
    Uri
} from 'vscode';

import { DeepnoteNotebookInfoStatusBar } from './deepnoteNotebookInfoStatusBar';
import { Commands } from '../../platform/common/constants';
import { mockedVSCode, mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import type { ITelemetryService, TelemetryEvent } from '../../platform/analytics/types';
import type { IDisposableRegistry } from '../../platform/common/types';

/**
 * Minimal fake StatusBarItem that records the fields the status bar sets so tests can assert on them.
 */
interface FakeStatusBarItem {
    name?: string;
    text: string;
    tooltip?: string;
    command?: string;
    visible: boolean;
    disposed: boolean;
    show(): void;
    hide(): void;
    dispose(): void;
}

function createFakeStatusBarItem(): FakeStatusBarItem {
    return {
        text: '',
        visible: false,
        disposed: false,
        show() {
            this.visible = true;
        },
        hide() {
            this.visible = false;
        },
        dispose() {
            this.disposed = true;
        }
    };
}

/**
 * Build a fake NotebookDocument with the Deepnote metadata the status bar reads.
 */
function makeNotebook(options: {
    notebookType?: string;
    metadata?: Record<string, unknown>;
    uri?: Uri;
}): NotebookDocument {
    return {
        notebookType: options.notebookType ?? 'deepnote',
        metadata: options.metadata ?? {},
        uri: options.uri ?? Uri.file('/workspace/proj.deepnote')
    } as unknown as NotebookDocument;
}

/**
 * Wrap a notebook in the minimal NotebookEditor the status bar reads (`editor.notebook`).
 */
function editorFor(notebook: NotebookDocument): NotebookEditor {
    return { notebook } as unknown as NotebookEditor;
}

/**
 * Build a document-change event for a notebook; the status bar only inspects `event.notebook`.
 */
function docChangeFor(notebook: NotebookDocument): NotebookDocumentChangeEvent {
    return { notebook, metadata: undefined, contentChanges: [], cellChanges: [] };
}

suite('DeepnoteNotebookInfoStatusBar', () => {
    let statusBar: DeepnoteNotebookInfoStatusBar;
    let fakeItem: FakeStatusBarItem;
    let disposableRegistry: IDisposableRegistry;
    let activeEditorEmitter: EventEmitter<NotebookEditor | undefined>;
    let docChangeEmitter: EventEmitter<NotebookDocumentChangeEvent>;
    let trackedEvents: TelemetryEvent[];

    setup(() => {
        resetVSCodeMocks();

        fakeItem = createFakeStatusBarItem();
        disposableRegistry = [];
        trackedEvents = [];

        // Real emitters drive the active-editor / document-change subscriptions; the status bar
        // subscribes through `.event` (which honours thisArg + the disposables array it passes).
        activeEditorEmitter = new EventEmitter();
        docChangeEmitter = new EventEmitter();

        when(mockedVSCodeNamespaces.window.createStatusBarItem(anything(), anything(), anything())).thenReturn(
            fakeItem as unknown as StatusBarItem
        );
        when(mockedVSCodeNamespaces.window.onDidChangeActiveNotebookEditor).thenReturn(activeEditorEmitter.event);
        when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument).thenReturn(docChangeEmitter.event);

        statusBar = new DeepnoteNotebookInfoStatusBar(disposableRegistry, {
            dispose: () => Promise.resolve(),
            trackEvent: (event: TelemetryEvent) => {
                trackedEvents.push(event);
            }
        } as ITelemetryService);
    });

    teardown(() => {
        try {
            statusBar.dispose();
        } catch {
            // ignore teardown disposal errors
        }
        resetVSCodeMocks();
    });

    test('shows "$(notebook) <name>" for an active deepnote notebook (name from metadata.deepnoteNotebookName)', () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(
            editorFor(makeNotebook({ metadata: { deepnoteNotebookName: 'My Analysis' } }))
        );

        statusBar.activate();

        assert.strictEqual(fakeItem.text, '$(notebook) My Analysis', 'must show the notebook icon + name');
        assert.isTrue(fakeItem.visible, 'status bar must be visible for a deepnote notebook');
        assert.strictEqual(fakeItem.command, Commands.CopyNotebookDetails, 'clicking copies notebook details');
    });

    test('HIDES the status bar for a non-deepnote active editor', () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(
            editorFor(makeNotebook({ notebookType: 'jupyter-notebook', metadata: { deepnoteNotebookName: 'X' } }))
        );

        statusBar.activate();

        assert.isFalse(fakeItem.visible, 'a non-deepnote editor must not show the Deepnote status bar');
    });

    test('updates on active-editor change (hidden → shown when a deepnote notebook becomes active)', () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
        statusBar.activate();
        assert.isFalse(fakeItem.visible, 'initially hidden with no active editor');

        // Now a deepnote notebook becomes active and the active-editor event fires.
        const editor = editorFor(makeNotebook({ metadata: { deepnoteNotebookName: 'Switched In' } }));
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editor);
        activeEditorEmitter.fire(editor);

        assert.isTrue(fakeItem.visible, 'becomes visible after the active editor switches to a deepnote notebook');
        assert.strictEqual(fakeItem.text, '$(notebook) Switched In');
    });

    test('updates on a document change to the ACTIVE notebook (renaming reflects in the status bar)', () => {
        const notebook = makeNotebook({ metadata: { deepnoteNotebookName: 'Before' } });
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editorFor(notebook));
        statusBar.activate();
        assert.strictEqual(fakeItem.text, '$(notebook) Before');

        // Mutate the active notebook's metadata and fire a change for THAT notebook.
        notebook.metadata.deepnoteNotebookName = 'After';
        docChangeEmitter.fire(docChangeFor(notebook));

        assert.strictEqual(fakeItem.text, '$(notebook) After', 'a change to the active notebook must refresh the text');
    });

    test('does NOT update on a document change to a DIFFERENT (non-active) notebook', () => {
        const activeNotebook = makeNotebook({ metadata: { deepnoteNotebookName: 'Active' } });
        const otherNotebook = makeNotebook({
            metadata: { deepnoteNotebookName: 'Other' },
            uri: Uri.file('/o.deepnote')
        });
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editorFor(activeNotebook));
        statusBar.activate();
        assert.strictEqual(fakeItem.text, '$(notebook) Active');

        // A change event for a different notebook must be ignored.
        otherNotebook.metadata.deepnoteNotebookName = 'Other Changed';
        docChangeEmitter.fire(docChangeFor(otherNotebook));

        assert.strictEqual(fakeItem.text, '$(notebook) Active', 'a non-active notebook change must not alter the bar');
    });

    test('CopyNotebookDetails writes the expected multi-line details (name, ids, project, version, URI) to the clipboard', async () => {
        const uri = Uri.file('/workspace/my-proj.deepnote');
        const editor = editorFor(
            makeNotebook({
                uri,
                metadata: {
                    deepnoteNotebookName: 'NB Name',
                    deepnoteNotebookId: 'nb-123',
                    deepnoteProjectName: 'Proj Name',
                    deepnoteProjectId: 'proj-456',
                    deepnoteVersion: '1.0.0'
                }
            })
        );
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editor);

        statusBar.activate();

        // Invoke the command handler registered against Commands.CopyNotebookDetails.
        const [, handler] = capture(mockedVSCodeNamespaces.commands.registerCommand).first();
        await handler();

        const clipboardText = await mockedVSCode.env!.clipboard.readText();
        const expected = [
            'Notebook name: NB Name',
            'Notebook ID: nb-123',
            'Project name: Proj Name',
            'Project ID: proj-456',
            'Version: 1.0.0',
            `URI: ${uri.toString()}`
        ].join('\n');

        assert.strictEqual(clipboardText, expected, 'clipboard must contain the full notebook detail block');
        assert.deepStrictEqual(
            trackedEvents,
            [{ eventName: 'copy_notebook_details' }],
            'a successful copy must report copy_notebook_details'
        );
    });

    test('CopyNotebookDetails warns and writes nothing when there is no active deepnote notebook', async () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);

        statusBar.activate();

        const [, handler] = capture(mockedVSCodeNamespaces.commands.registerCommand).first();
        await handler();

        verify(mockedVSCodeNamespaces.window.showWarningMessage(anything())).once();
        const clipboardText = await mockedVSCode.env!.clipboard.readText();
        assert.strictEqual(clipboardText, '', 'nothing should be copied when there is no active deepnote notebook');
        assert.deepStrictEqual(trackedEvents, [], 'the warning path must not report copy_notebook_details');
    });

    test('dispose() disposes the status bar item and clears its subscriptions', () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);
        statusBar.activate();

        statusBar.dispose();

        assert.isTrue(fakeItem.disposed, 'the status bar item must be disposed');
        // A second dispose must be a harmless no-op (subscriptions already drained).
        expect(() => statusBar.dispose()).to.not.throw();
    });
});
