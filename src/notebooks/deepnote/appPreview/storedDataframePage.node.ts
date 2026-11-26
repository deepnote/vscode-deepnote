import { CompressionType, compressionRegistry, RecordBatchReader } from 'apache-arrow';
import fs, { type FileHandle } from 'fs/promises';
import { homedir } from 'os';
import { Uri } from 'vscode';
import zlib from 'zlib';
import { z } from 'zod';

import { isFileNotFoundError } from '../../../platform/common/platform/errors';
import { DeepnoteAppPreview } from '../../../platform/common/utils/localize';
import { getEnvironmentVariable } from '../../../platform/common/utils/platform.node';
import { describeColumn, encodeRows } from './dataframeEncoding.node';
import {
    DATAFRAME_NAME_PATTERN,
    DATAFRAME_NOT_FOUND_MESSAGE,
    DataframePageError,
    LZ4_MESSAGE,
    type DataframePage
} from './dataframePage';

// deepnote-toolkit's FRAMES_DIR, relative to the folder it stores frames under.
const DATAFRAMES_DIRECTORY = 'deepnote_dataframes';
const MANIFEST_FILE = 'manifest.json';
const FRAME_EXTENSION = '.arrow';
const FRAME_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.arrow$/;

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

function decompressZstd(bytes: Uint8Array): Uint8Array {
    // zlib has zstd from Node.js 22.15 on, and older editors run an older Node.js.
    if (typeof zlib.zstdDecompressSync !== 'function') {
        throw new DataframePageError(422, DeepnoteAppPreview.zstdUnavailable);
    }

    return zlib.zstdDecompressSync(bytes);
}

/**
 * Falls back to `$HOME/work` because deepnote-toolkit 2.9.1 stores frames there when nothing sets its notebook root,
 * and the extension's servers set none. Drop the fallback once the toolkit reads a storage root the extension sets.
 * HOME comes first, as in the toolkit, because Node's homedir() reads USERPROFILE on Windows.
 */
async function frameDirectory(projectFolder: Uri, name: string): Promise<Uri> {
    const inProject = Uri.joinPath(projectFolder, DATAFRAMES_DIRECTORY, name);
    try {
        await fs.stat(Uri.joinPath(inProject, MANIFEST_FILE).fsPath);

        return inProject;
    } catch (error) {
        if (!isFileNotFoundError(error)) {
            throw error;
        }
    }

    return Uri.joinPath(Uri.file(getEnvironmentVariable('HOME') || homedir()), 'work', DATAFRAMES_DIRECTORY, name);
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

/**
 * Reads one page of the dataframe that deepnote-toolkit's `store_dataframe` stored under `name` in `projectFolder`, or,
 * when that folder holds no manifest for `name`, in `$HOME/work`, where the toolkit stores frames by default:
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

    const directory = await frameDirectory(projectFolder, name);
    // A newer store may have replaced the frame, deleting its file, between reading the manifest and opening the file.
    const found = (await readCurrentFrame(directory, page)) ?? (await readCurrentFrame(directory, page));
    if (!found) {
        throw notFound();
    }

    return found;
}
