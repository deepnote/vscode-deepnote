import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface FixtureCopy {
    /** Removes the throwaway temp directory and its contents. Idempotent; safe to call more than once. */
    cleanup: () => void;
    /** The absolute path to the copied fixture file inside `tempDir`. */
    filePath: string;
    /** The rewritten project id of the copied fixture — assert against this, not the committed one. */
    projectId: string;
    /** The throwaway directory the fixture was copied into, a child of the shared workspace root. */
    tempDir: string;
}

const FIXTURES_DIR = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures');
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Rewritten ids are sequential rather than random so a failing run stays reproducible and an id in a
// log or screenshot points back at the copy that produced it.
let nextId = 0;

// One mapping per temp directory, keyed by the *committed* project id. Sibling files copied into the
// same directory therefore keep sharing a project, while a copy set that deliberately mixes projects
// (explorerGrouping sits marketing siblings next to a different project) stays mixed.
const idMappings = new Map<string, Map<string, string>>();

let workspaceRoot: string | undefined;

/**
 * The single directory every fixture copy lives under. Opened once as the workspace folder (see
 * rootHooks) rather than once per suite: opening a folder reloads the workbench, and that reload
 * dominated suite setup.
 */
export function fixturesWorkspaceRoot(): string {
    if (!workspaceRoot) {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-root-'));
    }

    return workspaceRoot;
}

/** True when `folder` sits inside the already-opened shared root (so opening it would be a no-op). */
export function isInsideFixturesWorkspaceRoot(folder: string): boolean {
    return workspaceRoot !== undefined && path.resolve(folder).startsWith(path.resolve(workspaceRoot) + path.sep);
}

export function removeFixturesWorkspaceRoot(): void {
    if (workspaceRoot) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        workspaceRoot = undefined;
    }
}

/**
 * Reads `project.id` out of a fixture. Scanned line by line rather than matched with a
 * multi-line regex, which backtracks catastrophically on a file that does not match.
 */
function readProjectId(contents: string): string {
    const lines = contents.split('\n');
    const projectLine = lines.findIndex((line) => line.startsWith('project:'));

    for (let index = projectLine + 1; index > 0 && index < lines.length; index++) {
        const match = lines[index].match(/^\s+id:\s*'?([^'\s]+)'?\s*$/);
        if (match) {
            return match[1];
        }
        // Stop at the next top-level key so a nested id further down cannot be mistaken for it.
        if (/^\S/.test(lines[index])) {
            break;
        }
    }

    throw new Error('Could not read project.id from fixture');
}

/**
 * Keeps the shape of the committed id — a uuid stays a uuid, a slug stays a slug — while sharing no
 * prefix with it, so replacing the old token can never leave a fragment of it behind.
 */
function freshId(sourceId: string): string {
    nextId += 1;

    return UUID_SHAPE.test(sourceId)
        ? `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`
        : `e2e-project-${nextId}`;
}

/**
 * Replaces the project id wherever it appears, refusing to match when it is merely the start of a
 * longer id: a fixture whose notebook id extends its project id would otherwise be corrupted.
 *
 * `_` is deliberately not a boundary character — snapshot filenames separate the id from the variant
 * with one (`<slug>_<projectId>_latest`), and fixture ids only ever use `-` internally.
 */
function replaceId(text: string, sourceId: string, projectId: string): string {
    const escaped = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    return text.replace(new RegExp(`${escaped}(?![A-Za-z0-9-])`, 'g'), projectId);
}

function translate(tempDir: string, sourceId: string): string {
    let mapping = idMappings.get(tempDir);
    if (!mapping) {
        mapping = new Map<string, string>();
        idMappings.set(tempDir, mapping);
    }

    let replacement = mapping.get(sourceId);
    if (!replacement) {
        replacement = freshId(sourceId);
        mapping.set(sourceId, replacement);
    }

    return replacement;
}

/**
 * Copies a fixture with its project id rewritten, returning the new id.
 *
 * Only the project id is rewritten. That is what the extension's cross-suite caches key on — the
 * notebook manager, the tree's group cache, and the `(projectId, notebookId)` lookups in the file
 * watcher and snapshot service — so a unique project id makes those pairs unique too. Notebook and
 * block ids are left alone, since suites assert on them directly.
 */
function writeRewritten(source: string, target: string, tempDir: string): string {
    const contents = fs.readFileSync(source, 'utf8');
    const sourceProjectId = readProjectId(contents);
    const projectId = translate(tempDir, sourceProjectId);

    fs.writeFileSync(target, replaceId(contents, sourceProjectId, projectId), 'utf8');

    return projectId;
}

/**
 * Copies a fixture from `test/e2e/fixtures` into a fresh directory under the shared workspace root
 * and returns the paths plus a `cleanup` callback. Execution dirties the notebook, so working on a
 * throwaway copy keeps the committed fixture pristine and avoids save prompts.
 *
 * The copy's project id is rewritten to a fresh one. Suites share a single workspace and window now,
 * so without this the extension's project-id-keyed caches would carry one suite's state into the
 * next — which is what the per-suite window reload used to prevent.
 */
export function copyFixtureToTempDir(fixtureName: string): FixtureCopy {
    const tempDir = fs.mkdtempSync(path.join(fixturesWorkspaceRoot(), 'suite-'));
    const filePath = path.join(tempDir, fixtureName);
    const projectId = writeRewritten(path.join(FIXTURES_DIR, fixtureName), filePath, tempDir);

    const cleanup = () => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        idMappings.delete(tempDir);
    };

    return { cleanup, filePath, projectId, tempDir };
}

/**
 * Copies an additional fixture into an existing copy's directory, reusing that directory's mapping
 * so siblings keep sharing one project id. Returns the written path.
 */
export function copyFixtureIntoDir(tempDir: string, fixtureName: string): string {
    const target = path.join(tempDir, fixtureName);
    writeRewritten(path.join(FIXTURES_DIR, fixtureName), target, tempDir);

    return target;
}

/**
 * Copies a snapshot fixture into `<tempDir>/snapshots/`, rewriting the project id inside it *and* in
 * its name: `buildSnapshotPath` encodes the project id into the filename, so a rewritten project
 * whose snapshot kept the committed name would silently never be found. Returns the written path.
 */
export function copySnapshotIntoDir(tempDir: string, snapshotName: string): string {
    const snapshotsDir = path.join(tempDir, 'snapshots');
    fs.mkdirSync(snapshotsDir, { recursive: true });

    const source = path.join(FIXTURES_DIR, 'snapshots', snapshotName);
    const sourceProjectId = readProjectId(fs.readFileSync(source, 'utf8'));
    const target = path.join(snapshotsDir, replaceId(snapshotName, sourceProjectId, translate(tempDir, sourceProjectId)));
    writeRewritten(source, target, tempDir);

    return target;
}
