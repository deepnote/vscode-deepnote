import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface FixtureCopy {
    /** Removes the throwaway temp directory and its contents. Idempotent; safe to call more than once. */
    cleanup: () => void;
    /** The absolute path to the copied fixture file inside `tempDir`. */
    filePath: string;
    /** The throwaway temp directory the fixture was copied into (suitable as a workspace folder). */
    tempDir: string;
}

/**
 * Copies a fixture from `test/e2e/fixtures` into a fresh throwaway temp directory and returns the
 * paths plus a `cleanup` callback that removes the dir. Execution dirties the notebook, so working
 * on a throwaway copy keeps the committed fixture pristine and avoids save prompts.
 */
export function copyFixtureToTempDir(fixtureName: string): FixtureCopy {
    const source = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', fixtureName);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-'));
    const filePath = path.join(tempDir, fixtureName);
    fs.copyFileSync(source, filePath);

    const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true });

    return { cleanup, filePath, tempDir };
}
