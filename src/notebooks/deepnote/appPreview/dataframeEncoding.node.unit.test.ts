import {
    Binary,
    Bool,
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

import { describeColumn, encodeRows } from './dataframeEncoding.node';
import { DataframePageError, DATE_OUT_OF_RANGE_MESSAGE } from './dataframePage';

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

function describeColumns(batch: RecordBatch): unknown {
    return batch.schema.fields.map(describeColumn);
}

function encode(batch: RecordBatch): { columns: unknown; rows: unknown } {
    return {
        columns: describeColumns(batch),
        rows: encodeRows(batch, batch.schema.fields, 0, batch.numRows)
    };
}

function failure(call: () => unknown): { status: number; message: string } {
    try {
        call();
    } catch (error) {
        assert.instanceOf(error, DataframePageError);

        return { status: error.status, message: error.message };
    }

    return assert.fail('the call did not throw');
}

suite('describeColumn and encodeRows', () => {
    test('encodes 8- to 32-bit integers as numbers, 64-bit integers as decimal strings, and NaN and infinities as null', () => {
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

        assert.deepStrictEqual(encode(batch), {
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

    test('encodes booleans, strings, null columns, and dictionary columns by their values', () => {
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

        assert.deepStrictEqual(encode(batch), {
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

    test('encodes an arrow.uuid as a lowercase UUID, and other binary values as padded base64', () => {
        const sixteenBytes = makeData({
            type: new FixedSizeBinary(16),
            length: 1,
            data: Uint8Array.from(Buffer.from('0B5C1F2E3D4A4B6C8D7E9F0A1B2C3D4E', 'hex'))
        });
        const batch = recordBatch(
            column('uuid', sixteenBytes, { 'ARROW:extension:name': 'arrow.uuid' }),
            column('fixed', sixteenBytes),
            column('binary', vector([Uint8Array.of(0xfb, 0xff)], new Binary())),
            column('large_binary', vector([Uint8Array.of(1)], new LargeBinary()))
        );

        assert.deepStrictEqual(encode(batch), {
            columns: [
                { name: 'uuid', type: 'string', timezone: null },
                { name: 'fixed', type: 'binary', timezone: null },
                { name: 'binary', type: 'binary', timezone: null },
                { name: 'large_binary', type: 'binary', timezone: null }
            ],
            rows: [['0b5c1f2e-3d4a-4b6c-8d7e-9f0a1b2c3d4e', 'C1wfLj1KS2yNfp8KGyw9Tg==', '+/8=', 'AQ==']]
        });
    });

    test('encodes decimals as plain strings with exactly the scale of fraction digits', () => {
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

        assert.deepStrictEqual(encode(batch), {
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

    test('encodes dates as UTC days, and timestamps floored to milliseconds, with Z only when zoned', () => {
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

        assert.deepStrictEqual(encode(batch), {
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

    test('encodes times truncated to milliseconds without wrapping the hours, and durations as seconds', () => {
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

        assert.deepStrictEqual(encode(batch), {
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

    test('encodes lists as arrays, structs as objects in field order, and maps as key-value pairs, with each value by its type', () => {
        const timestamps = new Field('item', new TimestampNanosecond('UTC'), true);
        const structFields = [new Field('z', new Int64(), true), new Field('a', new List(timestamps), true)];
        const batch = recordBatch(
            column('list', vector([[1, null], [], null], new List(new Field('item', new Int32(), true)))),
            column('large_list', vector([['a'], ['b', 'c'], []], new LargeList(new Field('item', new Utf8(), true)))),
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

        assert.deepStrictEqual(encode(batch), {
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

    test('throws a 422 for a column type it has no encoding for, also nested in another type', () => {
        const top = recordBatch(column('interval', vector([], new IntervalDayTime())));
        const nested = recordBatch(
            column('list', vector([], new List(new Field('item', new IntervalDayTime(), true)))),
            column('ok', vector([], new Int32()))
        );

        assert.deepStrictEqual(
            failure(() => describeColumns(top)),
            {
                status: 422,
                message: 'The dataframe has an unsupported column type Interval<DAY_TIME>.'
            }
        );
        assert.deepStrictEqual(
            failure(() => describeColumns(nested)),
            {
                status: 422,
                message: 'The dataframe has an unsupported column type Interval<DAY_TIME>.'
            }
        );
    });

    test('throws a 422 for a struct with two fields of the same name, also nested in another type', () => {
        const duplicates = new Struct([new Field('a', new Int64(), true), new Field('a', new Int64(), true)]);
        const top = recordBatch(column('struct', vector([], duplicates)));
        const nested = recordBatch(column('list', vector([], new List(new Field('item', duplicates, true)))));

        assert.deepStrictEqual(
            failure(() => describeColumns(top)),
            {
                status: 422,
                message: 'The dataframe has a struct with two fields of the same name, Struct<{a:Int64, a:Int64}>.'
            }
        );
        assert.deepStrictEqual(
            failure(() => describeColumns(nested)),
            {
                status: 422,
                message: 'The dataframe has a struct with two fields of the same name, Struct<{a:Int64, a:Int64}>.'
            }
        );
    });

    test('throws a 422 for a dictionary with 64-bit indices, also nested in another type', () => {
        // apache-arrow's TKeys leaves out the 64-bit indices the Arrow format allows and its reader decodes.
        const signed = new Dictionary<Utf8, any>(new Utf8(), new Int64());
        const unsigned = new Dictionary<Utf8, any>(new Utf8(), new Uint64());

        assert.deepStrictEqual(
            failure(() => describeColumns(recordBatch(column('dictionary', vector([], signed))))),
            {
                status: 422,
                message: 'The dataframe has an unsupported column type Dictionary<Int64, Utf8>.'
            }
        );
        assert.deepStrictEqual(
            failure(() => describeColumns(recordBatch(column('dictionary', vector([], unsigned))))),
            {
                status: 422,
                message: 'The dataframe has an unsupported column type Dictionary<Uint64, Utf8>.'
            }
        );
        assert.deepStrictEqual(
            failure(() =>
                describeColumns(recordBatch(column('list', vector([], new List(new Field('item', signed, true))))))
            ),
            {
                status: 422,
                message: 'The dataframe has an unsupported column type Dictionary<Int64, Utf8>.'
            }
        );
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
    for (const [condition, data, firstRows] of outOfRange) {
        test(`throws a 422 for rows that hold ${condition}, and encodes the rows without it`, () => {
            const batch = recordBatch(column('when', data));
            const fields = batch.schema.fields;

            assert.deepStrictEqual(encodeRows(batch, fields, 0, 1), firstRows);
            assert.deepStrictEqual(
                failure(() => encodeRows(batch, fields, 1, 2)),
                { status: 422, message: DATE_OUT_OF_RANGE_MESSAGE }
            );
        });
    }
});
