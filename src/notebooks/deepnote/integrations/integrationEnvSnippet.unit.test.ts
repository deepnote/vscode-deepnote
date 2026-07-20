import { assert } from 'chai';

import { buildIntegrationEnvRefreshSnippet, IntegrationEnvValidationError } from './integrationEnvSnippet';

const SET_CALL = '__import__("deepnote_toolkit.env", fromlist=["set_env"]).set_env';
const UNSET_CALL = '__import__("deepnote_toolkit.env", fromlist=["unset_env"]).unset_env';

/**
 * `unset_env` ends with the substring `set_env`, so every check here must be anchored on the leading
 * dot of the attribute access (`.set_env(` / `.unset_env(`) to tell the two call kinds apart.
 */
function isSetLine(line: string): boolean {
    return line.includes('.set_env(');
}

function isUnsetLine(line: string): boolean {
    return line.includes('.unset_env(');
}

function linesOf(code: string): string[] {
    return code.length === 0 ? [] : code.split('\n');
}

/**
 * Extracts the raw source of the value argument of a `set_env(<name>, <value>)` call, given the name
 * it was built from. Anchored on the fully-known prefix rather than by splitting on `, `, which a
 * value is free to contain.
 */
function valueLiteralOf(line: string, name: string): string {
    const prefix = `${SET_CALL}(${JSON.stringify(name)}, `;

    assert.isTrue(line.startsWith(prefix), `expected ${line} to start with ${prefix}`);
    assert.strictEqual(line[line.length - 1], ')', `expected ${line} to end the call`);

    return line.slice(prefix.length, -1);
}

