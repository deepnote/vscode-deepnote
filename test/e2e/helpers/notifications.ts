import { Notification, VSBrowser, Workbench } from 'vscode-extension-tester';

/** Dismisses every currently-visible toast notification (best effort). */
export async function dismissAllNotifications(): Promise<void> {
    const notifications = await new Workbench().getNotifications().catch((error) => {
        console.warn('[deepnote-e2e] get notifications:', error);

        return [] as Notification[];
    });
    for (const notification of notifications) {
        await notification.dismiss().catch((error) => {
            console.warn('[deepnote-e2e] dismiss notification:', error);
        });
    }
}

/**
 * Waits for a toast notification whose message matches `pattern`. When `required` is false a missed
 * (or auto-dismissed) notification resolves to `undefined` instead of throwing — useful for
 * transient success toasts where the authoritative gate is elsewhere.
 */
export async function waitForNotification(
    pattern: RegExp,
    timeout: number,
    required: boolean
): Promise<Notification | undefined> {
    const driver = VSBrowser.instance.driver;

    try {
        return (await driver.wait(
            async () => {
                const notifications = await new Workbench().getNotifications().catch((error) => {
                    console.warn('[deepnote-e2e] get notifications:', error);

                    return [] as Notification[];
                });
                for (const notification of notifications) {
                    const message = await notification.getMessage().catch((error) => {
                        console.warn('[deepnote-e2e] read notification message:', error);

                        return '';
                    });
                    if (pattern.test(message)) {
                        return notification;
                    }
                }

                return undefined;
            },
            timeout,
            `timed out waiting for a notification matching ${pattern}`
        )) as Notification;
    } catch (error) {
        if (required) {
            throw error;
        }

        console.warn(`[deepnote-e2e] wait for optional notification matching ${pattern}:`, error);

        return undefined;
    }
}

/**
 * Waits until no visible notification matches `pattern` any more. A progress notification is
 * removed when its operation settles, so this gates on "that work finished" rather than on a
 * fixed sleep.
 */
export async function waitForNotificationToClear(pattern: RegExp, timeout: number): Promise<void> {
    await VSBrowser.instance.driver.wait(
        async () => {
            const notifications = await new Workbench().getNotifications().catch((error) => {
                console.warn('[deepnote-e2e] get notifications:', error);

                return [] as Notification[];
            });
            for (const notification of notifications) {
                const message = await notification.getMessage().catch(() => '');
                if (pattern.test(message)) {
                    return false;
                }
            }

            return true;
        },
        timeout,
        `timed out waiting for notifications matching ${pattern} to clear`
    );
}
