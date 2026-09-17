import { assert } from 'chai';
import { instance, mock, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { IDeepnoteNotebookInterpreters } from '../deepnoteNotebookInterpreters';
import { EnvironmentCapture, parsePipFreeze } from './environmentCapture.node';

const NOTEBOOK = Uri.file('/w/project.deepnote');
const INTERPRETER: PythonEnvironment = { id: 'py-312', uri: Uri.file('/w/.venv/bin/python') };

/**
 * Overrides the three members that shell out. `execFile` is imported as a module binding, which
 * cannot be stubbed under ESM, so the seam has to be on the instance.
 */
interface Stub {
    version?: string;
    environment?: 'uv' | 'conda' | 'venv' | 'poetry' | 'system';
    packages?: Record<string, string>;
}

class StubbedCapture extends EnvironmentCapture {
    public seenPackagesInterpreter: PythonEnvironment | undefined;

    constructor(
        notebookInterpreters: IDeepnoteNotebookInterpreters,
        private readonly stub: Stub
    ) {
        super(notebookInterpreters);
    }

    protected override async determinePythonVersion(): Promise<string | undefined> {
        return this.stub.version;
    }

    protected override determinePythonEnvironment(): 'uv' | 'conda' | 'venv' | 'poetry' | 'system' {
        return this.stub.environment ?? 'venv';
    }

    protected override async listPackageVersions(interpreter: PythonEnvironment): Promise<Record<string, string>> {
        this.seenPackagesInterpreter = interpreter;

        return this.stub.packages ?? {};
    }
}

function captureWith(interpreter: PythonEnvironment | undefined, stub: Stub): StubbedCapture {
    const notebookInterpreters = mock<IDeepnoteNotebookInterpreters>();
    when(notebookInterpreters.resolve(NOTEBOOK)).thenResolve(interpreter);

    return new StubbedCapture(instance(notebookInterpreters), stub);
}

suite('EnvironmentCapture', () => {
    suite('parsePipFreeze', () => {
        test('should parse standard package==version format', () => {
            const pipFreezeOutput = `numpy==1.26.0
pandas==2.1.0
scipy==1.11.3`;

            const result = parsePipFreeze(pipFreezeOutput);

            assert.deepStrictEqual(result, {
                numpy: '1.26.0',
                pandas: '2.1.0',
                scipy: '1.11.3'
            });
        });

        test('should handle empty input', () => {
            const result = parsePipFreeze('');

            assert.deepStrictEqual(result, {});
        });

        test('should skip editable installs (-e git+)', () => {
            const pipFreezeOutput = `-e git+https://github.com/user/repo.git@abc123#egg=mypackage
numpy==1.26.0
-e .`;

            const result = parsePipFreeze(pipFreezeOutput);

            assert.deepStrictEqual(result, {
                numpy: '1.26.0'
            });
        });

        test('should handle @ format for local packages', () => {
            const pipFreezeOutput = `mypackage @ file:///path/to/package
numpy==1.26.0`;

            const result = parsePipFreeze(pipFreezeOutput);

            assert.strictEqual(result['mypackage'], 'file:///path/to/package');
            assert.strictEqual(result['numpy'], '1.26.0');
        });

        test('should skip comments', () => {
            const pipFreezeOutput = `# This is a comment
numpy==1.26.0
# Another comment
pandas==2.1.0`;

            const result = parsePipFreeze(pipFreezeOutput);

            assert.deepStrictEqual(result, {
                numpy: '1.26.0',
                pandas: '2.1.0'
            });
        });

        test('should normalize package names to lowercase', () => {
            const pipFreezeOutput = `NumPy==1.26.0
Pandas==2.1.0
SciPy==1.11.3`;

            const result = parsePipFreeze(pipFreezeOutput);

            assert.strictEqual(result['numpy'], '1.26.0');
            assert.strictEqual(result['pandas'], '2.1.0');
            assert.strictEqual(result['scipy'], '1.11.3');
        });

        test('should skip blank lines', () => {
            const pipFreezeOutput = `numpy==1.26.0

pandas==2.1.0

`;

            const result = parsePipFreeze(pipFreezeOutput);

            assert.deepStrictEqual(result, {
                numpy: '1.26.0',
                pandas: '2.1.0'
            });
        });

        test('should handle packages with hyphens and underscores', () => {
            const pipFreezeOutput = `scikit-learn==1.3.0
typing_extensions==4.8.0
my-package_name==1.0.0`;

            const result = parsePipFreeze(pipFreezeOutput);

            assert.strictEqual(result['scikit-learn'], '1.3.0');
            assert.strictEqual(result['typing_extensions'], '4.8.0');
            assert.strictEqual(result['my-package_name'], '1.0.0');
        });

        test('should handle complex version strings', () => {
            const pipFreezeOutput = `package1==1.0.0.post1
package2==2.0.0rc1
package3==3.0.0a1
package4==4.0.0.dev1+local`;

            const result = parsePipFreeze(pipFreezeOutput);

            assert.strictEqual(result['package1'], '1.0.0.post1');
            assert.strictEqual(result['package2'], '2.0.0rc1');
            assert.strictEqual(result['package3'], '3.0.0a1');
            assert.strictEqual(result['package4'], '4.0.0.dev1+local');
        });

        test('should handle Windows-style line endings', () => {
            const pipFreezeOutput = `numpy==1.26.0\r\npandas==2.1.0\r\n`;

            const result = parsePipFreeze(pipFreezeOutput);

            assert.deepStrictEqual(result, {
                numpy: '1.26.0',
                pandas: '2.1.0'
            });
        });
    });

    suite('captureEnvironment', () => {
        test('captures from the interpreter the notebook runs on', async () => {
            const capture = captureWith(INTERPRETER, {
                version: '3.12.13',
                environment: 'venv',
                packages: { numpy: '1.26.0', pandas: '2.1.0' }
            });

            const environment = await capture.captureEnvironment(NOTEBOOK);

            assert.deepStrictEqual(environment?.packages, { numpy: '1.26.0', pandas: '2.1.0' });
            assert.deepStrictEqual(environment?.python, { environment: 'venv', version: '3.12.13' });
            assert.strictEqual(capture.seenPackagesInterpreter, INTERPRETER);
        });

        test("captures the notebook's pinned interpreter, not the workspace-active one", async () => {
            const pinned: PythonEnvironment = { id: 'py-pinned', uri: Uri.file('/w/other-venv/bin/python') };
            const capture = captureWith(pinned, { version: '3.12.13', packages: { numpy: '1.26.0' } });

            await capture.captureEnvironment(NOTEBOOK);

            assert.strictEqual(capture.seenPackagesInterpreter, pinned);
        });

        test('reports the interpreter type it was given rather than assuming a venv', async () => {
            const capture = captureWith(INTERPRETER, { version: '3.12.13', environment: 'conda' });

            const environment = await capture.captureEnvironment(NOTEBOOK);

            assert.strictEqual(environment?.python?.environment, 'conda');
        });

        test('returns undefined when no interpreter resolves for the notebook', async () => {
            const capture = captureWith(undefined, { version: '3.12.13' });

            assert.isUndefined(await capture.captureEnvironment(NOTEBOOK));
        });

        test('returns undefined when the Python version cannot be determined', async () => {
            const capture = captureWith(INTERPRETER, { version: undefined, packages: { numpy: '1.26.0' } });

            assert.isUndefined(await capture.captureEnvironment(NOTEBOOK));
        });

        test('hashes the package set, so a changed package produces a different hash', async () => {
            const before = await captureWith(INTERPRETER, {
                version: '3.12.13',
                packages: { numpy: '1.26.0' }
            }).captureEnvironment(NOTEBOOK);
            const after = await captureWith(INTERPRETER, {
                version: '3.12.13',
                packages: { numpy: '1.26.1' }
            }).captureEnvironment(NOTEBOOK);

            assert.match(before?.hash ?? '', /^sha256:/);
            assert.notStrictEqual(before?.hash, after?.hash);
        });
    });
});
