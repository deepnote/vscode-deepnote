// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert } from 'chai';
import * as fs from 'fs-extra';
import * as path from '../../../platform/vscode-path/path';
import * as os from 'os';
import { FileSystem } from './fileSystem.node';

suite('FileSystem - glob functionality', () => {
    let fileSystem: FileSystem;
    let tempDir: string;

    setup(async () => {
        fileSystem = new FileSystem();
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-deepnote-test-'));
    });

    teardown(async () => {
        await fs.remove(tempDir);
    });

    test('searchLocal should find files matching pattern', async () => {
        // Create test files
        await fs.writeFile(path.join(tempDir, 'test1.ts'), 'content');
        await fs.writeFile(path.join(tempDir, 'test2.ts'), 'content');
        await fs.writeFile(path.join(tempDir, 'test.js'), 'content');

        const results = await fileSystem.searchLocal('*.ts', tempDir);

        assert.strictEqual(results.length, 2);
        assert.ok(results.some((f) => f.endsWith('test1.ts')));
        assert.ok(results.some((f) => f.endsWith('test2.ts')));
    });

    test('searchLocal should find files in subdirectories with ** pattern', async () => {
        // Create test files in subdirectories
        await fs.ensureDir(path.join(tempDir, 'sub1'));
        await fs.ensureDir(path.join(tempDir, 'sub2'));
        await fs.writeFile(path.join(tempDir, 'sub1', 'test1.ts'), 'content');
        await fs.writeFile(path.join(tempDir, 'sub2', 'test2.ts'), 'content');

        const results = await fileSystem.searchLocal('**/*.ts', tempDir);

        assert.strictEqual(results.length, 2);
        assert.ok(results.some((f) => f.includes('sub1') && f.endsWith('test1.ts')));
        assert.ok(results.some((f) => f.includes('sub2') && f.endsWith('test2.ts')));
    });

    test('searchLocal should find hidden files when dot option is true', async () => {
        // Create hidden file
        await fs.writeFile(path.join(tempDir, '.hidden.ts'), 'content');
        await fs.writeFile(path.join(tempDir, 'visible.ts'), 'content');

        const results = await fileSystem.searchLocal('*.ts', tempDir, true);

        assert.ok(results.length >= 2);
        assert.ok(results.some((f) => f.endsWith('.hidden.ts')));
        assert.ok(results.some((f) => f.endsWith('visible.ts')));
    });

    test('searchLocal should not find hidden files when dot option is false', async () => {
        // Create hidden file
        await fs.writeFile(path.join(tempDir, '.hidden.ts'), 'content');
        await fs.writeFile(path.join(tempDir, 'visible.ts'), 'content');

        const results = await fileSystem.searchLocal('*.ts', tempDir, false);

        assert.strictEqual(results.length, 1);
        assert.ok(results.some((f) => f.endsWith('visible.ts')));
        assert.ok(!results.some((f) => f.endsWith('.hidden.ts')));
    });

    test('searchLocal should return empty array when no files match', async () => {
        const results = await fileSystem.searchLocal('*.nonexistent', tempDir);

        assert.strictEqual(results.length, 0);
    });

    test('searchLocal should handle patterns with multiple extensions', async () => {
        await fs.writeFile(path.join(tempDir, 'test.ts'), 'content');
        await fs.writeFile(path.join(tempDir, 'test.js'), 'content');
        await fs.writeFile(path.join(tempDir, 'test.py'), 'content');

        const results = await fileSystem.searchLocal('*.{ts,js}', tempDir);

        assert.strictEqual(results.length, 2);
        assert.ok(results.some((f) => f.endsWith('.ts')));
        assert.ok(results.some((f) => f.endsWith('.js')));
        assert.ok(!results.some((f) => f.endsWith('.py')));
    });
});
