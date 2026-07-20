import type { EnvironmentVariables } from '../../../platform/common/variables/types';

/**
 * The toolkit's own env accessors, reached through `__import__` so the snippet binds no name in the
 * kernel's user namespace. They must be used instead of a raw `os.environ` write: the toolkit's
 * `get_env` — which SQL execution resolves credentials through — consults its in-memory `_STATE` map
 * *before* `os.environ`, so a raw write is shadowed by any existing `_STATE` entry. `set_env` /
 * `unset_env` update both stores, and both return `None`, so no line is ever a trailing expression
 * whose value could be echoed.
 */
const SET_ENV_CALL = '__import__("deepnote_toolkit.env", fromlist=["set_env"]).set_env';
const UNSET_ENV_CALL = '__import__("deepnote_toolkit.env", fromlist=["unset_env"]).unset_env';

/**
 * Matches an unpaired surrogate. Under the `u` flag a well-formed pair is a single non-surrogate code
 * point, so this only fires on lone surrogates — which `JSON.stringify` escapes to `\uXXXX` and Python
 * decodes back into a surrogate that raises `UnicodeEncodeError` on assignment to `os.environ`.
 */
const LONE_SURROGATE_PATTERN = /\p{Surrogate}/u;

/**
 * Thrown by {@link buildIntegrationEnvRefreshSnippet} when an entry cannot be expressed as a kernel
 * environment variable. Carries a count only — never a name or value — so it stays safe to log.
 */
export class IntegrationEnvValidationError extends Error {
    constructor(public readonly invalidCount: number) {
        super(`${invalidCount} integration environment variable(s) cannot be applied to a kernel environment.`);
        this.name = 'IntegrationEnvValidationError';
    }
}

/**
 * Builds the Python snippet that brings a live kernel's integration environment in line with
 * `envVars`, removing anything in `previousNames` that is no longer present.
 *
 * The result is meant for `executeHiddenSilent` only — it embeds credential values as literals.
 * `setNames` is the set of names the snippet assigns, i.e. the caller's new removal baseline, and is
 * only valid once the snippet has run successfully.
 *
 * @throws {IntegrationEnvValidationError} if any entry to be set cannot be represented as a kernel
 * environment variable. Validation runs before a single line is emitted so a refresh is
 * all-or-nothing: the alternative is a snippet that raises part-way through and leaves the kernel
 * with a half-updated environment.
 */
export function buildIntegrationEnvRefreshSnippet(
    envVars: EnvironmentVariables,
    previousNames: Iterable<string>
): { code: string; setNames: Set<string> } {
    // Filtered on `typeof value === 'string'`, so empty strings are kept. This matches the toolkit's
    // own `if value is not None` guard; a truthiness check would silently skip `""` and leave the
    // previous value of that variable live in the kernel.
    const entries = Object.entries(envVars).filter((entry): entry is [string, string] => typeof entry[1] === 'string');

    const invalidCount = entries.filter(([name, value]) => !isApplicableName(name) || !isApplicableValue(value)).length;

    if (invalidCount > 0) {
        throw new IntegrationEnvValidationError(invalidCount);
    }

    const setNames = new Set(entries.map(([name]) => name));
    // Unapplicable names could never have been set in the first place (the assignment would have
    // raised), so there is nothing to remove for them — drop rather than fail the whole refresh.
    const unsetNames = [...new Set(previousNames)].filter((name) => !setNames.has(name) && isApplicableName(name));

    // Removals first, so a name that moved from removed to set ends up set.
    const lines = [
        ...unsetNames.map((name) => `${UNSET_ENV_CALL}(${toPythonStringLiteral(name)})`),
        ...entries.map(
            ([name, value]) => `${SET_ENV_CALL}(${toPythonStringLiteral(name)}, ${toPythonStringLiteral(value)})`
        )
    ];

    return { code: lines.join('\n'), setNames };
}

/**
 * Names are additionally rejected when empty or containing `=`, both of which CPython refuses (or
 * mis-handles) when writing to the process environment.
 */
function isApplicableName(name: string): boolean {
    return name.length > 0 && !name.includes('=') && isApplicableValue(name);
}

/** A NUL byte raises `ValueError` and a lone surrogate raises `UnicodeEncodeError` on assignment. */
function isApplicableValue(value: string): boolean {
    return !value.includes('\0') && !LONE_SURROGATE_PATTERN.test(value);
}

/**
 * JSON string escaping is a subset of Python's: it escapes only `"`, `\`, `\b`, `\f`, `\n`, `\r`,
 * `\t` and `\uXXXX` for the remaining control characters — all of which Python decodes identically —
 * and leaves non-ASCII (including emoji) as literal UTF-8. So the literal round-trips to the same
 * Python `str`. The name is encoded the same way, unlike `SqlIntegrationStartupCodeProvider`, which
 * interpolates it raw and would emit broken code for a name containing a quote or a backslash.
 */
function toPythonStringLiteral(value: string): string {
    return JSON.stringify(value);
}
