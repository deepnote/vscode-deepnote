import { ActivityBar, VSBrowser } from 'vscode-extension-tester';

const VIEW_OPEN_SETTLE_DELAY = 1_500;
const VIEW_OPEN_TIMEOUT = 20_000;
const VIEW_OPEN_RETRY_DELAY = 500;

/**
 * Opens a named activity-bar view. ExTester's own `openView()` clicks the control and then waits a
 * hardcoded 2s for it to turn active, which a loaded workbench does not always manage; the click is
 * a no-op once the view is open, so the whole call is safe to retry.
 */
export async function openActivityBarView(title: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + VIEW_OPEN_TIMEOUT;
    let lastError: unknown;

    while (Date.now() < deadline) {
        try {
            const control = await new ActivityBar().getViewControl(title);
            await control?.openView();

            return;
        } catch (error) {
            lastError = error;
            await driver.sleep(VIEW_OPEN_RETRY_DELAY);
        }
    }

    throw new Error(`The "${title}" view did not open within ${VIEW_OPEN_TIMEOUT}ms: ${lastError}`);
}

/** Opens a named activity-bar view (best effort — only for a nicer screenshot). */
export async function showView(title: string, logPrefix = '[e2e]'): Promise<void> {
    try {
        await openActivityBarView(title);
        await VSBrowser.instance.driver.sleep(VIEW_OPEN_SETTLE_DELAY);
    } catch (error) {
        console.warn(`${logPrefix} could not open "${title}" view:`, error);
    }
}
