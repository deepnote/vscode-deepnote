function formatCaughtError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? error.message;
    }

    return String(error);
}

/** Logs a caught error from best-effort E2E helper paths that intentionally continue. */
export function logCaughtError(context: string, error: unknown, expected = false): void {
    const detail = formatCaughtError(error);
    const prefix = `[deepnote-e2e] ${context}${expected ? ' (expected)' : ''}:`;

    if (expected) {
        console.debug(prefix, detail);
    } else {
        console.warn(prefix, detail);
    }
}

/** Returns a `.catch()` handler that logs and yields `fallback`. */
export function catchAndLog<T>(context: string, fallback: T, expected = false): (error: unknown) => T {
    return (error: unknown) => {
        logCaughtError(context, error, expected);

        return fallback;
    };
}
