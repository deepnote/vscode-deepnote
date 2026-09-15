/**
 * ExTester E2E for SQL query chaining: a `.deepnote` with two DuckDB (DataFrame SQL) blocks where the second
 * selects from the first block's variable. The test flips the first block to "Query preview" through the
 * new cell status bar item, runs both blocks and asserts the chained block renders its result.
 *
 * The count is the tell: a query preview only materializes 100 rows, so `chained_rows_1234` can only render
 * when the toolkit inlined the first block's full query as a CTE instead of reading the preview DataFrame.
 */

import { expect } from 'chai';
import { EditorView, InputBox, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    QUICK_PICK_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    awaitCellStatusBarItems,
    clickCellStatusBarItem,
    copyFixtureToTempDir,
    createEnvironment,
    openFolderViaDialog,
    openWorkspaceFile,
    runOnceAndAwaitOutput,
    selectEnvironmentForNotebook
} from '../../helpers';

const NOTEBOOK_FILE_NAME = 'sql-query-chaining.deepnote';

// Status bar texts from `SqlReturnVariableType` in `src/platform/common/utils/localize.ts`.
const DATAFRAME_STATUS_BAR_TEXT = 'Return: DataFrame';
const QUERY_PREVIEW_STATUS_BAR_TEXT = 'Return: Query preview';
const QUERY_PREVIEW_PICK_LABEL = 'Query preview';

// `SELECT 'chained_rows_' || COUNT(*) ... FROM source_rows` over the 1234-row source query in the fixture.
const EXPECTED_OUTPUT = 'chained_rows_1234';

describe('Deepnote E2E — chain SQL blocks through a query preview', function () {
    this.timeout(SUITE_TIMEOUT);

    const environmentName = 'E2E SQL Chaining Env';

    let cleanupTempDir: (() => void) | undefined;

    before(async function () {
        // Work on a throwaway copy so execution-dirtied notebook state never touches the source tree.
        const { cleanup, tempDir } = copyFixtureToTempDir(NOTEBOOK_FILE_NAME);
        cleanupTempDir = cleanup;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the folder as the workspace FIRST (the serializer's snapshot read blocks headlessly without one).
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openWorkspaceFile(NOTEBOOK_FILE_NAME);

        // A single-notebook file resolves to its default notebook.
        await VSBrowser.instance.driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(NOTEBOOK_FILE_NAME)),
            WORKBENCH_TIMEOUT,
            'Deepnote notebook editor did not open'
        );
    });

    after(async function () {
        // Defensive cleanup: never leave the driver stuck inside a webview frame, and close tabs.
        await new WebView().switchBack().catch((error) => {
            console.warn('[deepnote-e2e] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[deepnote-e2e] close all editors during cleanup:', error);
        });

        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[deepnote-e2e] remove temp workspace dir during cleanup:', error);
        }
    });

    it('switches the first block to Query preview from the status bar, then the second block queries it', async function () {
        // Both SQL blocks start as DataFrame; the status bar renders one item per block.
        await awaitCellStatusBarItems(DATAFRAME_STATUS_BAR_TEXT, 2, WORKBENCH_TIMEOUT);

        // The status bar item on the FIRST block opens the return type picker.
        await clickCellStatusBarItem(DATAFRAME_STATUS_BAR_TEXT, 0);
        const picker = await InputBox.create(QUICK_PICK_TIMEOUT);
        await picker.selectQuickPick(QUERY_PREVIEW_PICK_LABEL);

        // The metadata edit re-renders the item; the second block keeps its DataFrame item.
        await awaitCellStatusBarItems(QUERY_PREVIEW_STATUS_BAR_TEXT, 1, WORKBENCH_TIMEOUT);
        await awaitCellStatusBarItems(DATAFRAME_STATUS_BAR_TEXT, 1, WORKBENCH_TIMEOUT);

        await createEnvironment(environmentName);
        await selectEnvironmentForNotebook(environmentName, NOTEBOOK_FILE_NAME);

        // "Run All" executes the preview block first, then the block that chains onto its variable.
        const renderedOutput = await runOnceAndAwaitOutput(
            NOTEBOOK_FILE_NAME,
            EXPECTED_OUTPUT,
            FIRST_RUN_OUTPUT_TIMEOUT
        );
        expect(renderedOutput).to.contain(EXPECTED_OUTPUT);
    });
});
