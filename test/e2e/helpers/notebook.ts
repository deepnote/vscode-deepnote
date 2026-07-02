import { By, EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import { OUTPUT_FRAME_SWITCH_TIMEOUT, OUTPUT_POLL_INTERVAL, OUTPUT_SELECTOR, WORKBENCH_TIMEOUT } from './constants';
import { dismissAllNotifications } from './notifications';

/**
 * Focuses the notebook editor and clicks its toolbar "Run All" button. The command-palette entry is
 * gated behind context keys not reliably set under automation, so driving it via executeCommand can
 * silently trigger the wrong command.
 */
export async function clickRunAll(notebookFileName: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    await new EditorView().openEditor(notebookFileName);

    // Locate AND click in the same wait loop: the toolbar can re-render between find and click
    // (StaleElementReferenceError). Still a single run — it's only issued once the click lands.
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
 * Reads the notebook cell output once, returning '' when no output is present yet. Output lives two
 * iframes deep and we read output-specific elements inside the frame, so we never match the cell's
 * source code visible in the editor.
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

        // Fallback for unexpected renderer classes: read the frame body (we're inside the output iframe).
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
 * Issues a SINGLE "Run All" (kernel already bound) and polls until the expected text renders. It
 * deliberately never re-issues "Run All": a first run that renders nothing means a dropped execution
 * request — exactly the kernel-binding regression this suite must catch, which re-running would mask.
 */
export async function runOnceAndAwaitOutput(
    notebookFileName: string,
    expected: string,
    timeout: number
): Promise<string> {
    const driver = VSBrowser.instance.driver;

    // Clear toasts so they cannot intercept the single toolbar click.
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
