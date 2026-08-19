import { By, EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import { OUTPUT_FRAME_SWITCH_TIMEOUT, OUTPUT_POLL_INTERVAL, OUTPUT_SELECTOR, WORKBENCH_TIMEOUT } from './constants';
import { dismissAllNotifications } from './notifications';

/**
 * Focuses the given notebook editor and clicks its toolbar "Run All" button. The command-palette
 * entry for `deepnote.runallcells` ("Jupyter: Run All Cells") is gated behind context keys
 * (`deepnote.ispythonornativeactive`, …) that are not reliably set under automation, so driving it
 * through `Workbench.executeCommand` can silently miss and trigger the wrong command.
 */
export async function clickRunAll(notebookFileName: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    await new EditorView().openEditor(notebookFileName);

    // Locate AND click inside the same wait loop. The notebook toolbar can re-render between finding
    // the button and clicking it (the editor re-focuses, kernel status / notifications change), which
    // would otherwise surface as a StaleElementReferenceError. Re-finding and clicking on the next
    // tick is still a SINGLE "Run All" — the run is only issued once the click actually lands, so
    // this does not re-run a notebook whose first execution was accepted.
    await driver.wait(
        async () => {
            try {
                const [button] = await driver.findElements(By.css('a.action-label[aria-label="Run All"]'));
                if (!button) {
                    return false;
                }

                await button.click();

                return true;
            } catch (error) {
                console.warn('[deepnote-e2e] locate/click notebook Run All (retrying):', error);

                return false;
            }
        },
        WORKBENCH_TIMEOUT,
        'notebook "Run All" button did not appear or could not be clicked'
    );
}

/**
 * Reads the notebook cell output once.
 *
 * Output lives two iframes deep (iframe.webview.ready -> #active-frame). We only attempt to switch
 * when an output webview iframe actually exists (`getViewToSwitchTo`), and we read output-specific
 * elements inside the frame — so we never match the cell's source code that is visible in the editor
 * of the main document. Returns '' when no output is present yet.
 */
export async function readRenderedOutput(): Promise<string> {
    const webView = new WebView();
    const outputFrame = await webView.getViewToSwitchTo().catch((error) => {
        console.warn('[deepnote-e2e] locate notebook output webview:', error);

        return undefined;
    });
    if (!outputFrame) {
        return '';
    }

    let text = '';
    try {
        await webView.switchToFrame(OUTPUT_FRAME_SWITCH_TIMEOUT);
        const elements = await webView.findWebElements(By.css(OUTPUT_SELECTOR));
        const texts = await Promise.all(
            elements.map((element) =>
                element.getText().catch((error) => {
                    console.warn('[deepnote-e2e] read output element text:', error);

                    return '';
                })
            )
        );
        text = texts.join('\n').trim();

        // Fallback: if the renderer used unexpected classes, read the frame body — safe here because
        // we have confirmed we are inside the output iframe, not the editor.
        if (!text) {
            const body = await webView.findWebElement(By.css('body')).catch((error) => {
                console.warn('[deepnote-e2e] read output frame body:', error);

                return undefined;
            });
            text = body
                ? (
                      await body.getText().catch((error) => {
                          console.warn('[deepnote-e2e] read output frame body text:', error);

                          return '';
                      })
                  ).trim()
                : '';
        }
    } catch (error) {
        // Frame went stale or output not painted yet — treat as no output this tick.
        console.warn('[deepnote-e2e] read rendered notebook output:', error);
    } finally {
        await webView.switchBack().catch((error) => {
            console.warn('[deepnote-e2e] switch back from notebook output webview:', error);
        });
    }

    return text;
}

/**
 * Issues a SINGLE "Run All" after the kernel has been selected and polls the notebook output webview
 * until the expected text renders. It deliberately does NOT re-issue "Run All" when output is
 * missing: the kernel is already bound before we get here (`selectEnvironmentForNotebook` waits for
 * the post-binding "switched successfully" toast), so a first run that renders nothing means the
 * execution request was dropped — exactly the kernel-binding regression this suite must catch.
 * Re-running until output eventually appeared would mask that bug.
 */
export async function runOnceAndAwaitOutput(
    notebookFileName: string,
    expected: string,
    timeout: number
): Promise<string> {
    const driver = VSBrowser.instance.driver;

    // Clear the "switched successfully" toast so it cannot intercept the single toolbar click.
    await dismissAllNotifications().catch((error) => {
        console.warn('[deepnote-e2e] dismiss notifications before Run All:', error);
    });

    await clickRunAll(notebookFileName);

    const deadline = Date.now() + timeout;
    let lastText = '';

    while (Date.now() < deadline) {
        lastText = await readRenderedOutput();
        if (lastText.includes(expected)) {
            return lastText;
        }

        await driver.sleep(OUTPUT_POLL_INTERVAL);
    }

    throw new Error(
        `Timed out after ${timeout}ms waiting for the first "Run All" to render output containing ` +
            `"${expected}". No re-run was issued, so a dropped first execution (kernel not bound to a ` +
            `NotebookEditor) surfaces here. Last observed output: ${JSON.stringify(lastText)}`
    );
}