suite('buildIntegrationEnvRefreshSnippet', () => {
    test('emits one set_env call per variable, through __import__ and with a JSON-encoded name and value', () => {
        const { code } = buildIntegrationEnvRefreshSnippet({ SQL_DEMO: 'postgres://demo' }, []);

        assert.strictEqual(code, `${SET_CALL}("SQL_DEMO", "postgres://demo")`);
    });

    test('encodes the name as a literal too, so a quote or backslash in it cannot break the snippet', () => {
        // SqlIntegrationStartupCodeProvider interpolates the key raw and would emit broken Python here.
        const { code } = buildIntegrationEnvRefreshSnippet({ 'ODD"NAME\\': 'v' }, []);

        assert.strictEqual(code, `${SET_CALL}("ODD\\"NAME\\\\", "v")`);
        assert.strictEqual(linesOf(code).length, 1);
    });

    suite('value encoding', () => {
        /**
         * The builder relies on JSON string escaping being a subset of Python's: every escape it can
         * emit (`\\" \\\\ \\b \\f \\n \\r \\t` and `\\uXXXX`) decodes identically in Python, and
         * non-ASCII is left as literal UTF-8. Running a real interpreter would make these tests
         * depend on a Python install, so the round-trip is asserted on the JSON side — the literal
         * must parse back to the exact original string — plus the structural property that no value
         * can break out of its line.
         */
        function assertValueRoundTrips(value: string, description: string) {
            const { code } = buildIntegrationEnvRefreshSnippet({ NAME: value }, []);
            const lines = linesOf(code);

            assert.strictEqual(lines.length, 1, `${description}: a value must never split the snippet across lines`);
            assert.strictEqual(
                JSON.parse(valueLiteralOf(lines[0], 'NAME')),
                value,
                `${description}: literal must decode to the original`
            );
        }

        test('round-trips a double quote', () => {
            assertValueRoundTrips('pa"ss', 'double quote');
        });

        test('round-trips a backslash', () => {
            assertValueRoundTrips('C:\\keys\\db', 'backslash');
        });

        test('round-trips a backslash immediately before a quote', () => {
            assertValueRoundTrips('trailing\\', 'trailing backslash');
        });

        test('round-trips a newline without splitting the line', () => {
            const key = '-----BEGIN-----\nabc\n-----END-----';
            const { code } = buildIntegrationEnvRefreshSnippet({ KEY: key }, []);

            assert.strictEqual(linesOf(code).length, 1, 'a newline in a value must be escaped, not emitted raw');
            assert.include(code, '\\n');
            assert.strictEqual(JSON.parse(valueLiteralOf(code, 'KEY')), key);
        });

        test('round-trips tabs and other control characters', () => {
            assertValueRoundTrips('a\tb\rc', 'control characters');
        });

        test('round-trips accented characters, CJK and emoji, leaving them as literal UTF-8', () => {
            assertValueRoundTrips('naïve 世界 😀', 'non-ASCII');

            const { code } = buildIntegrationEnvRefreshSnippet({ NAME: 'naïve 世界 😀' }, []);

            // Not \uXXXX-escaped: the snippet is sent to the kernel as UTF-8 already.
            assert.include(code, 'naïve 世界 😀');
        });

        test('round-trips a well-formed surrogate pair, which must not be mistaken for a lone surrogate', () => {
            // The same emoji, written as the two code units it is stored as, to pin down that the
            // lone-surrogate rejection below does not fire on a properly paired one.
            assertValueRoundTrips('😀', 'surrogate pair');
        });
    });

    suite('removals', () => {
        test('emits unset_env for a name that is no longer present', () => {
            const { code } = buildIntegrationEnvRefreshSnippet({ KEPT: '1' }, ['KEPT', 'REMOVED']);

            assert.include(code, `${UNSET_CALL}("REMOVED")`);
            assert.notInclude(code, '.unset_env("KEPT")', 'a name that is still set must not be unset');
        });

        test('emits every unset before any set', () => {
            const { code } = buildIntegrationEnvRefreshSnippet({ A: '1', B: '2' }, ['GONE_1', 'GONE_2']);
            const lines = linesOf(code);

            assert.strictEqual(lines.length, 4);

            const lastUnset = lines.map(isUnsetLine).lastIndexOf(true);
            const firstSet = lines.findIndex(isSetLine);

            assert.isAbove(firstSet, lastUnset, 'a removal must never run after a set, or it would undo it');
            assert.deepStrictEqual(lines.map(isUnsetLine), [true, true, false, false]);
        });

        test('sets, rather than removes, a name that reappears in the new environment', () => {
            const { code } = buildIntegrationEnvRefreshSnippet({ REVIVED: 'new' }, ['REVIVED']);

            assert.strictEqual(code, `${SET_CALL}("REVIVED", "new")`);
        });

        test('deduplicates repeated previous names', () => {
            const { code } = buildIntegrationEnvRefreshSnippet({}, ['GONE', 'GONE']);

            assert.strictEqual(code, `${UNSET_CALL}("GONE")`);
        });

        test('accepts a Set as the previous names', () => {
            const { code } = buildIntegrationEnvRefreshSnippet({}, new Set(['GONE']));

            assert.strictEqual(code, `${UNSET_CALL}("GONE")`);
        });

        test('emits nothing when there is neither anything to set nor anything to remove', () => {
            const { code, setNames } = buildIntegrationEnvRefreshSnippet({}, []);

            assert.strictEqual(code, '');
            assert.deepStrictEqual([...setNames], []);
        });
    });

    suite('entry filtering', () => {
        test('keeps empty-string values', () => {
            // Deliberately unlike SqlIntegrationStartupCodeProvider's `if (value)` guard: skipping ''
            // would leave the variable's previous, stale value live in the kernel.
            const { code, setNames } = buildIntegrationEnvRefreshSnippet({ EMPTY: '' }, []);

            assert.strictEqual(code, `${SET_CALL}("EMPTY", "")`);
            assert.deepStrictEqual([...setNames], ['EMPTY']);
        });

        test('skips undefined values', () => {
            const { code, setNames } = buildIntegrationEnvRefreshSnippet({ SET: 'v', MISSING: undefined }, []);

            assert.strictEqual(code, `${SET_CALL}("SET", "v")`);
            assert.deepStrictEqual([...setNames], ['SET']);
        });

        test('skips non-string values', () => {
            const envVars = { NUMERIC: 42, NULLED: null, SET: 'v' } as unknown as Record<string, string | undefined>;
            const { code, setNames } = buildIntegrationEnvRefreshSnippet(envVars, []);

            assert.strictEqual(code, `${SET_CALL}("SET", "v")`);
            assert.deepStrictEqual([...setNames], ['SET']);
        });

        test('removes a previously set name whose value is now undefined', () => {
            const { code, setNames } = buildIntegrationEnvRefreshSnippet({ DROPPED: undefined }, ['DROPPED']);

            assert.strictEqual(code, `${UNSET_CALL}("DROPPED")`);
            assert.deepStrictEqual([...setNames], []);
        });

        test('setNames is exactly the set of included names', () => {
            const { setNames } = buildIntegrationEnvRefreshSnippet({ A: 'a', EMPTY: '', SKIPPED: undefined, B: 'b' }, [
                'OLD'
            ]);

            assert.deepStrictEqual(setNames, new Set(['A', 'EMPTY', 'B']));
        });
    });

    test('binds no name in the user namespace', () => {
        const { code } = buildIntegrationEnvRefreshSnippet({ A: 'a', B: 'b' }, ['GONE']);
        const lines = linesOf(code);

        for (const line of lines) {
            // Every statement is a bare call expression reached through __import__, so nothing — not
            // the module, not a value — is left bound in the kernel's user namespace.
            assert.isTrue(
                line.startsWith(SET_CALL + '(') || line.startsWith(UNSET_CALL + '('),
                `unexpected statement shape: ${line}`
            );
        }

        assert.notMatch(code, /^\s*import\s/m, 'a plain import would bind the module name');
        assert.notMatch(code, /^\s*from\s+\S+\s+import\s/m, 'a from-import would bind a name');
    });

    suite('fail-closed validation', () => {
        /** Asserts the builder throws and produces no code at all, rather than a half-applied snippet. */
        function assertRejects(
            envVars: Record<string, string | undefined>,
            previousNames: Iterable<string>,
            expectedCount: number
        ) {
            let result: { code: string } | undefined;
            let thrown: unknown;

            try {
                result = buildIntegrationEnvRefreshSnippet(envVars, previousNames);
            } catch (err) {
                thrown = err;
            }

            assert.isUndefined(result, 'no snippet — not even a partial one — may be produced');
            assert.instanceOf(thrown, IntegrationEnvValidationError);
            assert.strictEqual((thrown as IntegrationEnvValidationError).invalidCount, expectedCount);

            return thrown as IntegrationEnvValidationError;
        }

        test('rejects a lone high surrogate value', () => {
            // Python decodes \uD800 back to a surrogate, which raises UnicodeEncodeError on assignment.
            assertRejects({ BAD: 'prefix\uD800suffix' }, [], 1);
        });

        test('rejects a lone low surrogate value', () => {
            assertRejects({ BAD: '\uDC00' }, [], 1);
        });

        test('rejects a NUL in a value', () => {
            assertRejects({ BAD: 'a\0b' }, [], 1);
        });

        test('rejects a name containing =', () => {
            assertRejects({ 'BAD=NAME': 'v' }, [], 1);
        });

        test('rejects a name containing NUL', () => {
            assertRejects({ 'BAD\0NAME': 'v' }, [], 1);
        });

        test('rejects an empty name', () => {
            assertRejects({ '': 'v' }, [], 1);
        });

        test('aborts the whole refresh, emitting nothing for the valid entries or the removals', () => {
            // All-or-nothing: removals are emitted first, so a snippet that raised part-way through
            // would leave the kernel with removals applied and the replacements missing.
            assertRejects({ GOOD: 'v', BAD: '\uD800' }, ['GONE'], 1);
        });

        test('counts every invalid entry', () => {
            assertRejects({ GOOD: 'v', BAD_1: '\uD800', BAD_2: 'a\0b', 'BAD=3': 'v' }, [], 3);
        });

        test('carries no name and no value in its message, so the refresher can log it safely', () => {
            const name = 'SQL_SECRET_NAME';
            const value = 'super-secret-\uD800-value';
            const error = assertRejects({ [name]: value }, [], 1);

            assert.notInclude(error.message, name);
            assert.notInclude(error.message, 'super-secret');
            assert.notInclude(error.message, value);
            assert.include(error.message, '1');
            assert.strictEqual(error.name, 'IntegrationEnvValidationError');
        });

        test('drops, rather than rejects, an unapplicable previous name', () => {
            // Such a name could never have been set, so there is nothing to remove and no reason to
            // fail an otherwise valid refresh.
            const { code } = buildIntegrationEnvRefreshSnippet({ GOOD: 'v' }, ['BAD=NAME', 'GONE']);

            assert.strictEqual(code, `${UNSET_CALL}("GONE")\n${SET_CALL}("GOOD", "v")`);
        });
    });
});
