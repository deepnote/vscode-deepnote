import {
    Binary,
    Bool,
    CompressionType,
    compressionRegistry,
    DateDay,
    DateMillisecond,
    Decimal,
    Dictionary,
    Duration,
    Field,
    FixedSizeBinary,
    FixedSizeList,
    Float16,
    Float64,
    Int32,
    Int64,
    Int8,
    IntervalDayTime,
    LargeBinary,
    LargeList,
    LargeUtf8,
    List,
    makeData,
    Map_,
    Null,
    RecordBatch,
    RecordBatchFileWriter,
    Schema,
    Struct,
    TimeMillisecond,
    TimeNanosecond,
    TimeSecond,
    TimestampMicrosecond,
    TimestampNanosecond,
    TimestampSecond,
    TimeUnit,
    Uint64,
    Utf8,
    Vector,
    vectorFromArray,
    type Data,
    type DataType
} from 'apache-arrow';
import { assert } from 'chai';
import * as fs from 'fs';
import fsPromises from 'fs/promises';
import * as os from 'os';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import zlib from 'zlib';

import * as path from '../../../platform/vscode-path/path';
import { EXTENSION_ROOT_DIR_FOR_TESTS } from '../../../test/constants.node';
import { DataframePageError, readStoredDataframePage } from './storedDataframePage.node';

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

function column(name: string, data: Data, metadata: Record<string, string> = {}): [Field, Data] {
    return [new Field(name, data.type, true, new Map(Object.entries(metadata))), data];
}

function vector(values: unknown[], type: DataType): Data {
    return vectorFromArray(values, type).data[0];
}

function recordBatch(...columns: [Field, Data][]): RecordBatch {
    const schema = new Schema(columns.map(([field]) => field));

    return new RecordBatch(
        schema,
        makeData({
            type: new Struct(schema.fields),
            length: columns[0][1].length,
            children: columns.map(([, data]) => data)
        })
    );
}

function numbers(...values: number[]): RecordBatch {
    return recordBatch(column('n', vector(values, new Int32())));
}

