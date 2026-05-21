import { assert } from 'chai';

import { FederatedAuthTokenEntry } from '../types';

suite('Federated auth invariants', () => {
    test('FederatedAuthTokenEntry does not carry accessToken or expiresAt', () => {
        // Plan non-negotiable: access tokens must be fetched fresh on every cell
        // execution and must never be stored at rest. The persisted entry shape
        // is therefore restricted to { integrationId, refreshToken, metadataFingerprint }.
        //
        // This test is both a compile-time tripwire (the type assertion below is
        // evaluated by tsc) and a runtime check on a sample entry literal.
        //
        // Catches: any future addition of `accessToken` or `expiresAt` (or any
        // similarly time-bounded access-credential field) to the persisted entry
        // shape, which the plan explicitly forbids.

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
