/**
 * E2E (ExTester): `DeepnoteFileChangeWatcher` reloads an open notebook on external `.deepnote` edits.
 * It syncs cells (replaceCells), not metadata, so the observable is the rendered cell source. No kernel.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { EditorView, VSBrowser, WebView, Workbench } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    copySnapshotIntoDir,
    createScreenshotter,
    openFolderViaDialog,
    openWorkspaceFile,
    readRenderedOutput
} from '../../helpers';

const FIXTURE = 'hello-world.deepnote';
const ORIGINAL_SOURCE = 'hello world';
const RELOAD_MARKER = 'WATCHER_RELOAD_MARKER';

// The cell must first render its original source before we edit the file (negative-guard baseline).
const ORIGINAL_RENDER_TIMEOUT = 30_000;
// The watcher debounces 500ms, re-deserializes and applies the edit — allow ample slack for the reload.
const RELOAD_TIMEOUT = 20_000;
const OVERLAY_POLL_INTERVAL = 500;

describe('Deepnote — the file watcher reloads an open notebook when its .deepnote changes on disk', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let filePath = '';

    before(async function () {
        const driver = VSBrowser.instance.driver;

        // Work on a throwaway copy so the external edit never touches the committed fixture.
        const copy = copyFixtureToTempDir(FIXTURE);
        cleanupTempDir = copy.cleanup;
        filePath = copy.filePath;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the temp dir as workspace root first: the serializer reads snapshots relative to a
        // workspace folder, else deserialization blocks headlessly. Opening a folder reloads the window.
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openWorkspaceFile(FIXTURE);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(FIXTURE)),
            WORKBENCH_TIMEOUT,
            `${FIXTURE} did not open`
        );
    });

    after(async function () {
        await new WebView().switchBack().catch((error) => {
            console.warn('[file-watcher] switch back from webview during cleanup:', error);
        });
        // The reload can leave the editor dirty; revert first so closing needs no save dialog.
        await new Workbench().executeCommand('Revert File').catch(() => undefined);
        await VSBrowser.instance.driver.sleep(500);
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[file-watcher] close all editors during cleanup:', error);
        });
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[file-watcher] remove temp workspace dir during cleanup:', error);
        }
    });

    it('re-renders the cell source when the .deepnote is edited externally', async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);

        // Read cell source from the overlay: virtualized rows keep it out of innerText, so also gather
        // `.view-line`/`.code-cell-row` text and normalize Monaco's NBSP (U+00A0) so a plain space matches.
        const overlayText = async (): Promise<string> => {
            const raw = (await driver.executeScript(() => {
                const overlay = document.querySelector('.notebookOverlay') as HTMLElement | null;
                const parts = [overlay?.innerText ?? ''];
                overlay
                    ?.querySelectorAll('.code-cell-row, .view-line')
                    .forEach((el) => parts.push((el as HTMLElement).textContent ?? ''));

                return parts.join('\n');
            })) as string;

            return (raw ?? '').replace(/\u00A0/g, ' ');
        };

        // 1. Baseline: wait until the ORIGINAL cell source has rendered, then assert it (negative guard).
        let baselineText = '';
        const baselineDeadline = Date.now() + ORIGINAL_RENDER_TIMEOUT;
        while (Date.now() < baselineDeadline) {
            baselineText = (await overlayText().catch(() => '')) || '';
            if (baselineText.includes(ORIGINAL_SOURCE)) {
                break;
            }
            await driver.sleep(OVERLAY_POLL_INTERVAL);
        }
        await screenshot('before-external-edit');
        expect(baselineText, `the original cell source "${ORIGINAL_SOURCE}" should render before the edit`).to.contain(
            ORIGINAL_SOURCE
        );

        // 2. Edit the .deepnote on disk: change the cell SOURCE (so `contentActuallyChanged` fires). A
        //    safe string replace of the exact source keeps the YAML valid; re-read to verify.
        const before = fs.readFileSync(filePath, 'utf8');
        expect(before, `fixture should contain the source "${ORIGINAL_SOURCE}"`).to.contain(ORIGINAL_SOURCE);
        const after = before.replace(ORIGINAL_SOURCE, RELOAD_MARKER);
        fs.writeFileSync(filePath, after, 'utf8');

        const written = fs.readFileSync(filePath, 'utf8');
        expect(written, 'on-disk file must now contain the new source').to.contain(RELOAD_MARKER);
        expect(written, 'on-disk file must no longer contain the old source').to.not.contain(ORIGINAL_SOURCE);

        // 3. Poll the overlay until the watcher (500ms debounce + reload) re-renders the new source.
        let reloadedText = '';
        const reloadDeadline = Date.now() + RELOAD_TIMEOUT;
        while (Date.now() < reloadDeadline) {
            reloadedText = (await overlayText().catch(() => '')) || '';
            if (reloadedText.includes(RELOAD_MARKER) && !reloadedText.includes(ORIGINAL_SOURCE)) {
                break;
            }
            await driver.sleep(OVERLAY_POLL_INTERVAL);
        }
        await screenshot('after-external-edit');

        // 4. Assert with a NEGATIVE guard so a stale render cannot pass: the new source is present AND
        //    the old source is gone (the editor actually reloaded, it did not just append).
        expect(reloadedText, `watcher should re-render the new source "${RELOAD_MARKER}"`).to.contain(RELOAD_MARKER);
        expect(reloadedText, `the old source "${ORIGINAL_SOURCE}" must be gone after the reload`).to.not.contain(
            ORIGINAL_SOURCE
        );
    });
});

// Snapshot-output-update arm: a `*.snapshot.deepnote` appearing for an already-open notebook makes the
// watcher apply its saved output to the open cell (replaceCells, no kernel — unambiguously the extension).
const SNAPSHOT_FIXTURE = 'legacy-snapshot-demo.deepnote';
const SNAPSHOT = 'legacy-snapshot-demo_ffffffff-ffff-4fff-8fff-ffffffffffff_latest.snapshot.deepnote';
const SNAPSHOT_MARKER = 'SNAPSHOT_OUTPUT_MARKER';

// The file opens with NO output, so the baseline must have time to settle before we assert the marker
// is absent — long enough that a spuriously-present marker would already have rendered.
const BASELINE_ABSENCE_TIMEOUT = 5_000;
// The watcher debounces 500ms then reads + applies the snapshot; allow generous slack for the apply.
const SNAPSHOT_APPLY_TIMEOUT = 25_000;
const OUTPUT_POLL_INTERVAL = 1_000;

describe('Deepnote — the file watcher applies snapshot outputs to an open notebook when the snapshot appears on disk', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let snapshotTargetPath = '';
    let tempDir = '';

    before(async function () {
        const driver = VSBrowser.instance.driver;

        // Copy ONLY the main file — the snapshot is placed later, during the test, so the notebook is
        // already open (with no output) when the sidecar appears.
        const copy = copyFixtureToTempDir(SNAPSHOT_FIXTURE);
        cleanupTempDir = copy.cleanup;
        tempDir = copy.tempDir;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the temp dir as workspace root first: the serializer reads snapshots relative to a
        // workspace folder, else deserialization blocks headlessly. Opening a folder reloads the window.
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openWorkspaceFile(SNAPSHOT_FIXTURE);
        await driver.wait(
            async () =>
                (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(SNAPSHOT_FIXTURE)),
            WORKBENCH_TIMEOUT,
            `${SNAPSHOT_FIXTURE} did not open`
        );
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        // The output update can leave the editor dirty; revert first so closing needs no save dialog.
        await new Workbench().executeCommand('Revert File').catch(() => undefined);
        await VSBrowser.instance.driver.sleep(500);
        await new EditorView().closeAllEditors().catch(() => undefined);
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[file-watcher-snapshot] remove temp workspace dir during cleanup:', error);
        }
    });

    it('renders the snapshot output on the open cell when the snapshot file appears', async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);

        // 1. Baseline negative guard: the file opened with NO output, so the marker must be ABSENT.
        //    Poll for a few seconds so a marker that were already present would have surfaced.
        let baselineOutput = '';
        const baselineDeadline = Date.now() + BASELINE_ABSENCE_TIMEOUT;
        while (Date.now() < baselineDeadline) {
            baselineOutput = (await readRenderedOutput().catch(() => '')) || '';
            if (baselineOutput.includes(SNAPSHOT_MARKER)) {
                break;
            }
            await driver.sleep(OUTPUT_POLL_INTERVAL);
        }
        await screenshot('before-snapshot-appears');
        expect(baselineOutput, `the cell must have NO snapshot output before the snapshot file appears`).to.not.contain(
            SNAPSHOT_MARKER
        );

        // 2. Make the snapshot APPEAR on disk under `<tempDir>/snapshots/`. The fs watcher fires
        //    onDidCreate, which routes to the snapshot-output-update path.
        snapshotTargetPath = copySnapshotIntoDir(tempDir, SNAPSHOT);
        expect(fs.existsSync(snapshotTargetPath), 'snapshot file must exist on disk after the copy').to.equal(true);

        // 3. Poll the rendered output until the watcher (500ms debounce + read + replaceCells) applies
        //    the snapshot's saved stdout to the open cell.
        let appliedOutput = '';
        const applyDeadline = Date.now() + SNAPSHOT_APPLY_TIMEOUT;
        while (Date.now() < applyDeadline) {
            appliedOutput = (await readRenderedOutput().catch(() => '')) || '';
            if (appliedOutput.includes(SNAPSHOT_MARKER)) {
                break;
            }
            await driver.sleep(OUTPUT_POLL_INTERVAL);
        }
        await screenshot('after-snapshot-appears');

        // 4. Assert the snapshot output is now rendered on the open cell.
        expect(
            appliedOutput,
            `the watcher should apply the snapshot's saved output "${SNAPSHOT_MARKER}" to the open cell`
        ).to.contain(SNAPSHOT_MARKER);
    });
});
