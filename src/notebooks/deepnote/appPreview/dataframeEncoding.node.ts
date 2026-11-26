import {
    DataType,
    DateUnit,
    Int64,
    TimeUnit,
    Type,
    Vector,
    type Data,
    type Decimal,
    type Field,
    type FixedSizeList,
    type LargeList,
    type List,
    type MapRow,
    type RecordBatch,
    type StructRow,
    type Timestamp
} from 'apache-arrow';

import {
    DATE_OUT_OF_RANGE_MESSAGE,
    DataframePageError,
    type DataframeColumn,
    type DataframeColumnType
} from './dataframePage';

const UUID_EXTENSION_KEY = 'ARROW:extension:name';
const UUID_EXTENSION = 'arrow.uuid';
const UUID_BYTES = 16;
// Past these years toISOString switches to signed six-digit years.
const MIN_FORMATTED_YEAR = 0;
const MAX_FORMATTED_YEAR = 9999;
const MILLISECONDS_PER_HOUR = 3_600_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const NANOSECONDS_PER_UNIT: Record<TimeUnit, bigint> = {
    [TimeUnit.SECOND]: NANOSECONDS_PER_SECOND,
    [TimeUnit.MILLISECOND]: NANOSECONDS_PER_MILLISECOND,
    [TimeUnit.MICROSECOND]: 1_000n,
    [TimeUnit.NANOSECOND]: 1n
};
const TEXT_TYPES = new Set([Type.Utf8, Type.LargeUtf8, Type.Utf8View]);
const BINARY_TYPES = new Set([Type.Binary, Type.LargeBinary, Type.BinaryView, Type.FixedSizeBinary]);
const LIST_TYPES = new Set([Type.List, Type.LargeList, Type.FixedSizeList]);

function columnType(field: Field): DataframeColumnType {
    // The Arrow format allows 64-bit dictionary indices, which apache-arrow decodes as bigints that its value getters
    // throw on, although its TKeys type leaves them out.
    if (DataType.isDictionary(field.type) && field.type.indices.bitWidth > 32) {
        throw new DataframePageError(422, `The dataframe has an unsupported column type ${String(field.type)}.`);
    }
    const type = valueType(field.type);
    // `children` is declared as an array, yet it is null on a type that has none.
    (type.children ?? []).forEach(columnType);

    if (DataType.isNull(type)) {
        return 'null';
    }
    if (DataType.isInt(type)) {
        return type.bitWidth === 64 ? 'int64' : 'integer';
    }
    if (DataType.isFloat(type)) {
        return 'float';
    }
    if (DataType.isBool(type)) {
        return 'boolean';
    }
    if (isText(type) || isUuid(field)) {
        return 'string';
    }
    if (isBinary(type)) {
        return 'binary';
    }
    if (DataType.isDecimal(type)) {
        return 'decimal';
    }
    if (DataType.isDate(type)) {
        return 'date';
    }
    if (DataType.isTimestamp(type)) {
        return 'timestamp';
    }
    if (DataType.isTime(type)) {
        return 'time';
    }
    if (DataType.isDuration(type)) {
        return 'duration';
    }
    if (isList(type)) {
        return 'list';
    }
    if (DataType.isStruct(type)) {
        if (new Set(type.children.map(({ name }) => name)).size < type.children.length) {
            throw new DataframePageError(
                422,
                `The dataframe has a struct with two fields of the same name, ${String(type)}.`
            );
        }
        return 'struct';
    }
    if (DataType.isMap(type)) {
        return 'map';
    }
    throw new DataframePageError(422, `The dataframe has an unsupported column type ${String(type)}.`);
}

function encodeValue(value: unknown, field: Field): unknown {
    if (value === null || value === undefined) {
        return null;
    }

    const type = valueType(field.type);
    if (DataType.isInt(type)) {
        return type.bitWidth === 64 ? String(value) : value;
    }
    if (DataType.isFloat(type)) {
        return Number.isFinite(value) ? value : null;
    }
    if (isUuid(field)) {
        return formatUuid(value as Uint8Array);
    }
    if (isBinary(type)) {
        return Buffer.from(value as Uint8Array).toString('base64');
    }
    if (DataType.isDecimal(type)) {
        return formatDecimal(value as Uint32Array, type);
    }
    if (DataType.isDate(type)) {
        return isoString(Number(value)).slice(0, 10);
    }
    if (DataType.isTimestamp(type)) {
        return formatTimestamp(value as bigint, type);
    }
    if (DataType.isTime(type)) {
        const nanoseconds = BigInt(value as number | bigint) * NANOSECONDS_PER_UNIT[type.unit];

        return formatTime(Number(nanoseconds / NANOSECONDS_PER_MILLISECOND));
    }
    if (DataType.isDuration(type)) {
        return Number(value) / Number(NANOSECONDS_PER_SECOND / NANOSECONDS_PER_UNIT[type.unit]);
    }
    if (isList(type)) {
        return Array.from(value as Vector, (item) => encodeValue(item, type.children[0]));
    }
    if (DataType.isStruct(type)) {
        return Object.fromEntries(
            Array.from(value as StructRow, ([name, child], index) => [name, encodeValue(child, type.children[index])])
        );
    }
    if (DataType.isMap(type)) {
        const [keyField, valueField] = type.children[0].type.children;

        return Array.from(value as MapRow, ([key, item]) => [
            encodeValue(key, keyField),
            encodeValue(item, valueField)
        ]);
    }

    return value;
}

