import { createPythonCode } from '@deepnote/blocks';
import { assert } from 'chai';

import {
    createDataFrameConfig,
    escapePythonString,
    sanitizePythonVariableName,
    SqlBlock
} from './vendoredBlocksHelpers';

suite('vendoredBlocksHelpers', () => {
    suite('escapePythonString', () => {
        test('wraps an empty string in single quotes', () => {
            assert.strictEqual(escapePythonString(''), "''");
        });

        test('wraps a plain ASCII string in single quotes', () => {
            assert.strictEqual(escapePythonString('hello'), "'hello'");
        });

        test('escapes single quotes inside the string', () => {
            assert.strictEqual(escapePythonString("it's"), "'it\\'s'");
            assert.strictEqual(escapePythonString("'''"), "'\\'\\'\\''");
        });

        test('leaves double quotes alone', () => {
            assert.strictEqual(escapePythonString('he said "hi"'), `'he said "hi"'`);
        });

        test('escapes backslashes', () => {
            assert.strictEqual(escapePythonString('a\\b'), "'a\\\\b'");
        });

        test('escapes backslashes before quotes (order matters)', () => {
            // Upstream order: `\` → `\\` first, then `'` → `\'`, so `\'` becomes `\\\\\\'` (i.e. `\\` + `\'`).
            assert.strictEqual(escapePythonString("\\'"), "'\\\\\\''");
        });

        test('escapes newlines', () => {
            assert.strictEqual(escapePythonString('line1\nline2'), "'line1\\nline2'");
        });

        test('does not escape tabs', () => {
            // Upstream only escapes `\`, `'`, `\n`; tabs pass through verbatim.
            assert.strictEqual(escapePythonString('a\tb'), "'a\tb'");
        });

        test('passes unicode through verbatim', () => {
            assert.strictEqual(escapePythonString('héllo 世界 🚀'), "'héllo 世界 🚀'");
        });

        test('handles a mixed input', () => {
            const input = `a\\b'c\nd`;
            // `\\` → `\\\\`, `'` → `\'`, `\n` → `\\n`.
            assert.strictEqual(escapePythonString(input), "'a\\\\b\\'c\\nd'");
        });

        test('output, when interpreted as a Python single-quoted literal, round-trips back to the original SQL query', () => {
            // Catches: a future change adding an extra escape (e.g. `\t`/`\r`) without updating the inverse mapping, breaking SQL queries at runtime.
            function parsePythonSingleQuoted(escaped: string): string {
                assert.isTrue(escaped.startsWith("'") && escaped.endsWith("'"), 'must be wrapped in single quotes');
                const body = escaped.slice(1, -1);
                let result = '';
                for (let i = 0; i < body.length; i++) {
                    if (body[i] === '\\' && i + 1 < body.length) {
                        const next = body[i + 1];
                        if (next === '\\') {
                            result += '\\';
                        } else if (next === "'") {
                            result += "'";
                        } else if (next === 'n') {
                            result += '\n';
                        } else {
                            // Unrecognized escape: leave both chars in place (matches Python's behavior).
                            result += '\\' + next;
                        }
                        i++;
                    } else {
                        result += body[i];
                    }
                }
                return result;
            }

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

        test('strips a leading digit', () => {
            assert.strictEqual(sanitizePythonVariableName('1abc'), 'abc');
        });

        test('strips leading digits but keeps a following underscore', () => {
            // Upstream strips `[^a-zA-Z_]+` from the start, so `123_foo` → `_foo` (underscore is a valid leading char).
            assert.strictEqual(sanitizePythonVariableName('123_foo'), '_foo');
        });

        test('converts whitespace to underscores', () => {
            assert.strictEqual(sanitizePythonVariableName('my var'), 'my_var');
            assert.strictEqual(sanitizePythonVariableName('foo   bar'), 'foo_bar');
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

        test('does not rewrite Python reserved words (upstream does not either)', () => {
            // sanitize only handles syntactic validity; reserved-word handling is out of scope.
            assert.strictEqual(sanitizePythonVariableName('class'), 'class');
            assert.strictEqual(sanitizePythonVariableName('lambda'), 'lambda');
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

        test('produces a two-branch Python snippet with the JSON-encoded table state inlined', () => {
            const block = makeSqlBlock({ pageSize: 25 });
            const result = createDataFrameConfig(block);

            const expected =
                "if '_dntk' in globals():\n" +
                '  _dntk.dataframe_utils.configure_dataframe_formatter(\'{"pageSize":25}\')\n' +
                'else:\n' +
                '  _deepnote_current_table_attrs = \'{"pageSize":25}\'';

            assert.strictEqual(result, expected);
        });

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
