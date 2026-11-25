import {
    CompressionType,
    compressionRegistry,
    DateDay,
    Dictionary,
    Field,
    FixedSizeBinary,
    Int32,
    Int64,
    makeData,
    RecordBatch,
    RecordBatchFileWriter,
    Schema,
    Struct,
    Utf8,
    vectorFromArray
} from 'apache-arrow';
import { assert } from 'chai';
import * as fs from 'fs';
import fsPromises from 'fs/promises';
import { syncBuiltinESMExports } from 'module';
import os from 'os';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import zlib from 'zlib';

import { DeepnoteAppPreview } from '../../../platform/common/utils/localize';
import { platformUtils } from '../../../platform/common/utils/platform.node';
import * as path from '../../../platform/vscode-path/path';
import { EXTENSION_ROOT_DIR_FOR_TESTS } from '../../../test/constants.node';
import {
    DATAFRAME_NOT_FOUND_MESSAGE,
    DataframePageError,
    DATE_OUT_OF_RANGE_MESSAGE,
    LZ4_MESSAGE
} from './dataframePage';
import { readStoredDataframePage } from './storedDataframePage.node';

const REFERENCE_ID = '0b5c1f2e-3d4a-4b6c-8d7e-9f0a1b2c3d4e';
const LZ4_FRAME_HEADER = Uint8Array.of(0x04, 0x22, 0x4d, 0x18, 0x40, 0x40, 0xc0);
const OTHER_REFERENCE_ID = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const FIXTURE_PROJECT = Uri.joinPath(
    Uri.file(EXTENSION_ROOT_DIR_FOR_TESTS),
    'src',
    'test',
    'testFiles',
    'appPreview',
    'frames'
);

function numbers(...values: number[]): RecordBatch {
    return new RecordBatch({ n: vectorFromArray(values, new Int32()).data[0] });
}

async function rejection(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
    const error = await promise.then(
        () => assert.fail('the read did not reject'),
        (reason: unknown) => reason
    );
    assert.instanceOf(error, DataframePageError);

    return { status: error.status, message: error.message };
}

