/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
import { assert } from 'chai';
import { Uri, workspace } from 'vscode';
import { IDisposable } from '../../../platform/common/types';
import { captureScreenShot, IExtensionTestApi } from '../../common.node';
import { EXTENSION_ROOT_DIR_FOR_TESTS, initialize } from '../../initialize.node';
import { closeNotebooksAndCleanUpAfterTests } from './helper.node';
import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager } from '../../../notebooks/types';

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
    this.timeout(240_000);

    suiteSetup(async function () {
        logger.info('Suite Setup VS Code Notebook - Deepnote Integration');
        this.timeout(240_000);
        try {
            api = await initialize();
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

        const notebookManager = api.serviceContainer.get<IDeepnoteNotebookManager>(IDeepnoteNotebookManager);
        assert.isOk(notebookManager, 'Notebook manager should be available');

        notebookManager.selectNotebookForProject('test-project-id', 'main-notebook-id');

        const nbDocument = await workspace.openNotebookDocument(deepnoteFilePath);

        logger.debug(`Opened notebook with type: ${nbDocument.notebookType}, cells: ${nbDocument.cellCount}`);

        assert.equal(nbDocument.notebookType, 'deepnote', 'Notebook type should be deepnote');
        assert.equal(nbDocument.cellCount, 3, 'Notebook should have 3 cells');

        assert.equal(nbDocument.metadata?.deepnoteProjectId, 'test-project-id', 'Project ID should match');
        assert.equal(nbDocument.metadata?.deepnoteNotebookId, 'main-notebook-id', 'Notebook ID should match');

        logger.debug('Test: Load .deepnote file - completed');
    });

    test('Extension services are available', async function () {
        logger.debug('Test: Extension services are available - starting');

        const notebookManager = api.serviceContainer.get<IDeepnoteNotebookManager>(IDeepnoteNotebookManager);
        assert.isOk(notebookManager, 'Notebook manager should be available');

        logger.debug('Test: Extension services are available - completed');
    });
});
