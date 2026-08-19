import { generateSnapshotFilename, parseSnapshotFilename, slugifyProjectName } from '@deepnote/convert';
import { assert } from 'chai';
import { Uri } from 'vscode';

import { extractProjectIdFromSnapshotUri, isSnapshotFile, SNAPSHOT_FILE_SUFFIX } from './snapshotFiles';

suite('snapshotFiles', () => {
    suite('SNAPSHOT_FILE_SUFFIX', () => {
        test('should be .snapshot.deepnote', () => {
            assert.strictEqual(SNAPSHOT_FILE_SUFFIX, '.snapshot.deepnote');
        });
    });

    suite('isSnapshotFile', () => {
        test('should return true for snapshot files', () => {
            const uri = Uri.file('/path/to/project_abc-123_latest.snapshot.deepnote');

            assert.isTrue(isSnapshotFile(uri));
        });

        test('should return true for timestamped snapshot files', () => {
            const uri = Uri.file('/path/to/project_abc-123_2025-01-15T10-31-48.snapshot.deepnote');

            assert.isTrue(isSnapshotFile(uri));
        });

        test('should return false for regular deepnote files', () => {
            const uri = Uri.file('/path/to/my-project.deepnote');

            assert.isFalse(isSnapshotFile(uri));
        });

        test('should return false for other file types', () => {
            const uri = Uri.file('/path/to/file.txt');

            assert.isFalse(isSnapshotFile(uri));
        });

        test('should return false for files with snapshot in name but wrong extension', () => {
            const uri = Uri.file('/path/to/snapshot.json');

            assert.isFalse(isSnapshotFile(uri));
        });
    });

    suite('extractProjectIdFromSnapshotUri', () => {
        const projectId = 'e132b172-b114-410e-8331-011517db664f';

        test('should extract project ID from legacy latest snapshot URI', () => {
            const uri = Uri.file(`/path/to/snapshots/my-project_${projectId}_latest.snapshot.deepnote`);

            assert.strictEqual(extractProjectIdFromSnapshotUri(uri), projectId);
        });

        test('should extract project ID from notebook-scoped latest snapshot URI', () => {
            const uri = Uri.file(`/path/to/snapshots/my-project_${projectId}_notebook-1_latest.snapshot.deepnote`);

            assert.strictEqual(extractProjectIdFromSnapshotUri(uri), projectId);
        });

        test('should return undefined for non-snapshot files', () => {
            const uri = Uri.file('/path/to/my-project.deepnote');

            assert.isUndefined(extractProjectIdFromSnapshotUri(uri));
        });

        test('should return undefined for filenames with no underscores', () => {
            const uri = Uri.file('/path/to/plain-name.snapshot.deepnote');

            assert.isUndefined(extractProjectIdFromSnapshotUri(uri));
        });

        test('should return undefined when the project id is not a UUID', () => {
            const uri = Uri.file('/path/to/snapshots/slug_not-a-uuid_latest.snapshot.deepnote');

            assert.isUndefined(extractProjectIdFromSnapshotUri(uri));
        });
    });

    // Use real UUIDs: convert's parseSnapshotFilename only matches a 36-char projectId, so any
    // fixture with a short/non-UUID projectId would fail to parse and silently weaken the test.
    suite('generateSnapshotFilename / parseSnapshotFilename round-trip', () => {
        const projectId = 'e132b172-b114-410e-8331-011517db664f';
        const notebookId = '11111111-2222-3333-4444-555555555555';

        test('round-trips projectId, notebookId, and timestamp for the notebook-scoped form (catches an encoding drift that would lose the notebook id on parse)', () => {
            const filename = generateSnapshotFilename({
                slug: 'my-project',
                projectId,
                notebookId,
                timestamp: '2025-01-02T10-31-48'
            });

            const parsed = parseSnapshotFilename(filename);

            assert.deepStrictEqual(parsed, {
                slug: 'my-project',
                projectId,
                notebookId,
                timestamp: '2025-01-02T10-31-48'
            });
        });

        test('percent-encodes a notebook id with non-filename-safe characters and decodes it back unchanged (catches a path-unsafe filename or a lossy decode)', () => {
            const trickyNotebookId = 'naïve/notebook id';
            const filename = generateSnapshotFilename({
                slug: 'my-project',
                projectId,
                notebookId: trickyNotebookId,
                timestamp: 'latest'
            });

            // The on-disk filename must be path-safe: no raw slash or space leaks into the basename.
            assert.notInclude(filename, '/notebook');
            assert.notInclude(filename, ' ');
            assert.include(filename, '%2F');
            assert.include(filename, '%20');

            const parsed = parseSnapshotFilename(filename);

            assert.strictEqual(parsed?.notebookId, trickyNotebookId);
        });

        test('parses the legacy no-notebook-id form with notebookId === undefined (catches treating a legacy snapshot as notebook-scoped)', () => {
            const filename = generateSnapshotFilename({ slug: 'my-project', projectId, timestamp: 'latest' });

            // The legacy form must NOT embed a notebook id between the project id and the timestamp.
            assert.strictEqual(filename, `my-project_${projectId}_latest.snapshot.deepnote`);

            const parsed = parseSnapshotFilename(filename);

            assert.isDefined(parsed);
            assert.strictEqual(parsed!.projectId, projectId);
            assert.strictEqual(parsed!.timestamp, 'latest');
            assert.isUndefined(parsed!.notebookId);
        });
    });

    suite('slugifyProjectName', () => {
        test('should convert to lowercase', () => {
            assert.strictEqual(slugifyProjectName('My Project'), 'my-project');
        });

        test('should replace spaces with hyphens', () => {
            assert.strictEqual(slugifyProjectName('hello world'), 'hello-world');
        });

        test('should remove special characters', () => {
            assert.strictEqual(slugifyProjectName('Customer Churn ML Playbook!'), 'customer-churn-ml-playbook');
        });

        test('should treat runs of special characters as a single hyphen', () => {
            assert.strictEqual(slugifyProjectName('Test@#$%Project'), 'test-project');
        });

        test('should normalize accented characters to ASCII', () => {
            assert.strictEqual(slugifyProjectName('Café Cliché'), 'cafe-cliche');
        });

        test('should collapse multiple spaces into single hyphen', () => {
            assert.strictEqual(slugifyProjectName('My   Project   Name'), 'my-project-name');
        });

        test('should collapse multiple hyphens into single hyphen', () => {
            assert.strictEqual(slugifyProjectName('my--project'), 'my-project');
        });

        test('should remove leading and trailing hyphens', () => {
            assert.strictEqual(slugifyProjectName('-project-'), 'project');
        });

        test('should return an empty string for an empty project name', () => {
            assert.strictEqual(slugifyProjectName(''), '');
        });

        test('should return an empty string for a name with only special characters', () => {
            assert.strictEqual(slugifyProjectName('@#$%^&*()'), '');
        });

        test('should return an empty string for a name with only whitespace', () => {
            assert.strictEqual(slugifyProjectName('   '), '');
        });
    });
});
