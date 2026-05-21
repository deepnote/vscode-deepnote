// VENDORED from @deepnote/blocks bundled internals. None of these symbols are part of the
// package's public exports (verified against dist/index.d.ts). Track removal in
// /home/ubuntu/.claude/plans/look-at-the-pr-curious-toast.md Step 10 — once @deepnote/blocks
// exports them, delete this file and import directly.
// TODO(deepnote-followups): remove when @deepnote/blocks exports these helpers.

import type { DeepnoteBlock } from '@deepnote/blocks';
import { dedent } from 'ts-dedent';

/**
 * SQL block subtype of `DeepnoteBlock`. Vendored because `@deepnote/blocks`
 * does not currently export `SqlBlock` from its public API.
 *
 * TODO(deepnote-followups): replace with `import { SqlBlock } from '@deepnote/blocks'`
 * once exported upstream.
 */
export type SqlBlock = Extract<DeepnoteBlock, { type: 'sql' }>;

/**
 * Valid values for the `sql_cache_mode` argument of
 * `_dntk.execute_sql_with_connection_json`.
 *
 * TODO(deepnote-followups): remove when @deepnote/blocks exports this.
 */
export type SqlCacheMode = 'cache_disabled' | 'always_write' | 'read_or_write';

/**
 * Valid values for the `return_variable_type` argument of
 * `_dntk.execute_sql_with_connection_json`.
 *
 * TODO(deepnote-followups): remove when @deepnote/blocks exports this.
 */
export type SqlCellVariableType = 'dataframe' | 'query_preview';

/**
 * Mirror of `@deepnote/blocks`'s bundled-internal `escapePythonString`. Single-quotes
 * a string and escapes backslashes, single quotes, and newlines.
 *
 * Byte-identical to the upstream implementation at
 * `node_modules/@deepnote/blocks/dist/index.js`:
 *   `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`
 *
 * TODO(deepnote-followups): remove when @deepnote/blocks exports this.
 */
export function escapePythonString(value: string): string {
    return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`;
}

/**
 * Mirror of `@deepnote/blocks`'s bundled-internal `sanitizePythonVariableName`. Turns a
 * user-supplied identifier into a valid Python variable name:
 *   - replaces runs of whitespace with `_`
 *   - strips characters that are not `[0-9a-zA-Z_]`
 *   - strips a leading run of non-letter/underscore characters
 *   - returns `'input_1'` when the result is empty (matches upstream default)
 *
 * Differs from upstream by accepting `undefined` and returning `undefined` for it,
 * so call sites can pass `block.metadata.deepnote_variable_name` directly.
 *
 * TODO(deepnote-followups): remove when @deepnote/blocks exports this.
 */
export function sanitizePythonVariableName(name: string | undefined): string | undefined {
    if (name === undefined) {
        return undefined;
    }

    let sanitizedVariableName = name
        .replace(/\s+/g, '_')
        .replace(/[^0-9a-zA-Z_]/g, '')
        .replace(/^[^a-zA-Z_]+/g, '');

    if (sanitizedVariableName === '') {
        sanitizedVariableName = 'input_1';
    }

    return sanitizedVariableName;
}

/**
 * Mirror of `@deepnote/blocks`'s bundled-internal `createDataFrameConfig`. Produces a
 * two-line Python snippet that configures the dataframe formatter for the given
 * SQL block's table state.
 *
 * TODO(deepnote-followups): remove when @deepnote/blocks exports this.
 */
export function createDataFrameConfig(block: SqlBlock): string {
    const tableState = block.metadata?.deepnote_table_state ?? {};
    const tableStateAsJson = JSON.stringify(tableState);

    return dedent`
        if '_dntk' in globals():
          _dntk.dataframe_utils.configure_dataframe_formatter(${escapePythonString(tableStateAsJson)})
        else:
          _deepnote_current_table_attrs = ${escapePythonString(tableStateAsJson)}
    `;
}
