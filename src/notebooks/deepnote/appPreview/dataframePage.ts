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
export const DATE_OUT_OF_RANGE_MESSAGE =
    'The page holds a date or timestamp outside the years 0 to 9999, which the server cannot format.';
export const LZ4_MESSAGE = 'The stored dataframe is compressed with lz4, which the server cannot decode.';
