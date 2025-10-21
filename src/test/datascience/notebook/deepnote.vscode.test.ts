// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
import { assert } from 'chai';
import * as path from '../../../platform/vscode-path/path';
import { Uri, workspace } from 'vscode';
import { IDisposable } from '../../../platform/common/types';
import { captureScreenShot, IExtensionTestApi } from '../../common.node';
import { EXTENSION_ROOT_DIR_FOR_TESTS, initialize } from '../../initialize.node';
import {
    closeNotebooksAndCleanUpAfterTests,
    startJupyterServer,
    waitForExecutionCompletedSuccessfully,
    getCellOutputs,
    getDefaultKernelConnection
} from './helper.node';
import { IKernel, IKernelProvider, INotebookKernelExecution } from '../../../kernels/types';
import { createKernelController, TestNotebookDocument } from './executionHelper';
import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager } from '../../../notebooks/types';

/* eslint-disable @typescript-eslint/no-explicit-any, no-invalid-this */
suite('Deepnote Integration Tests @kernelCore', function () {
    let api: IExtensionTestApi;
    const disposables: IDisposable[] = [];
    const deepnoteFilePath = Uri.file(
        path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'src', 'test', 'datascience', 'notebook', 'test.deepnote')
    );
    this.timeout(120_000);
    let notebook: TestNotebookDocument;
    let kernel: IKernel;
    let kernelExecution: INotebookKernelExecution;

    suiteSetup(async function () {
        logger.info('Suite Setup VS Code Notebook - Deepnote Integration');
        this.timeout(120_000);
        try {
            api = await initialize();
            logger.debug('Before starting Jupyter');
            await startJupyterServer();
            logger.debug('After starting Jupyter');

            notebook = new TestNotebookDocument(deepnoteFilePath);

            const kernelProvider = api.serviceContainer.get<IKernelProvider>(IKernelProvider);
            logger.debug('Before creating kernel connection');
            const metadata = await getDefaultKernelConnection();
            logger.debug('After creating kernel connection');

            const controller = createKernelController();
            kernel = kernelProvider.getOrCreate(notebook, { metadata, resourceUri: notebook.uri, controller });
            logger.debug('Before starting kernel');
            await kernel.start();
            logger.debug('After starting kernel');
            kernelExecution = kernelProvider.getKernelExecution(kernel);
            logger.info('Suite Setup (completed)');
        } catch (e) {
            logger.error('Suite Setup (failed) - Deepnote Integration', e);
            await captureScreenShot('deepnote-suite');
            throw e;
        }
    });

    setup(function () {
        notebook.cells.length = 0;
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

        const notebookManager = api.serviceContainer.get<IDeepnoteNotebookManager>(IDeepnoteNotebookManager);

        notebookManager.selectNotebookForProject('test-project-id', 'main-notebook-id');

        const nbDocument = await workspace.openNotebookDocument(deepnoteFilePath);

        logger.debug(`Opened notebook with type: ${nbDocument.notebookType}, cells: ${nbDocument.cellCount}`);

        assert.equal(nbDocument.notebookType, 'deepnote', 'Notebook type should be deepnote');
        assert.isTrue(nbDocument.cellCount > 0, 'Notebook should have cells');

        assert.equal(nbDocument.metadata?.deepnoteProjectId, 'test-project-id', 'Project ID should match');
        assert.equal(nbDocument.metadata?.deepnoteNotebookId, 'main-notebook-id', 'Notebook ID should match');

        logger.debug('Test: Load .deepnote file - completed');
    });

    test('Kernel starts for .deepnote file', async function () {
        logger.debug('Test: Kernel starts for .deepnote file - starting');

        assert.isOk(kernel, 'Kernel should exist');
        assert.isOk(kernel.session, 'Kernel session should exist');

        logger.debug('Test: Kernel starts for .deepnote file - completed');
    });

    test('Execute code block', async function () {
        logger.debug('Test: Execute code block - starting');

        const cell = await notebook.appendCodeCell('print("Hello World")');

        await Promise.all([kernelExecution.executeCell(cell), waitForExecutionCompletedSuccessfully(cell)]);

        assert.isAtLeast(cell.executionSummary?.executionOrder || 0, 1, 'Cell should have execution order');
        assert.isTrue(cell.executionSummary?.success, 'Cell execution should succeed');
        assert.isAtLeast(cell.outputs.length, 1, 'Cell should have output');

        const output = getCellOutputs(cell);
        assert.include(output, 'Hello World', 'Output should contain "Hello World"');

        logger.debug('Test: Execute code block - completed');
    });

    test('Execute multiple code blocks', async function () {
        logger.debug('Test: Execute multiple code blocks - starting');

        const cell1 = await notebook.appendCodeCell('x = 42');
        const cell2 = await notebook.appendCodeCell('print(f"The answer is {x}")');

        await Promise.all([
            kernelExecution.executeCell(cell1),
            waitForExecutionCompletedSuccessfully(cell1),
            kernelExecution.executeCell(cell2),
            waitForExecutionCompletedSuccessfully(cell2)
        ]);

        assert.isAtLeast(cell1.executionSummary?.executionOrder || 0, 1, 'First cell should have execution order');
        assert.isTrue(cell1.executionSummary?.success, 'First cell execution should succeed');

        assert.isAtLeast(cell2.executionSummary?.executionOrder || 0, 1, 'Second cell should have execution order');
        assert.isTrue(cell2.executionSummary?.success, 'Second cell execution should succeed');
        assert.isAtLeast(cell2.outputs.length, 1, 'Second cell should have output');

        const output = getCellOutputs(cell2);
        assert.include(output, 'The answer is 42', 'Output should contain "The answer is 42"');

        logger.debug('Test: Execute multiple code blocks - completed');
    });

    test('Verify cell output validation', async function () {
        logger.debug('Test: Verify cell output validation - starting');

        const cell = await notebook.appendCodeCell('for i in range(3):\n    print(f"Line {i}")');

        await Promise.all([kernelExecution.executeCell(cell), waitForExecutionCompletedSuccessfully(cell)]);

        assert.isTrue(cell.executionSummary?.success, 'Cell execution should succeed');
        assert.isAtLeast(cell.outputs.length, 1, 'Cell should have output');

        const output = getCellOutputs(cell);
        assert.include(output, 'Line 0', 'Output should contain "Line 0"');
        assert.include(output, 'Line 1', 'Output should contain "Line 1"');
        assert.include(output, 'Line 2', 'Output should contain "Line 2"');

        logger.debug('Test: Verify cell output validation - completed');
    });
});
