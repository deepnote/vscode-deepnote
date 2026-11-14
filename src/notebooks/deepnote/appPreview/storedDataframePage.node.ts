import {
    CompressionType,
    compressionRegistry,
    DataType,
    DateUnit,
    Int64,
    RecordBatchReader,
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
import fs, { type FileHandle } from 'fs/promises';
import { Uri } from 'vscode';
import zlib from 'zlib';
import { z } from 'zod';

import { isFileNotFoundError } from '../../../platform/common/platform/errors';
import { DeepnoteAppPreview } from '../../../platform/common/utils/localize';

export type DataframeColumnType =
    | 'null'
    | 'integer'
    | 'int64'
    | 'float'
    | 'boolean'
    | 'string'
    | 'binary'
    | 'decimal'
    | 'date'
    | 'timestamp'
    | 'time'
    | 'duration'
    | 'list'
    | 'struct'
    | 'map';

export interface DataframeColumn {
    name: string;
    timezone: string | null;
    type: DataframeColumnType;
}

/** A page of a stored dataframe, as Deepnote's `GET /v2/projects/:projectId/dataframes/:name` answers it. */
export interface DataframePage {
    columnCount: number;
    columns: DataframeColumn[];
    pageCount: number;
    pageIndex: number;
    pageSize: number;
    referenceId: string;
    rowCount: number;
    rows: unknown[][];
}

/** A page that cannot be read, with the HTTP status Deepnote answers for it. */
export class DataframePageError extends Error {
    constructor(
        public readonly status: 400 | 404 | 422,
        message: string
    ) {
        super(message);
    }
}

/** The names deepnote-toolkit's `store_dataframe` accepts, so each is a single path segment. */
export const DATAFRAME_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Protocol strings: app code receives them, so they stay English like Deepnote's API messages.
export const DATAFRAME_NOT_FOUND_MESSAGE = 'Dataframe not found';
const DATE_OUT_OF_RANGE_MESSAGE =
    'The page holds a date or timestamp outside the years 0 to 9999, which the server cannot format.';
const LZ4_MESSAGE = 'The stored dataframe is compressed with lz4, which the server cannot decode.';

// deepnote-toolkit's FRAMES_DIR, relative to the project folder.
const DATAFRAMES_DIRECTORY = 'deepnote_dataframes';
const MANIFEST_FILE = 'manifest.json';
const FRAME_EXTENSION = '.arrow';
const FRAME_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.arrow$/;
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

const manifestSchema = z
    .object({
        file: z.string().regex(FRAME_FILE),
        rows: z.int().nonnegative(),
        batch_rows: z.array(z.int().nonnegative())
    })
    .refine((manifest) => manifest.batch_rows.reduce((sum, rows) => sum + rows, 0) === manifest.rows);

type Manifest = z.infer<typeof manifestSchema>;

interface PageRequest {
    pageIndex: number;
    pageSize: number;
}

function columnType(field: Field): DataframeColumnType {
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
        return 'struct';
    }
    if (DataType.isMap(type)) {
        return 'map';
    }
    throw new DataframePageError(422, `The dataframe has an unsupported column type ${String(type)}.`);
}

function decompressZstd(bytes: Uint8Array): Uint8Array {
    // zlib has zstd from Node.js 22.15 on, and older editors run an older Node.js.
    if (typeof zlib.zstdDecompressSync !== 'function') {
        throw new DataframePageError(422, DeepnoteAppPreview.zstdUnavailable);
    }

    return zlib.zstdDecompressSync(bytes);
}

function describeColumn(field: Field): DataframeColumn {
    const type = valueType(field.type);

    return {
        name: field.name,
        type: columnType(field),
        timezone: DataType.isTimestamp(type) && type.timezone ? type.timezone : null
    };
}

