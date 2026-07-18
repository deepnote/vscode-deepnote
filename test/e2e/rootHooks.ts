import { dismissAllNotifications } from './helpers/notifications';

// Mocha root hooks (wired via .mocharc.js `require`). ExTester runs every spec in ONE shared VS Code
// instance; dismiss notification toasts between tests so they don't pile up and slow/overlap later specs.
export const mochaHooks = {
    async afterEach(): Promise<void> {
        await dismissAllNotifications().catch(() => undefined);
    }
};
