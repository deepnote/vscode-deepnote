import { anything, instance, mock, verify, when } from 'ts-mockito';
import { Disposable, EventEmitter, NotebookCell, NotebookDocument, TextDocument, Uri } from 'vscode';

import { IDisposable } from '../../../platform/common/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IIntegrationStorage } from './types';
import { IKernel, IKernelProvider } from '../../../kernels/types';
import { IntegrationKernelRestartHandler } from './integrationKernelRestartHandler';
import { DATAFRAME_SQL_INTEGRATION_ID } from '../../../platform/notebooks/deepnote/integrationTypes';

suite('IntegrationKernelRestartHandler', () => {
    let handler: IntegrationKernelRestartHandler;
    let integrationStorage: IIntegrationStorage;
    let kernelProvider: IKernelProvider;
    let disposables: IDisposable[];
    let onDidChangeIntegrations: EventEmitter<void>;

    setup(() => {
        resetVSCodeMocks();
        disposables = [new Disposable(() => resetVSCodeMocks())];
        integrationStorage = mock<IIntegrationStorage>();
        kernelProvider = mock<IKernelProvider>();
        onDidChangeIntegrations = new EventEmitter<void>();
        disposables.push(onDidChangeIntegrations);

        when(integrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrations.event);

        handler = new IntegrationKernelRestartHandler(
            instance(integrationStorage),
            instance(kernelProvider),
            disposables
        );
    });

    teardown(() => {
        disposables = dispose(disposables);
    });

    function createMockNotebook(
        notebookType: string,
        uri: Uri,
        cells: { languageId: string; metadata?: Record<string, unknown> }[]
    ): NotebookDocument {
        const notebook = mock<NotebookDocument>();
        const mockCells: NotebookCell[] = cells.map((cellConfig, index) => {
            const cell = mock<NotebookCell>();
            const doc = mock<TextDocument>();
            when(doc.languageId).thenReturn(cellConfig.languageId);
            when(cell.document).thenReturn(instance(doc));
            when(cell.metadata).thenReturn(cellConfig.metadata || {});
            when(cell.index).thenReturn(index);
            return instance(cell);
        });

        when(notebook.notebookType).thenReturn(notebookType);
        when(notebook.uri).thenReturn(uri);
        when(notebook.getCells()).thenReturn(mockCells);

        return instance(notebook);
    }

    test('restarts kernel when integration changes and notebook uses SQL integrations', async () => {
        const notebook = createMockNotebook('deepnote', Uri.file('/test.ipynb'), [
            { languageId: 'sql', metadata: { sql_integration_id: 'postgres-1' } }
        ]);
        const mockKernel = mock<IKernel>();
        when(mockKernel.startedAtLeastOnce).thenReturn(true);
        when(mockKernel.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(kernelProvider.get(notebook)).thenReturn(instance(mockKernel));

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockKernel.restart()).once();
    });

    test('does not restart kernel for non-Deepnote notebooks', async () => {
        const notebook = createMockNotebook('jupyter-notebook', Uri.file('/test.ipynb'), [
            { languageId: 'sql', metadata: { sql_integration_id: 'postgres-1' } }
        ]);
        const mockKernel = mock<IKernel>();
        when(mockKernel.startedAtLeastOnce).thenReturn(true);
        when(mockKernel.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(kernelProvider.get(notebook)).thenReturn(instance(mockKernel));

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockKernel.restart()).never();
    });

    test('does not restart kernel that has not started', async () => {
        const notebook = createMockNotebook('deepnote', Uri.file('/test.ipynb'), [
            { languageId: 'sql', metadata: { sql_integration_id: 'postgres-1' } }
        ]);
        const mockKernel = mock<IKernel>();
        when(mockKernel.startedAtLeastOnce).thenReturn(false);
        when(mockKernel.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(kernelProvider.get(notebook)).thenReturn(instance(mockKernel));

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockKernel.restart()).never();
    });

    test('does not restart kernel when notebook has no SQL integrations', async () => {
        const notebook = createMockNotebook('deepnote', Uri.file('/test.ipynb'), [
            { languageId: 'python', metadata: {} }
        ]);
        const mockKernel = mock<IKernel>();
        when(mockKernel.startedAtLeastOnce).thenReturn(true);
        when(mockKernel.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(kernelProvider.get(notebook)).thenReturn(instance(mockKernel));

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockKernel.restart()).never();
    });

    test('does not restart kernel when notebook only uses internal DuckDB integration', async () => {
        const notebook = createMockNotebook('deepnote', Uri.file('/test.ipynb'), [
            { languageId: 'sql', metadata: { sql_integration_id: DATAFRAME_SQL_INTEGRATION_ID } }
        ]);
        const mockKernel = mock<IKernel>();
        when(mockKernel.startedAtLeastOnce).thenReturn(true);
        when(mockKernel.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(kernelProvider.get(notebook)).thenReturn(instance(mockKernel));

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockKernel.restart()).never();
    });

    test('restarts multiple kernels in parallel', async () => {
        const notebook1 = createMockNotebook('deepnote', Uri.file('/test1.ipynb'), [
            { languageId: 'sql', metadata: { sql_integration_id: 'postgres-1' } }
        ]);
        const notebook2 = createMockNotebook('deepnote', Uri.file('/test2.ipynb'), [
            { languageId: 'sql', metadata: { sql_integration_id: 'bigquery-1' } }
        ]);
        const mockKernel1 = mock<IKernel>();
        const mockKernel2 = mock<IKernel>();
        when(mockKernel1.startedAtLeastOnce).thenReturn(true);
        when(mockKernel1.restart()).thenResolve();
        when(mockKernel2.startedAtLeastOnce).thenReturn(true);
        when(mockKernel2.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1, notebook2]);
        when(kernelProvider.get(notebook1)).thenReturn(instance(mockKernel1));
        when(kernelProvider.get(notebook2)).thenReturn(instance(mockKernel2));

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockKernel1.restart()).once();
        verify(mockKernel2.restart()).once();
    });

    test('continues restarting other kernels when one fails', async () => {
        const notebook1 = createMockNotebook('deepnote', Uri.file('/test1.ipynb'), [
            { languageId: 'sql', metadata: { sql_integration_id: 'postgres-1' } }
        ]);
        const notebook2 = createMockNotebook('deepnote', Uri.file('/test2.ipynb'), [
            { languageId: 'sql', metadata: { sql_integration_id: 'bigquery-1' } }
        ]);
        const mockKernel1 = mock<IKernel>();
        const mockKernel2 = mock<IKernel>();
        when(mockKernel1.startedAtLeastOnce).thenReturn(true);
        when(mockKernel1.restart()).thenReject(new Error('Restart failed'));
        when(mockKernel2.startedAtLeastOnce).thenReturn(true);
        when(mockKernel2.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1, notebook2]);
        when(kernelProvider.get(notebook1)).thenReturn(instance(mockKernel1));
        when(kernelProvider.get(notebook2)).thenReturn(instance(mockKernel2));

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockKernel1.restart()).once();
        verify(mockKernel2.restart()).once();
    });

    test('handles notebooks with mixed cell types', async () => {
        const notebook = createMockNotebook('deepnote', Uri.file('/test.ipynb'), [
            { languageId: 'python', metadata: {} },
            { languageId: 'sql', metadata: { sql_integration_id: 'postgres-1' } },
            { languageId: 'markdown', metadata: {} }
        ]);
        const mockKernel = mock<IKernel>();
        when(mockKernel.startedAtLeastOnce).thenReturn(true);
        when(mockKernel.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(kernelProvider.get(notebook)).thenReturn(instance(mockKernel));

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockKernel.restart()).once();
    });

    test('does not restart when no notebooks are open', async () => {
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(kernelProvider.get(anything())).never();
    });
});
