import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { linkManagedVenvInto } from './venv';

export interface FixtureCopy {
    /** Removes the throwaway temp directory and its contents. Idempotent; safe to call more than once. */
    cleanup: () => void;
    /** The absolute path to the copied fixture file inside `tempDir`. */
    filePath: string;
    /** The throwaway temp directory the fixture was copied into (suitable as a workspace folder). */
    tempDir: string;
}

const FIXTURES_DIR = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures');

/**
 * Copies a fixture from `test/e2e/fixtures` into a fresh throwaway temp directory and returns the
 * paths plus a `cleanup` callback that removes the dir. Execution dirties the notebook, so working
 * on a throwaway copy keeps the committed fixture pristine and avoids save prompts.
 *
 * The directory is opened as the suite's workspace folder, so the pre-baked venv is linked into it
 * as `.venv`, which is where the Python extension discovers it with no configuration. `cleanup`
 * unlinks that symlink rather than following it, leaving the venv itself intact.
 */
export function copyFixtureToTempDir(fixtureName: string): FixtureCopy {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-'));
    const filePath = path.join(tempDir, fixtureName);
    fs.copyFileSync(path.join(FIXTURES_DIR, fixtureName), filePath);
    linkManagedVenvInto(tempDir);

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
