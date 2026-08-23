import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { linkManagedVenvInto } from './venv';

export interface FixtureCopy {
    /** Removes the throwaway temp directory and its contents. Idempotent; safe to call more than once. */
    cleanup: () => void;
    /** The absolute path to the copied fixture file inside `tempDir`. */
    filePath: string;
    /** The throwaway directory the fixture was copied into, a child of the shared workspace root. */
    tempDir: string;
}

const FIXTURES_DIR = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures');

let workspaceRoot: string | undefined;

/**
 * The single directory every fixture copy lives under. openFolderViaDialog opens it once, on the
 * first suite that asks, rather than once per suite: opening a folder reloads the workbench, and
 * that reload dominated suite setup. Each suite still removes its own subdirectory in `after`.
 */
export function fixturesWorkspaceRoot(): string {
    if (!workspaceRoot) {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-root-'));
        // Exposed as `.venv` so the Python extension discovers it with no configuration, which is
        // what lets the suites run without a settings file written ahead of the window opening.
        linkManagedVenvInto(workspaceRoot);
    }

    return workspaceRoot;
}

/**
 * Copies a fixture from `test/e2e/fixtures` into a fresh directory under the shared workspace root
 * and returns the paths plus a `cleanup` callback. Execution dirties the notebook, so working on a
 * throwaway copy keeps the committed fixture pristine and avoids save prompts.
 *
 * Copies keep their committed ids: what isolates one suite from the next is the window reload in
 * enterFixturesWorkspace(), which restarts the extension host, plus this directory being removed in
 * `after` — so no two copies of a fixture are ever in the workspace at the same time.
 */
export function copyFixtureToTempDir(fixtureName: string): FixtureCopy {
    const tempDir = fs.mkdtempSync(path.join(fixturesWorkspaceRoot(), 'suite-'));
    const filePath = path.join(tempDir, fixtureName);
    fs.copyFileSync(path.join(FIXTURES_DIR, fixtureName), filePath);

    const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true });

    return { cleanup, filePath, tempDir };
}

/**
 * Copies an additional fixture into an existing copy's directory, which is how a suite assembles a
 * multi-file project. Returns the written path.
 */
export function copyFixtureIntoDir(tempDir: string, fixtureName: string): string {
    const target = path.join(tempDir, fixtureName);
    fs.copyFileSync(path.join(FIXTURES_DIR, fixtureName), target);

    return target;
}

/**
 * Copies a snapshot fixture into `<tempDir>/snapshots/`, the sibling directory buildSnapshotPath
 * resolves to. Returns the written path.
 */
export function copySnapshotIntoDir(tempDir: string, snapshotName: string): string {
    const snapshotsDir = path.join(tempDir, 'snapshots');
    fs.mkdirSync(snapshotsDir, { recursive: true });

    const target = path.join(snapshotsDir, snapshotName);
    fs.copyFileSync(path.join(FIXTURES_DIR, 'snapshots', snapshotName), target);

    return target;
}
