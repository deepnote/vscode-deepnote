/**
 * Shared validation for the service-account JSON credential used by the Cloud SQL, Spanner and
 * BigQuery integration forms. Callers map the returned error kind to their own localized message.
 */
export type ServiceAccountValidationError = { kind: 'required' } | { kind: 'invalid-json'; detail: string };

/**
 * @returns the validation error, or `null` when the value is a non-empty, parseable JSON object.
 */
export function validateServiceAccountJson(value: string): ServiceAccountValidationError | null {
    const trimmed = value.trim();

    if (!trimmed) {
        return { kind: 'required' };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch (error) {
        return { kind: 'invalid-json', detail: error instanceof Error ? error.message : 'Invalid JSON' };
    }

    // Reject non-objects: `JSON.parse` also accepts primitives, `null` and arrays.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { kind: 'invalid-json', detail: 'Expected a JSON object' };
    }

    return null;
}
