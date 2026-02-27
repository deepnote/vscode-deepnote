import { assert } from 'chai';
import { Uri } from 'vscode';

import {
    extractProjectIdFromSnapshotUri,
    isSnapshotFile,
    slugifyProjectName,
    SNAPSHOT_FILE_SUFFIX
} from './snapshotFiles';

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
        test('should extract project ID from latest snapshot URI', () => {
            const uri = Uri.file('/path/to/snapshots/my-project_abc-123_latest.snapshot.deepnote');

            assert.strictEqual(extractProjectIdFromSnapshotUri(uri), 'abc-123');
        });

        test('should extract project ID from timestamped snapshot URI', () => {
            const uri = Uri.file('/path/to/snapshots/my-project_abc-123_2025-01-15T10-31-48.snapshot.deepnote');

            assert.strictEqual(extractProjectIdFromSnapshotUri(uri), 'abc-123');
        });

        test('should return undefined for non-snapshot files', () => {
            const uri = Uri.file('/path/to/my-project.deepnote');

            assert.isUndefined(extractProjectIdFromSnapshotUri(uri));
        });

        test('should return undefined for filenames with no underscores', () => {
            const uri = Uri.file('/path/to/plain-name.snapshot.deepnote');

            assert.isUndefined(extractProjectIdFromSnapshotUri(uri));
        });

        test('should return undefined for filenames with a single underscore', () => {
            const uri = Uri.file('/path/to/slug_only.snapshot.deepnote');

            assert.isUndefined(extractProjectIdFromSnapshotUri(uri));
        });

        test('should handle project IDs containing underscores', () => {
            const uri = Uri.file('/path/to/snapshots/slug_proj_id_with_parts_latest.snapshot.deepnote');

            assert.strictEqual(extractProjectIdFromSnapshotUri(uri), 'proj_id_with_parts');
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

        test('should handle project names with special characters', () => {
            assert.strictEqual(slugifyProjectName('Test@#$%Project'), 'testproject');
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

        test('should throw error for empty project name', () => {
            assert.throws(
                () => slugifyProjectName(''),
                'Project name cannot be empty or contain only special characters'
            );
        });

        test('should throw error for project name with only special characters', () => {
            assert.throws(
                () => slugifyProjectName('@#$%^&*()'),
                'Project name cannot be empty or contain only special characters'
            );
        });

        test('should throw error for project name with only whitespace', () => {
            assert.throws(
                () => slugifyProjectName('   '),
                'Project name cannot be empty or contain only special characters'
            );
        });
    });
});
