/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
import { assert } from 'chai';
import { Uri, workspace, NotebookDocument } from 'vscode';
import { IDisposable } from '../../../platform/common/types';
import { captureScreenShot, IExtensionTestApi, waitForCondition } from '../../common.node';
import { EXTENSION_ROOT_DIR_FOR_TESTS, initialize } from '../../initialize.node';
import { closeNotebooksAndCleanUpAfterTests, startJupyterServer, getDefaultKernelConnection } from './helper.node';
import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager } from '../../../notebooks/types';
import { IKernel, IKernelProvider, INotebookKernelExecution } from '../../../kernels/types';
import { createKernelController } from './executionHelper';

/* eslint-disable @typescript-eslint/no-explicit-any, no-invalid-this */
suite('Deepnote Integration Tests @kernelCore', function () {
    let api: IExtensionTestApi;
    const disposables: IDisposable[] = [];
    const deepnoteFilePath = Uri.joinPath(
        Uri.file(EXTENSION_ROOT_DIR_FOR_TESTS),
        'src',
        'test',
        'datascience',
        'notebook',
        'test.deepnote'
    );
    let nbDocument: NotebookDocument;
    let kernel: IKernel;
    let kernelExecution: INotebookKernelExecution;
    this.timeout(240_000);

    suiteSetup(async function () {
        logger.info('Suite Setup VS Code Notebook - Deepnote Integration');
        this.timeout(240_000);
        try {
            api = await initialize();
            logger.info('After initialize');

            await startJupyterServer();
            logger.info('After starting Jupyter');

            const notebookManager = api.serviceContainer.get<IDeepnoteNotebookManager>(IDeepnoteNotebookManager);
            notebookManager.selectNotebookForProject('test-project-id', 'main-notebook-id');

            nbDocument = await workspace.openNotebookDocument(deepnoteFilePath);
            logger.info(`Opened notebook with ${nbDocument.cellCount} cells`);

            const kernelProvider = api.serviceContainer.get<IKernelProvider>(IKernelProvider);
            const metadata = await getDefaultKernelConnection();
            const controller = createKernelController();
            kernel = kernelProvider.getOrCreate(nbDocument, { metadata, resourceUri: nbDocument.uri, controller });
            logger.info('Before starting kernel');
            await kernel.start();
            logger.info('After starting kernel');
            kernelExecution = kernelProvider.getKernelExecution(kernel);

            logger.info('Suite Setup (completed)');
        } catch (e) {
            logger.error('Suite Setup (failed) - Deepnote Integration', e);
            await captureScreenShot('deepnote-suite');
            throw e;
        }
    });

    setup(function () {
        logger.info(`Start Test (completed) ${this.currentTest?.title}`);
    });

    teardown(async function () {
        if (this.currentTest?.isFailed()) {
            await captureScreenShot(this);
        }
        logger.info(`Ended Test (completed) ${this.currentTest?.title}`);
    });

    suiteTeardown(() => closeNotebooksAndCleanUpAfterTests(disposables));

    test('Load .deepnote file', async function () {
        logger.debug('Test: Load .deepnote file - starting');

        assert.equal(nbDocument.notebookType, 'deepnote', 'Notebook type should be deepnote');
        assert.equal(nbDocument.cellCount, 3, 'Notebook should have 3 cells');
        assert.equal(nbDocument.metadata?.deepnoteProjectId, 'test-project-id', 'Project ID should match');
        assert.equal(nbDocument.metadata?.deepnoteNotebookId, 'main-notebook-id', 'Notebook ID should match');

        logger.debug('Test: Load .deepnote file - completed');
    });

    test('Execute code cell and verify output', async function () {
        logger.debug('Test: Execute code cell - starting');

        const cell = nbDocument.cellAt(0);
        assert.equal(cell.kind, 1, 'First cell should be a code cell');

        await kernelExecution.executeCell(cell);

        await waitForCondition(
            async () => cell.executionSummary?.success === true,
            30_000,
            'Cell execution did not complete successfully'
        );

        assert.isAtLeast(cell.executionSummary?.executionOrder || 0, 1, 'Cell should have execution order');
        assert.isTrue(cell.executionSummary?.success, 'Cell execution should succeed');
        assert.isAtLeast(cell.outputs.length, 1, 'Cell should have at least one output');

        const outputText = new TextDecoder().decode(cell.outputs[0].items[0].data).toString();
        assert.include(outputText, 'Hello World', 'Output should contain "Hello World"');

        logger.debug('Test: Execute code cell - completed');
    });

    test('Execute multiple code cells with shared state', async function () {
        logger.debug('Test: Execute multiple code cells - starting');

        const cell1 = nbDocument.cellAt(0);
        const cell2 = nbDocument.cellAt(1);

        await kernelExecution.executeCell(cell1);
        await waitForCondition(
            async () => cell1.executionSummary?.success === true,
            30_000,
            'First cell execution did not complete'
        );

        await kernelExecution.executeCell(cell2);
        await waitForCondition(
            async () => cell2.executionSummary?.success === true,
            30_000,
            'Second cell execution did not complete'
        );

        assert.isTrue(cell2.executionSummary?.success, 'Second cell should execute successfully');
        assert.isAtLeast(cell2.outputs.length, 1, 'Second cell should have output');

        const outputText = new TextDecoder().decode(cell2.outputs[0].items[0].data).toString();
        assert.include(outputText, '42', 'Output should contain the value 42');

        logger.debug('Test: Execute multiple code cells - completed');
    });

    test('Init notebook executes automatically', async function () {
        logger.debug('Test: Init notebook execution - starting');

        const notebookManager = api.serviceContainer.get<IDeepnoteNotebookManager>(IDeepnoteNotebookManager);

        await waitForCondition(
            async () => notebookManager.hasInitNotebookBeenRun('test-project-id'),
            60_000,
            'Init notebook did not execute within timeout'
        );

        assert.isTrue(
            notebookManager.hasInitNotebookBeenRun('test-project-id'),
            'Init notebook should have been marked as run'
        );

        const cell = nbDocument.cellAt(0);
        await kernelExecution.executeCell(cell);
        await waitForCondition(
            async () => cell.executionSummary?.success === true,
            30_000,
            'Cell execution did not complete'
        );

        logger.debug('Test: Init notebook execution - completed');
    });
});
