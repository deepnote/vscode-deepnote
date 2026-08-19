/**
 * E2E (ExTester): a legacy project-scoped snapshot (filename has no notebook-id segment) still loads
 * its saved output when the notebook is opened. Output comes from the snapshot sidecar, not execution.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';
import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    SHARED_ENV_NAME,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createEnvironment,
    createScreenshotter,
    openFolderViaDialog,
    openWorkspaceFile,
    readRenderedOutput,
    runOnceAndAwaitOutput,
    selectEnvironmentForNotebook,
    waitForNotification
} from '../helpers';

const FIXTURE = 'legacy-snapshot-demo.deepnote';
const SNAPSHOT = 'legacy-snapshot-demo_ffffffff-ffff-4fff-8fff-ffffffffffff_latest.snapshot.deepnote';
const MARKER = 'SNAPSHOT_OUTPUT_MARKER';
const SPLIT_PROMPT = /multiple notebooks/i;
const OUTPUT_TIMEOUT = 30_000;

describe('Deepnote — a legacy project-scoped snapshot still loads its saved output', function () {
    this.timeout(SUITE_TIMEOUT);
    let cleanupTempDir: (() => void) | undefined;
    let renderedOutput = '';
    let splitPrompted = false;

    before(async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);
        const copy = copyFixtureToTempDir(FIXTURE);
        cleanupTempDir = copy.cleanup;
        const snapshotsDir = path.join(copy.tempDir, 'snapshots');
        fs.mkdirSync(snapshotsDir, { recursive: true });
        fs.copyFileSync(
            path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', 'snapshots', SNAPSHOT),
            path.join(snapshotsDir, SNAPSHOT)
        );

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openWorkspaceFile(FIXTURE);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(FIXTURE)),
            WORKBENCH_TIMEOUT,
            `${FIXTURE} did not open`
        );

        const prompt = await waitForNotification(SPLIT_PROMPT, 6000, false);
        splitPrompted = prompt !== undefined;

        const deadline = Date.now() + OUTPUT_TIMEOUT;
        while (Date.now() < deadline) {
            renderedOutput = await readRenderedOutput();
            if (renderedOutput.includes(MARKER)) break;
            await driver.sleep(1000);
        }
        await screenshot('snapshot-output');
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
        try {
            cleanupTempDir?.();
        } catch (e) {
            console.warn('[snapshots] cleanup:', e);
        }
    });

    it('renders the saved output from the legacy snapshot', function () {
        expect(renderedOutput, 'legacy snapshot output').to.contain(MARKER);
    });

    it('does not prompt to split (single-notebook file)', function () {
        expect(splitPrompted, 'must not raise the split prompt').to.equal(false);
    });
});

describe('Deepnote — new snapshots are notebook-scoped and do not bleed between siblings', function () {
    this.timeout(SUITE_TIMEOUT);

    const ENV_NAME = SHARED_ENV_NAME;
    const SIBLINGS = [
        { file: 'marketing-overview.deepnote', output: 'overview', notebookId: 'e-nb-overview' },
        { file: 'marketing-campaigns.deepnote', output: 'campaigns', notebookId: 'e-nb-campaigns' }
    ];

    let cleanupTempDir: (() => void) | undefined;
    let tempDir = '';
    let snapshotFiles: string[] = [];
    let overviewSnapshotContent = '';
    let campaignsSnapshotContent = '';

    before(async function () {
        const driver = VSBrowser.instance.driver;
        const copy = copyFixtureToTempDir(SIBLINGS[0].file);
        cleanupTempDir = copy.cleanup;
        tempDir = copy.tempDir;
        fs.copyFileSync(
            path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', SIBLINGS[1].file),
            path.join(tempDir, SIBLINGS[1].file)
        );

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await createEnvironment(ENV_NAME);

        for (const sib of SIBLINGS) {
            // Keep exactly ONE editor open: "Run All" is located via `findElements(...)[0]` (first
            // toolbar in DOM order), so a lingering prior editor's button would be picked and hang the run.
            await new EditorView().closeAllEditors().catch((error) => {
                console.warn('[snapshots-i2] close editors before opening sibling:', error);
            });

            await openWorkspaceFile(sib.file);
            await driver.wait(
                async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(sib.file)),
                WORKBENCH_TIMEOUT,
                `${sib.file} did not open`
            );
            await selectEnvironmentForNotebook(ENV_NAME, sib.file);
            await runOnceAndAwaitOutput(sib.file, sib.output, FIRST_RUN_OUTPUT_TIMEOUT);
        }

        const snapshotsDir = path.join(tempDir, 'snapshots');
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            snapshotFiles = fs.existsSync(snapshotsDir)
                ? fs.readdirSync(snapshotsDir).filter((f) => f.endsWith('.snapshot.deepnote'))
                : [];
            if (
                snapshotFiles.some((f) => f.includes('_e-nb-overview_')) &&
                snapshotFiles.some((f) => f.includes('_e-nb-campaigns_'))
            ) {
                break;
            }
            await driver.sleep(1500);
        }
        console.log('[I2] snapshotFiles=', JSON.stringify(snapshotFiles));

        // Filenames only prove per-notebook scoping of the files; read contents to assert no
        // cross-contamination. Prefer a `_latest` file for a notebook id, else any file with that segment.
        const pickSnapshot = (notebookId: string): string | undefined => {
            const segment = `_${notebookId}_`;
            const matches = snapshotFiles.filter((f) => f.includes(segment));

            return matches.find((f) => f.includes('_latest')) ?? matches[0];
        };
        const readSnapshot = (notebookId: string): string => {
            const file = pickSnapshot(notebookId);

            return file ? fs.readFileSync(path.join(snapshotsDir, file), 'utf8') : '';
        };

        overviewSnapshotContent = readSnapshot('e-nb-overview');
        campaignsSnapshotContent = readSnapshot('e-nb-campaigns');
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
        try {
            cleanupTempDir?.();
        } catch (e) {
            console.warn('[snapshots-i2] cleanup:', e);
        }
    });

    it('writes a notebook-scoped snapshot for the first sibling', function () {
        expect(
            snapshotFiles.some((f) => f.includes('_e-nb-overview_')),
            `overview snapshot in ${JSON.stringify(snapshotFiles)}`
        ).to.equal(true);
    });

    it('writes a separate notebook-scoped snapshot for the second sibling', function () {
        expect(
            snapshotFiles.some((f) => f.includes('_e-nb-campaigns_')),
            `campaigns snapshot in ${JSON.stringify(snapshotFiles)}`
        ).to.equal(true);
    });

    it('keeps the two siblings’ snapshots in distinct files', function () {
        const overview = snapshotFiles.filter((f) => f.includes('_e-nb-overview_'));
        const campaigns = snapshotFiles.filter((f) => f.includes('_e-nb-campaigns_'));
        expect(
            overview.length > 0 && campaigns.length > 0 && overview.every((f) => !campaigns.includes(f)),
            'distinct snapshot files per notebook'
        ).to.equal(true);
    });

    it('keeps each notebook-scoped snapshot holding only its own output', function () {
        // Each notebook's marker must appear in its own snapshot and NOT the sibling's; the
        // `not.contain` checks are what catch cross-contamination.
        expect(overviewSnapshotContent, 'overview snapshot must not be empty').to.not.equal('');
        expect(campaignsSnapshotContent, 'campaigns snapshot must not be empty').to.not.equal('');

        expect(overviewSnapshotContent, 'overview snapshot holds its own output').to.contain('overview');
        expect(overviewSnapshotContent, 'overview snapshot must not leak the sibling output').to.not.contain(
            'campaigns'
        );

        expect(campaignsSnapshotContent, 'campaigns snapshot holds its own output').to.contain('campaigns');
        expect(campaignsSnapshotContent, 'campaigns snapshot must not leak the sibling output').to.not.contain(
            'overview'
        );
    });
});
