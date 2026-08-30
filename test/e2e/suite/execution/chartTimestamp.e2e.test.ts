/**
 * E2E (ExTester): a `visualization` block charting a string temporal column, the shape a CSV read
 * produces. VegaFusion parses such strings against a format list, which until deepnote-vegafusion
 * 2.1.1 accepted only exactly three fractional-second digits — pandas writes six.
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
    readChartAriaLabels,
    runOnceAndAwaitOutput,
    selectEnvironmentForNotebook
} from '../../helpers';

const NOTEBOOK_FILE_NAME = 'chart-timestamp.deepnote';
const DATA_CELL_OUTPUT = 'timeseries data ready';

// The first and last CSV rows, parsed. Vega captions the axis with its scale domain, formatted by
// the spec's own axis format.
const PARSED_DOMAIN = 'values from 2024-04-17T23:18:06 to 2024-04-19T14:45:59';

const FORBIDDEN_OUTPUT = [
    'Error parsing timestamp',
    'Error rendering chart',
    'Traceback (most recent call last)'
];

describe('Deepnote E2E — render a chart block with a string timestamp column', function () {
    this.timeout(SUITE_TIMEOUT);

    const environmentName = 'E2E Chart Timestamp Env';

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

    it('charts microsecond timestamp strings without a parse error', async function () {
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

        await awaitRenderedChart(FIRST_RUN_OUTPUT_TIMEOUT, 'timestamp chart block output');

        const ariaLabels = await readChartAriaLabels();
        expect(ariaLabels, `chart aria labels: ${ariaLabels}`).to.contain(PARSED_DOMAIN);
    });
});
