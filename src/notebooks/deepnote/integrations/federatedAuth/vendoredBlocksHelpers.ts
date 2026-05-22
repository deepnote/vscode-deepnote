// VENDORED from @deepnote/blocks bundled internals. None of these symbols are part of the
// package's public exports (verified against dist/index.d.ts). Track removal in
// /home/ubuntu/.claude/plans/look-at-the-pr-curious-toast.md Step 10 — once @deepnote/blocks
// exports them, delete this file and import directly.
// TODO(deepnote-followups): remove when @deepnote/blocks exports these helpers.

import type { DeepnoteBlock } from '@deepnote/blocks';
import { dedent } from 'ts-dedent';

/**
 * SQL block subtype. Vendored because `@deepnote/blocks` does not export `SqlBlock`.
 * TODO(deepnote-followups): replace with `import { SqlBlock } from '@deepnote/blocks'` once exported upstream.
 */
export type SqlBlock = Extract<DeepnoteBlock, { type: 'sql' }>;

/**
 * Valid `sql_cache_mode` values for `_dntk.execute_sql_with_connection_json`.
 * TODO(deepnote-followups): remove when @deepnote/blocks exports this.
 */
export type SqlCacheMode = 'cache_disabled' | 'always_write' | 'read_or_write';

/**
 * Valid `return_variable_type` values for `_dntk.execute_sql_with_connection_json`.
 * TODO(deepnote-followups): remove when @deepnote/blocks exports this.
 */
export type SqlCellVariableType = 'dataframe' | 'query_preview';

/**
 * Mirror of upstream's bundled-internal `escapePythonString`: single-quotes the string and escapes `\`, `'`, `\n`.
 * TODO(deepnote-followups): remove when @deepnote/blocks exports this.
 */
export function escapePythonString(value: string): string {
    return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`;
}

/**
 * Mirror of upstream's `sanitizePythonVariableName` (whitespace→`_`, strips non-identifier chars, fallback `'input_1'`).
 * Differs from upstream by accepting `undefined` and returning `undefined`.
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
 * Mirror of upstream's `createDataFrameConfig`: produces a two-branch Python snippet configuring the dataframe formatter.
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
