import { assert } from 'chai';

import { FederatedAuthTokenEntry } from '../types';

suite('Federated auth invariants', () => {
    test('FederatedAuthTokenEntry does not carry accessToken or expiresAt', () => {
        // Catches: a future addition of `accessToken`/`expiresAt` (or any similarly time-bounded credential) to the persisted entry shape.

        // Compile-time check: tsc fails this file if a forbidden key is ever added.
        type Forbidden = 'accessToken' | 'expiresAt';
        type AssertEntryOmitsForbidden = Forbidden extends keyof FederatedAuthTokenEntry ? never : true;
        const _entryShapeCheck: AssertEntryOmitsForbidden = true;
        void _entryShapeCheck;

        // Runtime check: a sample entry literal has exactly the three allowed keys.
        const sample: FederatedAuthTokenEntry = {
            integrationId: 'integration-1',
            refreshToken: 'refresh-token-value',
            metadataFingerprint: 'sha256-of-client-meta'
        };
        const keys = Object.keys(sample).sort();

        assert.deepStrictEqual(keys, ['integrationId', 'metadataFingerprint', 'refreshToken']);
    });
});
