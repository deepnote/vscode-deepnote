import assert from 'assert';

import { validateServiceAccountJson } from './serviceAccountValidation';

suite('validateServiceAccountJson', () => {
    // Catches: a blank credential being saved as if it were valid.
    test("returns 'required' for an empty string", () => {
        assert.deepStrictEqual(validateServiceAccountJson(''), { kind: 'required' });
    });

    // Catches: a whitespace-only credential slipping past the textarea `required` attribute (which does not trim).
    test("returns 'required' for a whitespace-only string", () => {
        assert.deepStrictEqual(validateServiceAccountJson('   \n\t  '), { kind: 'required' });
    });

    // Catches: malformed JSON reaching onSave/storage.
    test("returns 'invalid-json' for malformed JSON", () => {
        const result = validateServiceAccountJson('{ not json');

        assert.strictEqual(result?.kind, 'invalid-json');
    });

    // Catches: a valid credential being wrongly rejected, including when wrapped in surrounding whitespace.
    test('returns null for valid JSON, ignoring surrounding whitespace', () => {
        assert.strictEqual(validateServiceAccountJson('  {"type":"service_account"}  '), null);
    });
});
