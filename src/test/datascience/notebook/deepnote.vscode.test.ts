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
    defaultNotebookTestTimeout,
    waitForExecutionCompletedSuccessfully,
    getCellOutputs,
    getDefaultKernelConnection
} from './helper.node';
import { logger } from '../../../platform/logging';
import { IKernel, IKernelProvider, INotebookKernelExecution } from '../../../kernels/types';
import { createKernelController, TestNotebookDocument } from './executionHelper';

/* eslint-disable @typescript-eslint/no-explicit-any, no-invalid-this */
suite('Deepnote Integration Tests @kernelCore', function () {
    let api: IExtensionTestApi;
    const disposables: IDisposable[] = [];
    const deepnoteFileUri = Uri.file(
        path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'src', 'test', 'datascience', 'notebook', 'test.deepnote')
    );
    this.timeout(120_000);
    let notebook: TestNotebookDocument;
    let kernel: IKernel;
    let kernelExecution: INotebookKernelExecution;

    suiteSetup(async function () {
        logger.info('Suite Setup Deepnote Integration Tests');
        this.timeout(120_000);
        try {
            api = await initialize();
            logger.debug('Before starting Jupyter');
            await startJupyterServer();
            logger.debug('After starting Jupyter');

            logger.debug('Opening .deepnote file');
            const nbDocument = await workspace.openNotebookDocument(deepnoteFileUri);
            logger.debug(`Opened .deepnote file with ${nbDocument.cellCount} cells`);

            notebook = new TestNotebookDocument(nbDocument.uri, 'deepnote' as any, nbDocument.metadata as any, false);

            await Promise.all(
                nbDocument.getCells().map(async (cell) => {
                    if (cell.kind === 1) {
                        return notebook.appendCodeCell(
                            cell.document.getText(),
                            cell.document.languageId,
                            cell.metadata
                        );
                    } else {
                        return notebook.appendMarkdownCell(cell.document.getText(), cell.metadata);
                    }
                })
            );

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
            logger.error('Suite Setup (failed) - Deepnote Integration Tests', e);
            await captureScreenShot('deepnote-integration-suite');
            throw e;
        }
    });

    setup(function () {
        logger.info(`Start Test ${this.currentTest?.title}`);
    });

    teardown(async function () {
        if (this.currentTest?.isFailed()) {
            await captureScreenShot(this);
        }
        logger.info(`Ended Test ${this.currentTest?.title}`);
    });

    suiteTeardown(() => closeNotebooksAndCleanUpAfterTests(disposables));

    test('Load .deepnote file', async () => {
        const nbDocument = await workspace.openNotebookDocument(deepnoteFileUri);
        assert.equal(nbDocument.notebookType, 'deepnote');
        assert.isAtLeast(nbDocument.cellCount, 1, 'Should have at least one cell');
    });

    test('Kernel starts for .deepnote file', async () => {
        assert.isOk(kernel, 'Kernel should be created');
        assert.isOk(kernel.session, 'Kernel session should exist');
    });

    test('Execute code block with output validation', async function () {
        this.timeout(defaultNotebookTestTimeout);

        const cell = notebook.cells.find((c) => c.document.getText().includes('print("Hello World")'));
        assert.isOk(cell, 'Should find cell with print statement');

        await kernelExecution.executeCell(cell!);

        await waitForExecutionCompletedSuccessfully(cell!);

        assert.isTrue(cell!.executionSummary?.success, 'Cell execution should succeed');
        assert.isAtLeast(cell!.outputs.length, 0, 'Cell should have outputs');

        const output = getCellOutputs(cell!);
        assert.include(output, 'Hello World', 'Output should contain "Hello World"');
    });

    test('Execute multiple code blocks', async function () {
        this.timeout(defaultNotebookTestTimeout);

        const codeCells = notebook.cells.filter((c) => c.kind === 2); // Code cells
        assert.isAtLeast(codeCells.length, 1, 'Should have at least one code cell');

        const firstCell = codeCells[0];
        await kernelExecution.executeCell(firstCell);
        await waitForExecutionCompletedSuccessfully(firstCell);

        assert.isTrue(firstCell.executionSummary?.success, 'First cell execution should succeed');
        assert.isAtLeast(firstCell.executionSummary?.executionOrder || 0, 1, 'Should have execution order');
    });

    test('Verify cell execution order', async function () {
        this.timeout(defaultNotebookTestTimeout);

        const codeCells = notebook.cells.filter((c) => c.kind === 2 && c.document.getText().trim().length > 0);
        if (codeCells.length < 2) {
            this.skip();
        }

        const cell1 = codeCells[0];
        const cell2 = codeCells[1];

        await kernelExecution.executeCell(cell1);
        await waitForExecutionCompletedSuccessfully(cell1);

        await kernelExecution.executeCell(cell2);
        await waitForExecutionCompletedSuccessfully(cell2);

        const order1 = cell1.executionSummary?.executionOrder || 0;
        const order2 = cell2.executionSummary?.executionOrder || 0;

        assert.isAtLeast(order1, 1, 'First cell should have execution order');
        assert.isAtLeast(order2, order1 + 1, 'Second cell should have higher execution order');
    });
});