suite('readStoredDataframePage', () => {
    let projectFolder: string;
    let home: string;
    let getEnvironmentVariable: sinon.SinonStub;

    setup(() => {
        projectFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-stored-dataframe-'));
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-stored-dataframe-home-'));
        getEnvironmentVariable = sinon.stub(platformUtils, 'getEnvironmentVariable').callThrough();
        getEnvironmentVariable.withArgs('HOME').returns(home);
    });

    teardown(() => {
        sinon.restore();
        syncBuiltinESMExports();
        fs.rmSync(projectFolder, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    });

    function frameDirectory(name: string): string {
        return path.join(projectFolder, 'deepnote_dataframes', name);
    }

    function moveFramesToHome(): void {
        fs.mkdirSync(path.join(home, 'work'));
        fs.renameSync(path.join(projectFolder, 'deepnote_dataframes'), path.join(home, 'work', 'deepnote_dataframes'));
    }

    function writeManifest(name: string, manifest: unknown): void {
        fs.mkdirSync(frameDirectory(name), { recursive: true });
        const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
        fs.writeFileSync(path.join(frameDirectory(name), 'manifest.json'), text);
    }

    function writeFrame(
        name: string,
        batches: RecordBatch[],
        options: { compression?: CompressionType; manifest?: unknown; referenceId?: string } = {}
    ): void {
        const referenceId = options.referenceId ?? REFERENCE_ID;
        if (options.compression === CompressionType.ZSTD) {
            compressionRegistry.set(CompressionType.ZSTD, { encode: (bytes) => zlib.zstdCompressSync(bytes) });
        }
        // The reader refuses lz4 before decoding, so a buffer need not be real lz4: only start like an lz4 frame, as
        // apache-arrow checks, and be shorter than the data, or the writer stores the data uncompressed.
        if (options.compression === CompressionType.LZ4_FRAME) {
            compressionRegistry.set(CompressionType.LZ4_FRAME, { encode: () => LZ4_FRAME_HEADER });
        }
        const writer = RecordBatchFileWriter.writeAll(batches, { compressionType: options.compression ?? null });
        fs.mkdirSync(frameDirectory(name), { recursive: true });
        fs.writeFileSync(path.join(frameDirectory(name), `${referenceId}.arrow`), writer.toUint8Array(true));
        writeManifest(
            name,
            options.manifest ?? {
                file: `${referenceId}.arrow`,
                rows: batches.reduce((rows, batch) => rows + batch.numRows, 0),
                batch_rows: batches.map((batch) => batch.numRows)
            }
        );
    }

    function read(name: string, pageIndex = 0, pageSize = 10, folder = Uri.file(projectFolder)) {
        return readStoredDataframePage(folder, name, { pageIndex, pageSize });
    }

    suite('encoding', () => {
        test('answers 422 for a page that holds a date outside the years 0 to 9999, and serves the pages without it', async () => {
            const dates = makeData({ type: new DateDay(), length: 2, data: Int32Array.of(0, 2_932_897) });
            writeFrame('frame', [new RecordBatch({ when: dates })]);

            assert.deepStrictEqual((await read('frame', 0, 1)).rows, [['1970-01-01']]);
            assert.deepStrictEqual(await rejection(read('frame', 1, 1)), {
                status: 422,
                message: DATE_OUT_OF_RANGE_MESSAGE
            });
        });

        test('answers 422 for a column it cannot encode, before it encodes any value', async () => {
            // apache-arrow's TKeys leaves out 64-bit indices, and its getters throw a TypeError on them, so only a reader
            // that describes the columns before it encodes a value answers 422.
            const dictionary = makeData({
                type: new Dictionary<Utf8, any>(new Utf8(), new Int64()),
                length: 1,
                data: BigInt64Array.of(0n),
                dictionary: vectorFromArray(['a'], new Utf8())
            });
            writeFrame('frame', [new RecordBatch({ dictionary })]);

            assert.deepStrictEqual(await rejection(read('frame')), {
                status: 422,
                message: 'The dataframe has an unsupported column type Dictionary<Int64, Utf8>.'
            });
        });

        test('answers an arrow.uuid column as UUIDs, by the extension name the frame file keeps on the column', async () => {
            const field = new Field(
                'id',
                new FixedSizeBinary(16),
                true,
                new Map([['ARROW:extension:name', 'arrow.uuid']])
            );
            const ids = makeData({
                type: field.type,
                length: 1,
                data: Uint8Array.from(Buffer.from('6F1D2C3B4A594E8D9C7B0A1B2C3D4E5F', 'hex'))
            });
            writeFrame('frame', [
                new RecordBatch(
                    new Schema([field]),
                    makeData({ type: new Struct([field]), length: 1, children: [ids] })
                )
            ]);
            const { columns, rows } = await read('frame');

            assert.deepStrictEqual(
                { columns, rows },
                {
                    columns: [{ name: 'id', type: 'string', timezone: null }],
                    rows: [['6f1d2c3b-4a59-4e8d-9c7b-0a1b2c3d4e5f']]
                }
            );
        });
    });

    suite('paging', () => {
        const FRAME = [numbers(0, 1, 2), numbers(), numbers(3, 4), numbers(5, 6, 7)];

        test('answers the page in the response key order, reading across a record batch boundary', async () => {
            writeFrame('frame', FRAME);

            const page = await read('frame', 1, 2);

            assert.deepStrictEqual(Object.keys(page), [
                'referenceId',
                'rowCount',
                'columnCount',
                'pageIndex',
                'pageSize',
                'pageCount',
                'columns',
                'rows'
            ]);
            assert.deepStrictEqual(page, {
                referenceId: REFERENCE_ID,
                rowCount: 8,
                columnCount: 1,
                pageIndex: 1,
                pageSize: 2,
                pageCount: 4,
                columns: [{ name: 'n', type: 'integer', timezone: null }],
                rows: [[2], [3]]
            });
        });

        test('answers pages that end exactly on a record batch boundary, and a short last page', async () => {
            writeFrame('frame', FRAME);

            assert.deepStrictEqual((await read('frame', 0, 3)).rows, [[0], [1], [2]]);
            assert.deepStrictEqual((await read('frame', 1, 3)).rows, [[3], [4], [5]]);
            assert.deepStrictEqual((await read('frame', 2, 3)).rows, [[6], [7]]);
            assert.deepStrictEqual((await read('frame', 0, 1000)).rows, [[0], [1], [2], [3], [4], [5], [6], [7]]);
        });

        test('answers 400 for a pageIndex past the last page', async () => {
            writeFrame('frame', FRAME);

            assert.deepStrictEqual(await rejection(read('frame', 2, 5)), {
                status: 400,
                message: 'pageIndex 2 is out of range: the dataframe has 2 page(s) of 5 rows.'
            });
        });

        test('answers an empty frame as one empty page', async () => {
            writeFrame('empty', [numbers(), numbers()]);

            const page = await read('empty');

            assert.deepStrictEqual(page, {
                referenceId: REFERENCE_ID,
                rowCount: 0,
                columnCount: 1,
                pageIndex: 0,
                pageSize: 10,
                pageCount: 1,
                columns: [{ name: 'n', type: 'integer', timezone: null }],
                rows: []
            });
            assert.deepStrictEqual(await rejection(read('empty', 1)), {
                status: 400,
                message: 'pageIndex 1 is out of range: the dataframe has 1 page(s) of 10 rows.'
            });
        });

        test('reads only the record batches the page overlaps', async () => {
            writeFrame('frame', [numbers(0, 1, 2), numbers(3, 4), numbers(5)], {
                manifest: { file: `${REFERENCE_ID}.arrow`, rows: 6, batch_rows: [2, 2, 2] }
            });

            assert.deepStrictEqual((await read('frame', 1, 2)).rows, [[3], [4]]);
            assert.deepStrictEqual(await rejection(read('frame', 0, 2)), {
                status: 404,
                message: DATAFRAME_NOT_FOUND_MESSAGE
            });
        });
    });

    suite('storage', () => {
        // apache-arrow's writer stores a buffer uncompressed unless compressing makes it smaller.
        const COMPRESSIBLE = new Array<number>(1000).fill(7);

        test('reads a zstd frame written by deepnote-toolkit 2.9.1, ignoring the extra manifest keys', async () => {
            const page = await read('toolkit_frame', 0, 10, FIXTURE_PROJECT);

            assert.deepStrictEqual(page, {
                referenceId: '937dcee4-b07d-4ee0-9ee9-4793acaaf0a7',
                rowCount: 3,
                columnCount: 4,
                pageIndex: 0,
                pageSize: 10,
                pageCount: 1,
                columns: [
                    { name: 'id', type: 'int64', timezone: null },
                    { name: 'score', type: 'float', timezone: null },
                    { name: 'seen_at', type: 'timestamp', timezone: 'Europe/Prague' },
                    { name: 'label', type: 'string', timezone: null }
                ],
                rows: [
                    ['9007199254740993', 1.5, '2024-01-02T03:04:05.678Z', 'alpha'],
                    ['-7', null, '1969-12-31T23:59:59.999Z', null],
                    ['0', -0.25, null, 'žluťoučký']
                ]
            });
        });

        const missing: [string, () => void][] = [
            ['nothing is stored under the name', () => undefined],
            ['the manifest is not JSON', () => writeManifest('frame', '{"file":')],
            [
                "the manifest's file is not a lowercase UUID with .arrow",
                () => writeFrame('frame', [numbers(1)], { referenceId: REFERENCE_ID.toUpperCase() })
            ],
            [
                "the manifest's file is a path out of the frame's folder",
                () => {
                    writeFrame('other', [numbers(1)]);
                    writeManifest('frame', { file: `../other/${REFERENCE_ID}.arrow`, rows: 1, batch_rows: [1] });
                }
            ],
            [
                'the manifest has no batch_rows',
                () => writeFrame('frame', [numbers(1)], { manifest: { file: `${REFERENCE_ID}.arrow`, rows: 1 } })
            ],
            [
                "the manifest's batch_rows do not add up to its rows",
                () =>
                    writeFrame('frame', [numbers(1)], {
                        manifest: { file: `${REFERENCE_ID}.arrow`, rows: 2, batch_rows: [1] }
                    })
            ],
            [
                'the file the manifest names is missing',
                () => writeManifest('frame', { file: `${OTHER_REFERENCE_ID}.arrow`, rows: 1, batch_rows: [1] })
            ],
            [
                'the frame holds more record batches than batch_rows lists',
                () =>
                    writeFrame('frame', [numbers(1), numbers(2)], {
                        manifest: { file: `${REFERENCE_ID}.arrow`, rows: 1, batch_rows: [1] }
                    })
            ],
            [
                'a record batch holds another row count than its batch_rows entry',
                () =>
                    writeFrame('frame', [numbers(1)], {
                        manifest: { file: `${REFERENCE_ID}.arrow`, rows: 2, batch_rows: [2] }
                    })
            ]
        ];
        for (const [condition, store] of missing) {
            test(`answers 404 when ${condition}`, async () => {
                store();

                assert.deepStrictEqual(await rejection(read('frame')), {
                    status: 404,
                    message: DATAFRAME_NOT_FOUND_MESSAGE
                });
            });
        }

        test('reads a frame stored under $HOME/work when the project folder has none under its name', async () => {
            writeFrame('frame', [numbers(1, 2)]);
            moveFramesToHome();

            const page = await read('frame');

            assert.deepStrictEqual([page.referenceId, page.rows], [REFERENCE_ID, [[1], [2]]]);
        });

        test('reads a frame stored under the home folder Node reports when HOME is unset, as it usually is on Windows', async () => {
            getEnvironmentVariable.withArgs('HOME').returns(undefined);
            sinon.stub(os, 'homedir').returns(home);
            // The reader's named import of homedir follows os.homedir only once synced, here and after the restore.
            syncBuiltinESMExports();
            writeFrame('frame', [numbers(1, 2)]);
            moveFramesToHome();

            const page = await read('frame');

            assert.deepStrictEqual([page.referenceId, page.rows], [REFERENCE_ID, [[1], [2]]]);
        });

        test("reads the project folder's frame over one of the same name under $HOME/work", async () => {
            writeFrame('frame', [numbers(1)], { referenceId: OTHER_REFERENCE_ID });
            moveFramesToHome();
            writeFrame('frame', [numbers(2)]);

            const page = await read('frame');

            assert.deepStrictEqual([page.referenceId, page.rows], [REFERENCE_ID, [[2]]]);
        });

        test('answers 404 for an invalid manifest in the project folder, even when $HOME/work has the frame', async () => {
            writeFrame('frame', [numbers(1)]);
            moveFramesToHome();
            writeManifest('frame', '{"file":');

            assert.deepStrictEqual(await rejection(read('frame')), {
                status: 404,
                message: DATAFRAME_NOT_FOUND_MESSAGE
            });
        });

        test('answers 404 for a name that is not a single safe path segment', async () => {
            writeFrame('frame', [numbers(1)]);

            assert.deepStrictEqual(await rejection(read('../deepnote_dataframes/frame')), {
                status: 404,
                message: DATAFRAME_NOT_FOUND_MESSAGE
            });
        });

        test('reads the manifest again when the frame it named was replaced before the file was opened', async () => {
            writeFrame('frame', [numbers(1, 2)], { referenceId: OTHER_REFERENCE_ID });
            writeManifest('frame', { file: `${REFERENCE_ID}.arrow`, rows: 1, batch_rows: [1] });
            const realOpen = fsPromises.open;
            const open = sinon.stub(fsPromises, 'open').callThrough();
            open.onFirstCall().callsFake(async (...args: Parameters<typeof fsPromises.open>) => {
                writeManifest('frame', { file: `${OTHER_REFERENCE_ID}.arrow`, rows: 2, batch_rows: [2] });

                return realOpen(...args);
            });

            const page = await read('frame');

            assert.deepStrictEqual([page.referenceId, page.rows], [OTHER_REFERENCE_ID, [[1], [2]]]);
        });

        test('answers 422 for a frame compressed with lz4', async () => {
            writeFrame('frame', [numbers(...COMPRESSIBLE)], { compression: CompressionType.LZ4_FRAME });

            assert.deepStrictEqual(await rejection(read('frame')), {
                status: 422,
                message: LZ4_MESSAGE
            });
        });

        test("answers 422 for a zstd frame when the editor's Node.js has no zstd", async () => {
            writeFrame('frame', [numbers(...COMPRESSIBLE)], { compression: CompressionType.ZSTD });
            sinon.stub(zlib, 'zstdDecompressSync').value(undefined);

            assert.deepStrictEqual(await rejection(read('frame')), {
                status: 422,
                message: DeepnoteAppPreview.zstdUnavailable
            });
        });
    });
});