function floorDivide(dividend: bigint, divisor: bigint): bigint {
    const quotient = dividend / divisor;

    return dividend % divisor < 0n ? quotient - 1n : quotient;
}

/** apache-arrow hands a decimal over as the 32-bit words, least significant first, of its unscaled two's complement. */
function formatDecimal(words: Uint32Array, type: Decimal): string {
    let bits = 0n;
    for (let index = words.length - 1; index >= 0; index--) {
        bits = (bits << 32n) + BigInt(words[index]);
    }
    const unscaled = BigInt.asIntN(type.bitWidth, bits);
    const sign = unscaled < 0n ? '-' : '';
    const magnitude = (unscaled < 0n ? -unscaled : unscaled).toString();
    if (type.scale <= 0) {
        return sign + magnitude + (unscaled === 0n ? '' : '0'.repeat(-type.scale));
    }
    const whole = magnitude.length > type.scale ? magnitude.slice(0, magnitude.length - type.scale) : '0';
    const fraction = magnitude.slice(-type.scale).padStart(type.scale, '0');

    return `${sign}${whole}.${fraction}`;
}

function formatTime(milliseconds: number): string {
    const hours = Math.floor(milliseconds / MILLISECONDS_PER_HOUR);
    // A time of day can pass 24 hours, so a Date formats only what follows the hours: `MM:SS.sss`.
    const rest = new Date(milliseconds % MILLISECONDS_PER_HOUR).toISOString().slice(14, 23);

    return `${String(hours).padStart(2, '0')}:${rest}`;
}

function formatTimestamp(value: bigint, type: Timestamp): string {
    const milliseconds = floorDivide(value * NANOSECONDS_PER_UNIT[type.unit], NANOSECONDS_PER_MILLISECOND);
    const iso = isoString(Number(milliseconds));

    return type.timezone ? iso : iso.slice(0, -1);
}

function formatUuid(bytes: Uint8Array): string {
    return Buffer.from(bytes)
        .toString('hex')
        .replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/, '$1-$2-$3-$4-$5');
}

function isBinary(type: DataType): boolean {
    return BINARY_TYPES.has(type.typeId);
}

function isList(type: DataType): type is List | LargeList | FixedSizeList {
    return LIST_TYPES.has(type.typeId);
}

function isoString(milliseconds: number): string {
    const date = new Date(milliseconds);
    const year = date.getUTCFullYear();
    if (!(year >= MIN_FORMATTED_YEAR && year <= MAX_FORMATTED_YEAR)) {
        throw new DataframePageError(422, DATE_OUT_OF_RANGE_MESSAGE);
    }

    return date.toISOString();
}

function isText(type: DataType): boolean {
    return TEXT_TYPES.has(type.typeId);
}

function isUuid(field: Field): boolean {
    const type = valueType(field.type);

    return (
        field.metadata.get(UUID_EXTENSION_KEY) === UUID_EXTENSION &&
        DataType.isFixedSizeBinary(type) &&
        type.byteWidth === UUID_BYTES
    );
}

function valueType(type: DataType): DataType {
    return DataType.isDictionary(type) ? type.dictionary : type;
}

/**
 * apache-arrow reads a timestamp or a Date64 as float milliseconds, which rounds sub-millisecond units and throws past
 * 2^53. Viewed as Int64, the same buffers read as the exact count of units.
 */
function withInt64Times(data: Data): Data {
    const isInt64Time =
        DataType.isTimestamp(data.type) || (DataType.isDate(data.type) && data.type.unit === DateUnit.MILLISECOND);
    const copy = data.clone(
        isInt64Time ? new Int64() : data.type,
        undefined,
        undefined,
        undefined,
        undefined,
        data.children.map(withInt64Times)
    );
    if (data.dictionary) {
        copy.dictionary = new Vector(data.dictionary.data.map(withInt64Times));
    }

    return copy;
}

/**
 * Describes a column as Deepnote's dataframe API lists it. Throws a 422 {@link DataframePageError} for a column, or a
 * type nested in it, that {@link encodeRows} cannot encode.
 */
export function describeColumn(field: Field): DataframeColumn {
    const type = valueType(field.type);

    return {
        name: field.name,
        type: columnType(field),
        timezone: DataType.isTimestamp(type) && type.timezone ? type.timezone : null
    };
}

/**
 * Encodes the rows `begin` to `end` (exclusive) of `batch` the way Deepnote's dataframe API serves values. `fields` are
 * the batch's columns, each already accepted by {@link describeColumn}, since encodeRows does not check types. For a
 * batch read from a file they are the reader's schema fields: apache-arrow rebuilds `batch.schema` by field name, which
 * gives the first of two same-named columns the other's type. Throws a 422 {@link DataframePageError} for a date or
 * timestamp outside the years 0 to 9999.
 */
export function encodeRows(batch: RecordBatch, fields: Field[], begin: number, end: number): unknown[][] {
    const columns = batch.data.children.map((data) => new Vector([withInt64Times(data)]));
    const rows: unknown[][] = [];
    for (let row = begin; row < end; row++) {
        rows.push(fields.map((field, column) => encodeValue(columns[column].get(row), field)));
    }

    return rows;
}