function encodeRows(batch: RecordBatch, fields: Field[], begin: number, end: number): unknown[][] {
    const columns = batch.data.children.map((data) => new Vector([withInt64Times(data)]));
    const rows: unknown[][] = [];
    for (let row = begin; row < end; row++) {
        rows.push(fields.map((field, column) => encodeValue(columns[column].get(row), field)));
    }

    return rows;
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

function notFound(): DataframePageError {
    return new DataframePageError(404, DATAFRAME_NOT_FOUND_MESSAGE);
}

async function readCurrentFrame(directory: Uri, page: PageRequest): Promise<DataframePage | undefined> {
    const manifest = await readManifest(directory);
    if (!manifest) {
        throw notFound();
    }
    const pageCount = Math.max(1, Math.ceil(manifest.rows / page.pageSize));
    if (page.pageIndex >= pageCount) {
        throw new DataframePageError(
            400,
            `pageIndex ${page.pageIndex} is out of range: the dataframe has ${pageCount} page(s) of ${page.pageSize} rows.`
        );
    }

    let handle: FileHandle;
    try {
        handle = await fs.open(Uri.joinPath(directory, manifest.file).fsPath, 'r');
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return undefined;
        }
        throw error;
    }
    try {
        return await readFramePage(handle, manifest, page, pageCount);
    } finally {
        await handle.close();
    }
}

async function readFramePage(
    handle: FileHandle,
    manifest: Manifest,
    { pageIndex, pageSize }: PageRequest,
    pageCount: number
): Promise<DataframePage> {
    const reader = await RecordBatchReader.from(handle);
    if (!reader.isFile()) {
        throw notFound();
    }
    await reader.open();
    if (reader.numRecordBatches !== manifest.batch_rows.length) {
        throw notFound();
    }
    const fields = reader.schema.fields;
    const columns = fields.map(describeColumn);

    const firstRow = pageIndex * pageSize;
    const endRow = Math.min(firstRow + pageSize, manifest.rows);
    const rows: unknown[][] = [];
    let batchStart = 0;
    for (const [index, batchRows] of manifest.batch_rows.entries()) {
        const batchEnd = batchStart + batchRows;
        if (batchRows > 0 && batchStart < endRow && batchEnd > firstRow) {
            const batch = await reader.readRecordBatch(index);
            if (batch?.numRows !== batchRows) {
                throw notFound();
            }
            const begin = Math.max(firstRow, batchStart) - batchStart;
            rows.push(...encodeRows(batch, fields, begin, Math.min(endRow, batchEnd) - batchStart));
        }
        batchStart = batchEnd;
    }

    return {
        referenceId: manifest.file.slice(0, -FRAME_EXTENSION.length),
        rowCount: manifest.rows,
        columnCount: fields.length,
        pageIndex,
        pageSize,
        pageCount,
        columns,
        rows
    };
}

async function readManifest(directory: Uri): Promise<Manifest | undefined> {
    let text: string;
    try {
        text = await fs.readFile(Uri.joinPath(directory, MANIFEST_FILE).fsPath, 'utf8');
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return undefined;
        }
        throw error;
    }

    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return undefined;
    }
    const parsed = manifestSchema.safeParse(json);

    return parsed.success ? parsed.data : undefined;
}

function refuseLz4(): never {
    throw new DataframePageError(422, LZ4_MESSAGE);
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
 * Reads one page of the dataframe that deepnote-toolkit's `store_dataframe` stored under `name` in `projectFolder`:
 * `deepnote_dataframes/<name>/manifest.json` names an Arrow IPC file beside it, of which only the record batches the
 * page overlaps are decoded. Throws a {@link DataframePageError}: 400 for a `pageIndex` past the last page, 404 for a
 * `name` outside {@link DATAFRAME_NAME_PATTERN} or a missing or invalid manifest or frame file, and 422 for a frame or
 * page that cannot be decompressed or encoded. Any other error, such as a corrupt record batch, propagates as it is.
 */
export async function readStoredDataframePage(
    projectFolder: Uri,
    name: string,
    page: PageRequest
): Promise<DataframePage> {
    if (!DATAFRAME_NAME_PATTERN.test(name)) {
        throw notFound();
    }
    // The registry is process-wide and `set` replaces a whole codec, so one registered elsewhere could stand in.
    compressionRegistry.set(CompressionType.ZSTD, { decode: decompressZstd });
    compressionRegistry.set(CompressionType.LZ4_FRAME, { decode: refuseLz4 });

    const directory = Uri.joinPath(projectFolder, DATAFRAMES_DIRECTORY, name);
    // A newer store may have replaced the frame, deleting its file, between reading the manifest and opening the file.
    const found = (await readCurrentFrame(directory, page)) ?? (await readCurrentFrame(directory, page));
    if (!found) {
        throw notFound();
    }

    return found;
}
