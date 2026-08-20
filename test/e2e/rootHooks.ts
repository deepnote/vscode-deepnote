import { VSBrowser } from 'vscode-extension-tester';

import { WORKBENCH_TIMEOUT } from './helpers/constants';
import { fixturesWorkspaceRoot, removeFixturesWorkspaceRoot } from './helpers/fixtures';
import { dismissAllNotifications } from './helpers/notifications';
import { openFolderViaDialog } from './helpers/workspace';

// Mocha root hooks (wired via .mocharc.js `require`). ExTester runs every spec in ONE shared VS Code
// instance, so this is also where the one shared workspace folder is opened: every suite's fixture
// copy is a directory inside it, and opening a folder reloads the workbench, so doing it once here
// instead of once per suite removes ~17 reloads from the run. Suites still call openFolderViaDialog;
// it short-circuits for anything already inside this root.
export const mochaHooks = {
    async afterEach(): Promise<void> {
        await dismissAllNotifications().catch(() => undefined);
    },

    async afterAll(): Promise<void> {
        removeFixturesWorkspaceRoot();
    },

    async beforeAll(): Promise<void> {
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(fixturesWorkspaceRoot());
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
    }
};
