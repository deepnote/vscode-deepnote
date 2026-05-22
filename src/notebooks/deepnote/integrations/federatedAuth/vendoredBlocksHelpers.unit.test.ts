import { createPythonCode } from '@deepnote/blocks';
import { assert } from 'chai';

import {
    createDataFrameConfig,
    escapePythonString,
    sanitizePythonVariableName,
    SqlBlock
} from './vendoredBlocksHelpers';
import { parsePythonSingleQuoted } from './federatedAuthTestHelpers';

suite('vendoredBlocksHelpers', () => {
    suite('escapePythonString', () => {
        test('handles a mixed input combining backslash, quote, and newline', () => {
            const input = `a\\b'c\nd`;
            // `\\` → `\\\\`, `'` → `\'`, `\n` → `\\n`.
            assert.strictEqual(escapePythonString(input), "'a\\\\b\\'c\\nd'");
        });

        test('does not escape tabs', () => {
            // Upstream only escapes `\`, `'`, `\n`; tabs pass through verbatim.
            assert.strictEqual(escapePythonString('a\tb'), "'a\tb'");
        });

        test('output, when interpreted as a Python single-quoted literal, round-trips back to the original SQL query', () => {
            // Catches: a future change adding an extra escape (e.g. `\t`/`\r`) without updating the inverse mapping, breaking SQL queries at runtime.
            const queries = [
                "SELECT 'a''b' AS x",
                'SELECT * FROM t WHERE path = "C:\\Users\\me"',
                'SELECT\n  *\nFROM\n  table',
                "SELECT 'café' AS greeting, '世界' AS world",
                "SELECT 'a\\b' AS literal_backslash",
                ''
            ];
            for (const query of queries) {
                const escaped = escapePythonString(query);
                assert.strictEqual(
                    parsePythonSingleQuoted(escaped),
                    query,
                    `round-trip failed for: ${JSON.stringify(query)}`
                );
            }
        });
    });

    suite('sanitizePythonVariableName', () => {
        test('returns undefined for undefined input', () => {
            assert.strictEqual(sanitizePythonVariableName(undefined), undefined);
        });

        test('falls back to "input_1" for an empty string', () => {
            assert.strictEqual(sanitizePythonVariableName(''), 'input_1');
        });

        test('strips leading non-identifier characters but keeps a following underscore', () => {
            // Upstream strips `[^a-zA-Z_]+` from the start, so `123_foo` → `_foo` (underscore is a valid leading char) and `1abc` → `abc`.
            assert.strictEqual(sanitizePythonVariableName('1abc'), 'abc');
            assert.strictEqual(sanitizePythonVariableName('123_foo'), '_foo');
        });

        test('converts whitespace to underscores', () => {
            assert.strictEqual(sanitizePythonVariableName('my var'), 'my_var');
        });

        test('strips hyphens and dots', () => {
            assert.strictEqual(sanitizePythonVariableName('my-var.name'), 'myvarname');
        });

        test('passes a valid identifier through unchanged', () => {
            assert.strictEqual(sanitizePythonVariableName('valid_name_1'), 'valid_name_1');
        });

        test('preserves a leading underscore', () => {
            assert.strictEqual(sanitizePythonVariableName('_hidden'), '_hidden');
        });

        test('falls back to "input_1" when only invalid chars are present', () => {
            // Upstream behavior: '-' is stripped, then nothing remains, so fallback applies.
            assert.strictEqual(sanitizePythonVariableName('---'), 'input_1');
        });

        test('collapses an all-whitespace string to a single underscore', () => {
            // Catches: a future upstream change to the `\s+` → `_` step (e.g. `\W+`) breaking parity.
            assert.strictEqual(sanitizePythonVariableName('   '), '_');
        });
    });

    suite('createDataFrameConfig', () => {
        function makeSqlBlock(tableState?: Record<string, unknown>): SqlBlock {
            return {
                type: 'sql',
                id: 'block-id',
                blockGroup: 'group-id',
                sortingKey: 'a',
                content: 'SELECT 1',
                metadata: tableState === undefined ? {} : { deepnote_table_state: tableState }
            } as unknown as SqlBlock;
        }

        test('uses an empty JSON object when metadata.deepnote_table_state is missing', () => {
            const block = makeSqlBlock();
            const result = createDataFrameConfig(block);

            const expected =
                "if '_dntk' in globals():\n" +
                "  _dntk.dataframe_utils.configure_dataframe_formatter('{}')\n" +
                'else:\n' +
                "  _deepnote_current_table_attrs = '{}'";

            assert.strictEqual(result, expected);
        });

        test('JSON-stringifies a non-trivial table state and round-trips through escapePythonString', () => {
            const tableState = {
                pageSize: 50,
                sortBy: [{ column: 'name', direction: 'asc' as const }],
                hiddenColumns: ['id']
            };
            const block = makeSqlBlock(tableState);
            const result = createDataFrameConfig(block);

            const expectedJson = JSON.stringify(tableState);
            assert.include(result, escapePythonString(expectedJson));
            // Both branches must reference the same escaped JSON.
            const occurrences = result.split(escapePythonString(expectedJson)).length - 1;
            assert.strictEqual(occurrences, 2);
        });

        test('matches the data-frame-config prefix produced by upstream @deepnote/blocks.createPythonCode', () => {
            // Catches: an upstream change to the dataframe-config template (indentation, wording, JSON ordering) drifting us out of parity. Upstream emits `<createDataFrameConfig>\n\n<sql call>`; we compare the prefix up to the blank line.
            const tableState = {
                pageSize: 50,
                sortBy: [{ column: 'name', direction: 'asc' as const }],
                hiddenColumns: ['id']
            };
            const block = makeSqlBlock(tableState);

            const ours = createDataFrameConfig(block);
            const upstreamFull = createPythonCode(block);
            const upstreamPrefix = upstreamFull.split('\n\n')[0];

            assert.strictEqual(ours, upstreamPrefix);
        });
    });
});
