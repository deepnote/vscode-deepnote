/**
 * E2E (ExTester): a `visualization` block executes as `_dntk.DeepnoteChart(...)`, returns
 * `application/vnd.vega.v5+json`, and is drawn by the `deepnote-vega-renderer`. The fixture charts a
 * `uuid.UUID` column because Arrow maps those to an extension type VegaFusion cannot serialize.
 */

import { expect } from 'chai';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    awaitRenderedChart,
    copyFixtureToTempDir,
    createEnvironment,
    openFolderViaDialog,
    openWorkspaceFile,
    runOnceAndAwaitOutput,
    selectEnvironmentForNotebook
} from '../../helpers';

const NOTEBOOK_FILE_NAME = 'chart-uuid.deepnote';
const DATA_CELL_OUTPUT = 'chart data ready';

const FORBIDDEN_OUTPUT = [
    'Unsupported datatype for JSON serialization',
    'Error rendering chart',
    'Traceback (most recent call last)'
];

describe('Deepnote E2E — render a chart block', function () {
    this.timeout(SUITE_TIMEOUT);

    const environmentName = 'E2E Chart Env';

    let cleanupTempDir: (() => void) | undefined;

    before(async function () {
        const { cleanup, tempDir } = copyFixtureToTempDir(NOTEBOOK_FILE_NAME);
        cleanupTempDir = cleanup;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openWorkspaceFile(NOTEBOOK_FILE_NAME);

        await VSBrowser.instance.driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(NOTEBOOK_FILE_NAME)),
            WORKBENCH_TIMEOUT,
            'Deepnote notebook editor did not open'
        );
    });

    after(async function () {
        await new WebView().switchBack().catch((error) => {
            console.warn('[deepnote-e2e] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[deepnote-e2e] close all editors during cleanup:', error);
        });

        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[deepnote-e2e] remove throwaway workspace dir during cleanup:', error);
        }
    });

    it('charts a dataframe with a UUID column without a serialization error', async function () {
        await createEnvironment(environmentName);
        await selectEnvironmentForNotebook(environmentName, NOTEBOOK_FILE_NAME);

        const renderedOutput = await runOnceAndAwaitOutput(
            NOTEBOOK_FILE_NAME,
            DATA_CELL_OUTPUT,
            FIRST_RUN_OUTPUT_TIMEOUT
        );

        // Carries the full output because chai's own failure message truncates it.
        const failureText = FORBIDDEN_OUTPUT.filter((forbidden) => renderedOutput.includes(forbidden));
        expect(
            failureText,
            `chart output contained failure text. Full output: ${JSON.stringify(renderedOutput)}`
        ).to.deep.equal([]);

        await awaitRenderedChart(FIRST_RUN_OUTPUT_TIMEOUT, 'chart block output');
    });
});