/** The little-endian 32-bit words of each value's two's complement, as Arrow stores a decimal. */
function decimalWords(values: bigint[], bitWidth: number): Uint32Array {
    const words = new Uint32Array((values.length * bitWidth) / 32);
    values.forEach((value, index) => {
        let bits = BigInt.asUintN(bitWidth, value);
        for (let word = 0; word < bitWidth / 32; word++) {
            words[(index * bitWidth) / 32 + word] = Number(bits & 0xffffffffn);
            bits >>= 32n;
        }
    });

    return words;
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

    setup(() => {
        projectFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-stored-dataframe-'));
    });

    teardown(() => {
        sinon.restore();
        fs.rmSync(projectFolder, { recursive: true, force: true });
    });

    function frameDirectory(name: string): string {
        return path.join(projectFolder, 'deepnote_dataframes', name);
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

    async function readColumnsAndRows(batch: RecordBatch): Promise<{ columns: unknown; rows: unknown }> {
        writeFrame('frame', [batch]);
        const { columns, rows } = await read('frame');

        return { columns, rows };
    }

    suite('encoding', () => {
        test('encodes 8- to 32-bit integers as numbers, 64-bit integers as decimal strings, and NaN and infinities as null', async () => {
            const batch = recordBatch(
                column('int8', vector([-128, 7, null], new Int8())),
                column('int64', vector([9007199254740993n, -1n, null], new Int64())),
                column(
                    'uint64',
                    makeData({ type: new Uint64(), length: 3, data: BigUint64Array.of(2n ** 64n - 1n, 0n, 1n) })
                ),
                column('float64', vector([1.5, NaN, null], new Float64())),
                column('float16', vector([0.5, Infinity, -Infinity], new Float16()))
            );

            assert.deepStrictEqual(await readColumnsAndRows(batch), {
                columns: [
                    { name: 'int8', type: 'integer', timezone: null },
                    { name: 'int64', type: 'int64', timezone: null },
                    { name: 'uint64', type: 'int64', timezone: null },
                    { name: 'float64', type: 'float', timezone: null },
                    { name: 'float16', type: 'float', timezone: null }
                ],
                rows: [
                    [-128, '9007199254740993', '18446744073709551615', 1.5, 0.5],
                    [7, '-1', '0', null, null],
                    [null, null, '1', null, null]
                ]
            });
        });

        test('encodes booleans, strings, null columns, and dictionary columns by their values', async () => {
            const batch = recordBatch(
                column('bool', vector([true, false, null], new Bool())),
                column('utf8', vector(['a', null, 'ž'], new Utf8())),
                column('large_utf8', vector(['x', 'y', null], new LargeUtf8())),
                column('null', makeData({ type: new Null(), length: 3 })),
                column('dictionary', vector(['b', 'b', null], new Dictionary(new Utf8(), new Int32()))),
                column(
                    'dictionary_timestamp',
                    makeData({
                        type: new Dictionary(new TimestampNanosecond(), new Int32()),
                        length: 3,
                        data: Int32Array.of(1, 0, 1),
                        dictionary: new Vector([
                            makeData({ type: new TimestampNanosecond(), length: 2, data: BigInt64Array.of(-500n, 0n) })
                        ])
                    })
                )
            );

            assert.deepStrictEqual(await readColumnsAndRows(batch), {
                columns: [
                    { name: 'bool', type: 'boolean', timezone: null },
                    { name: 'utf8', type: 'string', timezone: null },
                    { name: 'large_utf8', type: 'string', timezone: null },
                    { name: 'null', type: 'null', timezone: null },
                    { name: 'dictionary', type: 'string', timezone: null },
                    { name: 'dictionary_timestamp', type: 'timestamp', timezone: null }
                ],
                rows: [
                    [true, 'a', 'x', null, 'b', '1970-01-01T00:00:00.000'],
                    [false, null, 'y', null, 'b', '1969-12-31T23:59:59.999'],
                    [null, 'ž', null, null, null, '1970-01-01T00:00:00.000']
                ]
            });
        });

        test('encodes an arrow.uuid as a lowercase UUID, and other binary values as padded base64', async () => {
            // A column of its own bytes each: apache-arrow's writer garbles a column that shares another's buffer.
            const sixteenBytes = () =>
                makeData({
                    type: new FixedSizeBinary(16),
                    length: 1,
                    data: Uint8Array.from(Buffer.from('0B5C1F2E3D4A4B6C8D7E9F0A1B2C3D4E', 'hex'))
                });
            const batch = recordBatch(
                column('uuid', sixteenBytes(), { 'ARROW:extension:name': 'arrow.uuid' }),
                column('fixed', sixteenBytes()),
                column('binary', vector([Uint8Array.of(0xfb, 0xff)], new Binary())),
                column('large_binary', vector([Uint8Array.of(1)], new LargeBinary()))
            );

            assert.deepStrictEqual(await readColumnsAndRows(batch), {
                columns: [
                    { name: 'uuid', type: 'string', timezone: null },
                    { name: 'fixed', type: 'binary', timezone: null },
                    { name: 'binary', type: 'binary', timezone: null },
                    { name: 'large_binary', type: 'binary', timezone: null }
                ],
                rows: [['0b5c1f2e-3d4a-4b6c-8d7e-9f0a1b2c3d4e', 'C1wfLj1KS2yNfp8KGyw9Tg==', '+/8=', 'AQ==']]
            });
        });

        test('encodes decimals as plain strings with exactly the scale of fraction digits', async () => {
            const decimal = (scale: number, precision: number, bitWidth: number, values: bigint[]) =>
                makeData({
                    type: new Decimal(scale, precision, bitWidth),
                    length: values.length,
                    data: decimalWords(values, bitWidth)
                });
            const batch = recordBatch(
                column('scale_2', decimal(2, 38, 128, [12345n, 0n, -1n])),
                column('scale_7', decimal(7, 18, 64, [-5n, 10_000_000n, 1n])),
                column('scale_minus_2', decimal(-2, 9, 32, [12n, 0n, -3n])),
                column('wide', decimal(0, 76, 256, [2n ** 200n, -(2n ** 200n), 7n]))
            );

            assert.deepStrictEqual(await readColumnsAndRows(batch), {
                columns: [
                    { name: 'scale_2', type: 'decimal', timezone: null },
                    { name: 'scale_7', type: 'decimal', timezone: null },
                    { name: 'scale_minus_2', type: 'decimal', timezone: null },
                    { name: 'wide', type: 'decimal', timezone: null }
                ],
                rows: [
                    ['123.45', '-0.0000005', '1200', '1606938044258990275541962092341162602522202993782792835301376'],
                    ['0.00', '1.0000000', '0', '-1606938044258990275541962092341162602522202993782792835301376'],
                    ['-0.01', '0.0000001', '-300', '7']
                ]
            });
        });

        test('encodes dates as UTC days, and timestamps floored to milliseconds, with Z only when zoned', async () => {
            const batch = recordBatch(
                column('date32', makeData({ type: new DateDay(), length: 2, data: Int32Array.of(0, 19_723) })),
                column(
                    'date64',
                    makeData({ type: new DateMillisecond(), length: 2, data: BigInt64Array.of(-1n, 86_400_000n) })
                ),
                column(
                    'nanoseconds',
                    makeData({
                        type: new TimestampNanosecond(),
                        length: 2,
                        data: BigInt64Array.of(-500n, 1_735_689_604_123_999_999n)
                    })
                ),
                column(
                    'microseconds_zoned',
                    makeData({
                        type: new TimestampMicrosecond('America/New_York'),
                        length: 2,
                        data: BigInt64Array.of(0n, 253_402_300_799_999_999n)
                    })
                ),
                column(
                    'seconds',
                    makeData({
                        type: new TimestampSecond(),
                        length: 2,
                        data: BigInt64Array.of(1_700_000_000n, -62_167_219_200n)
                    })
                )
            );

            assert.deepStrictEqual(await readColumnsAndRows(batch), {
                columns: [
                    { name: 'date32', type: 'date', timezone: null },
                    { name: 'date64', type: 'date', timezone: null },
                    { name: 'nanoseconds', type: 'timestamp', timezone: null },
                    { name: 'microseconds_zoned', type: 'timestamp', timezone: 'America/New_York' },
                    { name: 'seconds', type: 'timestamp', timezone: null }
                ],
                rows: [
                    [
                        '1970-01-01',
                        '1969-12-31',
                        '1969-12-31T23:59:59.999',
                        '1970-01-01T00:00:00.000Z',
                        '2023-11-14T22:13:20.000'
                    ],
                    [
                        '2024-01-01',
                        '1970-01-02',
                        '2025-01-01T00:00:04.123',
                        '9999-12-31T23:59:59.999Z',
                        '0000-01-01T00:00:00.000'
                    ]
                ]
            });
        });

        test('encodes times truncated to milliseconds without wrapping the hours, and durations as seconds', async () => {
            const batch = recordBatch(
                column('time_seconds', makeData({ type: new TimeSecond(), length: 2, data: Int32Array.of(90_061, 0) })),
                column(
                    'time_milliseconds',
                    makeData({ type: new TimeMillisecond(), length: 2, data: Int32Array.of(45_296_789, 1) })
                ),
                column(
                    'time_nanoseconds',
                    makeData({ type: new TimeNanosecond(), length: 2, data: BigInt64Array.of(1_999_999n, 999_999n) })
                ),
                column(
                    'duration_milliseconds',
                    makeData({
                        type: new Duration(TimeUnit.MILLISECOND),
                        length: 2,
                        data: BigInt64Array.of(1500n, -1n)
                    })
                ),
                column(
                    'duration_nanoseconds',
                    makeData({ type: new Duration(TimeUnit.NANOSECOND), length: 2, data: BigInt64Array.of(3n, 0n) })
                )
            );

            assert.deepStrictEqual(await readColumnsAndRows(batch), {
                columns: [
                    { name: 'time_seconds', type: 'time', timezone: null },
                    { name: 'time_milliseconds', type: 'time', timezone: null },
                    { name: 'time_nanoseconds', type: 'time', timezone: null },
                    { name: 'duration_milliseconds', type: 'duration', timezone: null },
                    { name: 'duration_nanoseconds', type: 'duration', timezone: null }
                ],
                rows: [
                    ['25:01:01.000', '12:34:56.789', '00:00:00.001', 1.5, 3e-9],
                    ['00:00:00.000', '00:00:00.001', '00:00:00.000', -0.001, 0]
                ]
            });
        });

        test('encodes lists as arrays, structs as objects in field order, and maps as key-value pairs, with each value by its type', async () => {
            const timestamps = new Field('item', new TimestampNanosecond('UTC'), true);
            const structFields = [new Field('z', new Int64(), true), new Field('a', new List(timestamps), true)];
            const batch = recordBatch(
                column('list', vector([[1, null], [], null], new List(new Field('item', new Int32(), true)))),
                column(
                    'large_list',
                    vector([['a'], ['b', 'c'], []], new LargeList(new Field('item', new Utf8(), true)))
                ),
                column(
                    'fixed_list',
                    vector([[1.5, NaN], null, [0, 2]], new FixedSizeList(2, new Field('item', new Float64(), true)))
                ),
                column(
                    'struct',
                    makeData({
                        type: new Struct(structFields),
                        length: 3,
                        nullCount: 1,
                        nullBitmap: Uint8Array.of(0b011),
                        children: [
                            vector([1n, null, 0n], new Int64()),
                            makeData({
                                type: new List(timestamps),
                                length: 3,
                                valueOffsets: Int32Array.of(0, 1, 1, 1),
                                child: makeData({
                                    type: timestamps.type,
                                    length: 1,
                                    data: BigInt64Array.of(-500n)
                                })
                            })
                        ]
                    })
                ),
                column(
                    'map',
                    vector(
                        [
                            new Map([
                                [2n, 1.5],
                                [1n, NaN]
                            ]),
                            new Map(),
                            null
                        ],
                        new Map_(
                            new Field(
                                'entries',
                                new Struct<{ key: Int64; value: Float64 }>([
                                    new Field('key', new Int64(), false),
                                    new Field('value', new Float64(), true)
                                ]),
                                false
                            )
                        )
                    )
                )
            );

            assert.deepStrictEqual(await readColumnsAndRows(batch), {
                columns: [
                    { name: 'list', type: 'list', timezone: null },
                    { name: 'large_list', type: 'list', timezone: null },
                    { name: 'fixed_list', type: 'list', timezone: null },
                    { name: 'struct', type: 'struct', timezone: null },
                    { name: 'map', type: 'map', timezone: null }
                ],
                rows: [
                    [
                        [1, null],
                        ['a'],
                        [1.5, null],
                        { z: '1', a: ['1969-12-31T23:59:59.999Z'] },
                        [
                            ['2', 1.5],
                            ['1', null]
                        ]
                    ],
                    [[], ['b', 'c'], null, { z: null, a: [] }, []],
                    [null, [], [0, 2], null, null]
                ]
            });
        });

        test('answers 422 for a column type it has no encoding for, also nested in another type', async () => {
            writeFrame('top', [recordBatch(column('interval', vector([], new IntervalDayTime())))]);
            writeFrame('nested', [
                recordBatch(
                    column('list', vector([], new List(new Field('item', new IntervalDayTime(), true)))),
                    column('ok', vector([], new Int32()))
                )
            ]);

            assert.deepStrictEqual(await rejection(read('top')), {
                status: 422,
                message: 'The dataframe has an unsupported column type Interval<DAY_TIME>.'
            });
            assert.deepStrictEqual(await rejection(read('nested')), {
                status: 422,
                message: 'The dataframe has an unsupported column type Interval<DAY_TIME>.'
            });
        });

        const outOfRange: [string, Data, unknown[][]][] = [
            [
                'a date in the year 10000',
                makeData({ type: new DateDay(), length: 2, data: Int32Array.of(0, 2_932_897) }),
                [['1970-01-01']]
            ],
            [
                'a timestamp before the year 0',
                makeData({ type: new TimestampSecond(), length: 2, data: BigInt64Array.of(0n, -62_167_219_201n) }),
                [['1970-01-01T00:00:00.000']]
            ]
        ];
        for (const [condition, data, firstPage] of outOfRange) {
            test(`answers 422 for a page that holds ${condition}, and serves the pages without it`, async () => {
                writeFrame('frame', [recordBatch(column('when', data))]);

                assert.deepStrictEqual((await read('frame', 0, 1)).rows, firstPage);
                assert.deepStrictEqual(await rejection(read('frame', 1, 1)), {
                    status: 422,
                    message:
                        'The page holds a date or timestamp outside the years 0 to 9999, which the server cannot format.'
                });
            });
        }
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
                message: 'Dataframe not found'
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
                    message: 'Dataframe not found'
                });
            });
        }

        test('answers 404 for a name that is not a single safe path segment', async () => {
            writeFrame('frame', [numbers(1)]);

            assert.deepStrictEqual(await rejection(read('../deepnote_dataframes/frame')), {
                status: 404,
                message: 'Dataframe not found'
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
                message: 'The stored dataframe is compressed with lz4, which the server cannot decode.'
            });
        });

        test("answers 422 for a zstd frame when the editor's Node.js has no zstd", async () => {
            writeFrame('frame', [numbers(...COMPRESSIBLE)], { compression: CompressionType.ZSTD });
            sinon.stub(zlib, 'zstdDecompressSync').value(undefined);

            assert.deepStrictEqual(await rejection(read('frame')), {
                status: 422,
                message:
                    "The editor's Node.js cannot decompress the stored dataframe, which is compressed with zstd. Update the editor to read it."
            });
        });
    });
});
