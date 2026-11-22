import { assert, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { FileSystemError, Uri } from 'vscode';

import { createDeferred } from '../../../platform/common/utils/async';
import { logger } from '../../../platform/logging';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import {
    createDeepnoteBlock,
    createDeepnoteFile,
    createDeepnoteNotebook,
    createDeepnoteProject
} from '../deepnoteTestHelpers';
import { AppPreviewRunFiles } from './appPreviewRunFiles.node';

use(chaiAsPromised);

const STORAGE = Uri.file('/storage');
const RUN_FILE_PATH = '/storage/appPreview/runs/run-1.snapshot.deepnote';

const RUN_FILE = createDeepnoteFile({
    execution: { startedAt: '2026-01-02T03:04:05.000Z', finishedAt: '2026-01-02T03:04:09.000Z' },
    project: createDeepnoteProject({
        notebooks: [
            createDeepnoteNotebook({
                id: 'nb-1',
                blocks: [
                    createDeepnoteBlock({
                        id: 'total',
                        sortingKey: 'a0',
                        outputs: [{ output_type: 'stream', name: 'stdout', text: '3\n' }]
                    }),
                    createDeepnoteBlock({ id: 'never-ran', sortingKey: 'a1', outputs: [] })
                ]
            })
        ]
    })
});

suite('AppPreviewRunFiles', () => {
    let mockFs: typeof import('vscode').workspace.fs;
    let files: Map<string, Uint8Array>;

    setup(() => {
        resetVSCodeMocks();
        files = new Map();
        mockFs = mock<typeof import('vscode').workspace.fs>();
        when(mockFs.delete(anything(), anything())).thenResolve();
        when(mockFs.stat(anything())).thenReject(FileSystemError.FileNotFound());
        when(mockFs.createDirectory(anything())).thenResolve();
        when(mockFs.writeFile(anything(), anything())).thenCall(async (uri: Uri, content: Uint8Array) => {
            files.set(uri.fsPath, content);
        });
        when(mockFs.readFile(anything())).thenCall(async (uri: Uri) => {
            const content = files.get(uri.fsPath);
            if (!content) {
                throw FileSystemError.FileNotFound(uri);
            }

            return content;
        });
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));
    });

    teardown(() => {
        sinon.restore();
    });

    test('starts deleting the runs folder when constructed', () => {
        new AppPreviewRunFiles(STORAGE);

        verify(mockFs.delete(anything(), anything())).once();
        const [folder, options] = capture(mockFs.delete).last();
        assert.strictEqual(folder.fsPath, '/storage/appPreview/runs');
        assert.deepStrictEqual(options, { recursive: true, useTrash: false });
    });

    test('writes the file of a run only after the delete settles', async () => {
        const deleted = createDeferred<void>();
        when(mockFs.delete(anything(), anything())).thenReturn(deleted.promise);
        const runFiles = new AppPreviewRunFiles(STORAGE);

        const written = runFiles.write('run-1', RUN_FILE);
        // A write that skipped the delete would reach writeFile before setImmediate fires, as every other fs mock
        // settles at once.
        await new Promise((resolve) => setImmediate(resolve));
        verify(mockFs.writeFile(anything(), anything())).never();

        deleted.resolve();

        assert.isTrue(await written);
        assert.deepStrictEqual([...files.keys()], [RUN_FILE_PATH]);
    });

    test('logs no warning when there is no runs folder to delete', async () => {
        const warn = sinon.stub(logger, 'warn');
        when(mockFs.delete(anything(), anything())).thenReject(FileSystemError.FileNotFound());

        assert.isTrue(await new AppPreviewRunFiles(STORAGE).write('run-1', RUN_FILE));
        sinon.assert.notCalled(warn);
    });

    test('logs a warning when the delete fails, and still writes', async () => {
        const warn = sinon.stub(logger, 'warn');
        const deleteFailure = new Error('Permission denied');
        when(mockFs.delete(anything(), anything())).thenReject(deleteFailure);

        assert.isTrue(await new AppPreviewRunFiles(STORAGE).write('run-1', RUN_FILE));
        sinon.assert.calledOnceWithExactly(warn, sinon.match.string, deleteFailure);
        assert.deepStrictEqual([...files.keys()], [RUN_FILE_PATH]);
    });

    test('resolves false and logs an error naming the run when the file cannot be written', async () => {
        const logError = sinon.stub(logger, 'error');
        const writeFailure = new Error('Disk full');
        when(mockFs.writeFile(anything(), anything())).thenReject(writeFailure);

        assert.isFalse(await new AppPreviewRunFiles(STORAGE).write('run-1', RUN_FILE));
        sinon.assert.calledOnce(logError);
        assert.include(logError.firstCall.args[0], 'run-1');
        assert.strictEqual(logError.firstCall.args[1], writeFailure);
    });

    test('resolves false, and writes nothing, when the runs folder cannot be created', async () => {
        when(mockFs.createDirectory(anything())).thenReject(new Error('Permission denied'));

        assert.isFalse(await new AppPreviewRunFiles(STORAGE).write('run-1', RUN_FILE));
        assert.deepStrictEqual([...files.keys()], []);
    });

    test('reads back the outputs and execution of a written run', async () => {
        const runFiles = new AppPreviewRunFiles(STORAGE);
        await runFiles.write('run-1', RUN_FILE);

        const file = await runFiles.read('run-1');

        assert.deepStrictEqual(
            file.project.notebooks[0].blocks.map((block) => ({
                id: block.id,
                outputs: 'outputs' in block ? block.outputs : undefined
            })),
            [
                { id: 'total', outputs: [{ output_type: 'stream', name: 'stdout', text: '3\n' }] },
                { id: 'never-ran', outputs: [] }
            ]
        );
        assert.deepStrictEqual(file.execution, {
            startedAt: '2026-01-02T03:04:05.000Z',
            finishedAt: '2026-01-02T03:04:09.000Z'
        });
    });

    test('rejects reading a run that has no file', async () => {
        await assert.isRejected(new AppPreviewRunFiles(STORAGE).read('run-unknown'));
    });
});
