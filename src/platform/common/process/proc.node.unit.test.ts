import { assert } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import { CancellationTokenSource } from 'vscode';

import * as path from '../../vscode-path/path';
import { ProcessService } from './proc.node';

/**
 * Cancelling must reap the whole subprocess tree, not just the process we spawned.
 * `python -m venv` runs ensurepip in a subprocess, and pip shells out to build backends;
 * a survivor keeps writing into the venv that the retry is busy deleting.
 */
suite('ProcessService - cancellation kills descendants', () => {
    const TEST_TIMEOUT_MS = 15_000;
    const POLL_TIMEOUT_MS = 10_000;
    const POLL_INTERVAL_MS = 20;

    let service: ProcessService;
    let cts: CancellationTokenSource;
    let pidFile: string;

    // Spawns a grandchild that outlives its parent, and records its pid so the test can watch it.
    function parentScript(): string {
        return [
            `const cp = require('child_process');`,
            `const child = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });`,
            `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
            `setTimeout(() => {}, 60000);`
        ].join('\n');
    }

    async function poll(condition: () => boolean, description: string): Promise<void> {
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (condition()) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        assert.fail(`Timed out waiting for ${description}`);
    }

    setup(() => {
        service = new ProcessService();
        cts = new CancellationTokenSource();
        pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proc-cancel-')), 'grandchild.pid');
    });

    teardown(() => {
        if (fs.existsSync(pidFile)) {
            ProcessService.kill(Number(fs.readFileSync(pidFile, 'utf8')));
            fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
        }
        cts.dispose();
        service.dispose();
    });

    test('cancelling a detached exec kills the grandchild too', async function () {
        this.timeout(TEST_TIMEOUT_MS);

        const execution = service.exec(process.execPath, ['-e', parentScript()], {
            token: cts.token,
            detached: true
        });

        await poll(() => fs.existsSync(pidFile), 'the grandchild to report its pid');
        const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
        assert.isTrue(ProcessService.isAlive(grandchildPid), 'grandchild should be running before cancellation');

        cts.cancel();
        await execution;

        await poll(() => !ProcessService.isAlive(grandchildPid), 'the grandchild to be killed');
    });

    test('exec still resolves with the output captured before cancellation', async function () {
        this.timeout(TEST_TIMEOUT_MS);

        const execution = service.exec(process.execPath, ['-e', `console.log('before'); ${parentScript()}`], {
            token: cts.token,
            detached: true
        });

        await poll(() => fs.existsSync(pidFile), 'the grandchild to report its pid');
        cts.cancel();

        const result = await execution;
        assert.strictEqual(result.stdout.trim(), 'before');
    });
});
