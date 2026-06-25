import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface FixtureCopy {
    /** The throwaway temp directory the fixture was copied into (suitable as a workspace folder). */
    tempDir: string;
    /** The absolute path to the copied fixture file inside `tempDir`. */
    filePath: string;
}

/**
 * Copies a fixture from `test/e2e/fixtures` into a fresh throwaway temp directory and returns both
 * paths. Execution dirties the notebook, so working on a throwaway copy keeps the committed fixture
 * pristine and avoids save prompts.
 */
export function copyFixtureToTempDir(fixtureName: string): FixtureCopy {
    const source = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', fixtureName);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-'));
    const filePath = path.join(tempDir, fixtureName);
    fs.copyFileSync(source, filePath);

    return { tempDir, filePath };
}
