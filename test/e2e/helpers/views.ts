import { ActivityBar, VSBrowser } from 'vscode-extension-tester';

const VIEW_OPEN_SETTLE_DELAY = 1_500;

/** Opens a named activity-bar view (best effort — only for a nicer screenshot). */
export async function showView(title: string, logPrefix = '[e2e]'): Promise<void> {
    try {
        const control = await new ActivityBar().getViewControl(title);
        await control?.openView();
        await VSBrowser.instance.driver.sleep(VIEW_OPEN_SETTLE_DELAY);
    } catch (error) {
        console.warn(`${logPrefix} could not open "${title}" view:`, error);
    }
}
