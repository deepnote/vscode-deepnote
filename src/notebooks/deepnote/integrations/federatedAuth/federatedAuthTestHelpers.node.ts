// Node-only test helpers; pulls in `googleOAuthProvider.node` for the loopback-flow + OAuth-provider tests.

import {
    buildBigQueryGoogleOAuthStrategy,
    type BuildBigQueryGoogleOAuthStrategyParams,
    createInMemoryPKCEStore
} from './googleOAuthProvider.node';

export function buildTestStrategy(
    overrides: Partial<BuildBigQueryGoogleOAuthStrategyParams> = {}
): ReturnType<typeof buildBigQueryGoogleOAuthStrategy> {
    return buildBigQueryGoogleOAuthStrategy({
        clientId: 'cid',
        clientSecret: 'cs',
        store: createInMemoryPKCEStore(),
        ...overrides
    });
}
