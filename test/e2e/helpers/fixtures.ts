import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface FixtureCopy {
    /** Removes the temp directory and its contents. Idempotent. */
    cleanup: () => void;
    filePath: string;
    /** The temp directory the fixture was copied into (suitable as a workspace folder). */
    tempDir: string;
}

/**
 * Copies a fixture into a fresh temp directory and returns the paths plus a `cleanup` callback.
 * Working on a throwaway copy keeps the committed fixture pristine (execution dirties the notebook).
 */
export function copyFixtureToTempDir(fixtureName: string): FixtureCopy {
    const source = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', fixtureName);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-'));
    const filePath = path.join(tempDir, fixtureName);
    fs.copyFileSync(source, filePath);

    const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true });

    return { cleanup, filePath, tempDir };
}
