/**
 * Shared validation for the service-account JSON credential used by the Cloud SQL,
 * Spanner and BigQuery integration forms.
 *
 * Pure and dependency-free so it can be unit-tested in isolation. Callers map the
 * returned error kind to their own localized message (and may use `detail` to surface
 * the underlying parse error).
 */
export type ServiceAccountValidationError = { kind: 'required' } | { kind: 'invalid-json'; detail: string };

/**
 * Validate a pasted service-account JSON credential.
 *
 * @returns the validation error, or `null` when the value is a non-empty, parseable JSON string.
 */
export function validateServiceAccountJson(value: string): ServiceAccountValidationError | null {
    const trimmed = value.trim();

    if (!trimmed) {
        return { kind: 'required' };
    }

    try {
        JSON.parse(trimmed);
    } catch (error) {
        return { kind: 'invalid-json', detail: error instanceof Error ? error.message : 'Invalid JSON' };
    }

    return null;
}
