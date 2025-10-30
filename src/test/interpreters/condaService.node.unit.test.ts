// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable local-rules/dont-use-process */

import { assert } from 'chai';
import * as path from '../../platform/vscode-path/path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { getCondaFile } from './condaService.node';
import { glob } from 'glob';

suite('condaService - glob functionality', () => {
    let originalEnv: string | undefined;
    let tempDir: string;

    setup(async () => {
        // Save original environment variable
        originalEnv = process.env.CI_PYTHON_CONDA_PATH;
        delete process.env.CI_PYTHON_CONDA_PATH;

        // Create a temporary directory for testing
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conda-test-'));
    });

    teardown(async () => {
        // Restore environment variable
        if (originalEnv !== undefined) {
            process.env.CI_PYTHON_CONDA_PATH = originalEnv;
        } else {
            delete process.env.CI_PYTHON_CONDA_PATH;
        }

        // Clean up temp directory
        await fs.remove(tempDir);
    });

    test('getCondaFile should use CI_PYTHON_CONDA_PATH when set', async () => {
        process.env.CI_PYTHON_CONDA_PATH = '/custom/conda/path';

        const result = await getCondaFile();

        assert.strictEqual(result, '/custom/conda/path');
    });

    test('glob should work with basic patterns', async () => {
        // Create test files
        await fs.writeFile(path.join(tempDir, 'conda'), 'test');
        await fs.writeFile(path.join(tempDir, 'python'), 'test');

        const results = await glob('conda', { cwd: tempDir });

        assert.strictEqual(results.length, 1);
        assert.ok(results[0].includes('conda'));
    });

    test('glob should work with wildcard patterns', async () => {
        // Create test files
        await fs.writeFile(path.join(tempDir, 'conda1'), 'test');
        await fs.writeFile(path.join(tempDir, 'conda2'), 'test');
        await fs.writeFile(path.join(tempDir, 'python'), 'test');

        const results = await glob('conda*', { cwd: tempDir });

        assert.strictEqual(results.length, 2);
    });

    test('glob should handle brace expansion patterns', async () => {
        // Create test files
        await fs.writeFile(path.join(tempDir, 'conda'), 'test');
        await fs.writeFile(path.join(tempDir, 'miniconda'), 'test');
        await fs.writeFile(path.join(tempDir, 'python'), 'test');

        const results = await glob('{conda,miniconda}', { cwd: tempDir });

        assert.strictEqual(results.length, 2);
        assert.ok(results.some((r) => r.includes('conda')));
        assert.ok(results.some((r) => r.includes('miniconda')));
    });

    test('glob should return empty array when no matches found', async () => {
        const results = await glob('nonexistent*', { cwd: tempDir });

        assert.strictEqual(results.length, 0);
    });

    test('glob should handle errors gracefully with catch', async () => {
        const results = await glob('/nonexistent/path/**/*', {}).catch(() => []);

        assert.deepStrictEqual(results, []);
    });
});
