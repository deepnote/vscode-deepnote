import { assert } from 'chai';
import sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';

import { IEncryptedStorage } from '../../../../platform/common/application/types';
import { IAsyncDisposableRegistry } from '../../../../platform/common/types';
import { FederatedAuthTokenEntry } from '../types';
import {
    computeMetadataFingerprint,
    FederatedAuthTokenStorage,
    fetchFreshAccessToken,
    InvalidClientError,
    InvalidGrantError
} from './federatedAuthTokenStorage.node';

suite('federatedAuthTokenStorage', () => {
    suite('computeMetadataFingerprint', () => {
        test('differs when clientId changes', () => {
            const a = computeMetadataFingerprint({ clientId: 'c-1', clientSecret: 's', project: 'p' });
            const b = computeMetadataFingerprint({ clientId: 'c-2', clientSecret: 's', project: 'p' });
            assert.notStrictEqual(a, b);
        });

        test('differs when clientSecret changes', () => {
            const a = computeMetadataFingerprint({ clientId: 'c', clientSecret: 's-1', project: 'p' });
            const b = computeMetadataFingerprint({ clientId: 'c', clientSecret: 's-2', project: 'p' });
            assert.notStrictEqual(a, b);
        });

        test('differs when project changes', () => {
            const a = computeMetadataFingerprint({ clientId: 'c', clientSecret: 's', project: 'p-1' });
            const b = computeMetadataFingerprint({ clientId: 'c', clientSecret: 's', project: 'p-2' });
            assert.notStrictEqual(a, b);
        });

        test('treats the three fields as distinct (no field-boundary confusion)', () => {
            // Catches: separator-less concatenation where `a|bc` collides with `ab|c`.
            const a = computeMetadataFingerprint({ clientId: 'a', clientSecret: 'b', project: 'c' });
            const b = computeMetadataFingerprint({ clientId: 'a|b', clientSecret: '', project: 'c' });
            assert.notStrictEqual(a, b);
        });
    });

    suite('FederatedAuthTokenStorage', () => {
        let storage: FederatedAuthTokenStorage;
        let encryptedStorage: IEncryptedStorage;
        let asyncRegistry: IAsyncDisposableRegistry;
        let storageData: Map<string, string | undefined>;

        setup(() => {
            storageData = new Map();
            encryptedStorage = mock<IEncryptedStorage>();
            asyncRegistry = mock<IAsyncDisposableRegistry>();

            when(encryptedStorage.store(anything(), anything(), anything())).thenCall(
                async (_serviceName: string, key: string, value: string | undefined) => {
                    if (value === undefined) {
                        storageData.delete(key);
                    } else {
                        storageData.set(key, value);
                    }
                }
            );
            when(encryptedStorage.retrieve(anything(), anything())).thenCall(
                async (_serviceName: string, key: string) => {
                    return storageData.get(key);
                }
            );

            storage = new FederatedAuthTokenStorage(instance(encryptedStorage), instance(asyncRegistry));
        });

        teardown(() => {
            storage.dispose();
        });

        const sampleEntry = (id = 'integration-1'): FederatedAuthTokenEntry => ({
            integrationId: id,
            refreshToken: `refresh-token-for-${id}`,
            metadataFingerprint: `fp-${id}`
        });

        test('save then get round-trips the entry', async () => {
            const entry = sampleEntry();
            await storage.save(entry);

            const result = await storage.get(entry.integrationId);
            assert.deepStrictEqual(result, entry);
        });

        test('save persists exactly the three-field entry shape', async () => {
            const entry = sampleEntry();
            await storage.save(entry);
            const stored = storageData.get(entry.integrationId);
            assert.ok(stored, 'entry should be stored');
            const parsed = JSON.parse(stored!);
            assert.deepStrictEqual(Object.keys(parsed).sort(), [
                'integrationId',
                'metadataFingerprint',
                'refreshToken'
            ]);
        });

        test('has returns true after save', async () => {
            const entry = sampleEntry();
            await storage.save(entry);
            assert.strictEqual(await storage.has(entry.integrationId), true);
        });

        test('delete removes the entry', async () => {
            const entry = sampleEntry();
            await storage.save(entry);
            await storage.delete(entry.integrationId);
            assert.deepStrictEqual(
                { get: await storage.get(entry.integrationId), has: await storage.has(entry.integrationId) },
                { get: undefined, has: false }
            );
        });

        test('delete on a missing integration does not fire the change event', async () => {
            const events: string[] = [];
            storage.onDidChangeTokens((id) => events.push(id));

            await storage.delete('does-not-exist');

            assert.deepStrictEqual(events, []);
        });

        test('save fires onDidChangeTokens with the correct integration id', async () => {
            const events: string[] = [];
            storage.onDidChangeTokens((id) => events.push(id));

            await storage.save(sampleEntry('integration-1'));
            await storage.save(sampleEntry('integration-2'));

            assert.deepStrictEqual(events, ['integration-1', 'integration-2']);
        });

        test('delete fires onDidChangeTokens with the deleted integration id', async () => {
            const entry = sampleEntry();
            await storage.save(entry);

            const events: string[] = [];
            storage.onDidChangeTokens((id) => events.push(id));

            await storage.delete(entry.integrationId);

            assert.deepStrictEqual(events, [entry.integrationId]);
        });

        test('save with { silent: true } persists the entry but does NOT fire onDidChangeTokens', async () => {
            // Catches: a rotation event flipping the kernel-restart bridge mid-cell.
            const events: string[] = [];
            storage.onDidChangeTokens((id) => events.push(id));

            const entry = sampleEntry();
            await storage.save(entry, { silent: true });

            assert.deepStrictEqual(events, [], 'silent save must not fire the change event');
            assert.deepStrictEqual(await storage.get(entry.integrationId), entry, 'silent save must still persist');
        });

        test('a fresh instance backed by the same storage rehydrates all entries', async () => {
            await storage.save(sampleEntry('a'));
            await storage.save(sampleEntry('b'));
            await storage.save(sampleEntry('c'));

            const reloaded = new FederatedAuthTokenStorage(instance(encryptedStorage), instance(asyncRegistry));
            try {
                assert.deepStrictEqual(
                    { a: await reloaded.get('a'), b: await reloaded.has('b'), c: await reloaded.has('c') },
                    { a: sampleEntry('a'), b: true, c: true }
                );
            } finally {
                reloaded.dispose();
            }
        });

        test('handles corrupted index gracefully', async () => {
            storageData.set('index', 'not-json');
            const reloaded = new FederatedAuthTokenStorage(instance(encryptedStorage), instance(asyncRegistry));
            try {
                assert.strictEqual(await reloaded.has('whatever'), false);
            } finally {
                reloaded.dispose();
            }
        });

        test('reload purges malformed entries from cache, secret store, and index', async () => {
            // Catches: orphaned refresh-token secrets persisting + the index keeps referencing a malformed id.
            storageData.set('index', JSON.stringify(['malformed-1', 'good-1']));
            storageData.set('malformed-1', JSON.stringify({ integrationId: 'malformed-1' }));
            storageData.set(
                'good-1',
                JSON.stringify({
                    integrationId: 'good-1',
                    refreshToken: 't',
                    metadataFingerprint: 'fp'
                } satisfies FederatedAuthTokenEntry)
            );

            const reloaded = new FederatedAuthTokenStorage(instance(encryptedStorage), instance(asyncRegistry));
            try {
                // Triggers the lazy reload, which purges malformed entries from storageData and the index.
                const cacheHasMalformed = await reloaded.has('malformed-1');
                const cacheHasGood = await reloaded.has('good-1');
                const indexJson = storageData.get('index');
                assert.ok(indexJson, 'index should still be present');
                assert.deepStrictEqual(
                    {
                        cacheHasMalformed,
                        cacheHasGood,
                        secretStoreHasMalformed: storageData.has('malformed-1'),
                        secretStoreHasGood: storageData.has('good-1'),
                        index: JSON.parse(indexJson!)
                    },
                    {
                        cacheHasMalformed: false,
                        cacheHasGood: true,
                        secretStoreHasMalformed: false,
                        secretStoreHasGood: true,
                        index: ['good-1']
                    }
                );
            } finally {
                reloaded.dispose();
            }
        });
    });

    suite('fetchFreshAccessToken', () => {
        let originalFetch: typeof globalThis.fetch | undefined;

        const sampleEntry: FederatedAuthTokenEntry = {
            integrationId: 'integration-1',
            refreshToken: 'refresh-token-value',
            metadataFingerprint: 'fp'
        };
        const sampleConfig = {
            tokenUrl: 'https://oauth2.googleapis.com/token',
            clientId: 'client-id',
            clientSecret: 'client-secret'
        };

        setup(() => {
            originalFetch = globalThis.fetch;
        });

        teardown(() => {
            if (originalFetch === undefined) {
                delete (globalThis as { fetch?: typeof fetch }).fetch;
            } else {
                globalThis.fetch = originalFetch;
            }
            sinon.restore();
        });

        function makeResponse(status: number, body: unknown): Response {
            return new Response(JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json' }
            });
        }

        function stubFetchResponse(status: number, body: unknown): sinon.SinonStub {
            const stub = sinon.stub().resolves(makeResponse(status, body));
            globalThis.fetch = stub as unknown as typeof fetch;
            return stub;
        }

        async function expectThrow(
            expectedError: ErrorConstructor | typeof InvalidClientError | typeof InvalidGrantError,
            extraAssert?: (err: Error) => void
        ): Promise<void> {
            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig);
                assert.fail('expected throw');
            } catch (err) {
                assert.instanceOf(err, expectedError as ErrorConstructor);
                assert(err instanceof Error);
                extraAssert?.(err);
            }
        }

        test('sends Basic auth header and form-encoded refresh_token body', async () => {
            const fetchStub = stubFetchResponse(200, { access_token: 'fresh-access' });

            await fetchFreshAccessToken(sampleEntry, sampleConfig);

            sinon.assert.calledOnce(fetchStub);
            const [url, init] = fetchStub.firstCall.args as [string, RequestInit];
            const headers = init.headers as Record<string, string>;
            const expectedBasic = Buffer.from(`${sampleConfig.clientId}:${sampleConfig.clientSecret}`).toString(
                'base64'
            );
            assert.deepStrictEqual(
                {
                    url,
                    method: init.method,
                    authorization: headers.Authorization,
                    contentType: headers['Content-Type'],
                    body: init.body
                },
                {
                    url: sampleConfig.tokenUrl,
                    method: 'POST',
                    authorization: `Basic ${expectedBasic}`,
                    contentType: 'application/x-www-form-urlencoded',
                    body: `grant_type=refresh_token&refresh_token=${sampleEntry.refreshToken}`
                }
            );
        });

        test('returns the access token and the rotated refresh token on success', async () => {
            stubFetchResponse(200, { access_token: 'fresh-access', refresh_token: 'rotated-refresh' });

            const result = await fetchFreshAccessToken(sampleEntry, sampleConfig);
            assert.deepStrictEqual(result, {
                accessToken: 'fresh-access',
                newRefreshToken: 'rotated-refresh'
            });
        });

        test('URL-encodes the refresh token in the body', async () => {
            const fetchStub = stubFetchResponse(200, { access_token: 'a' });

            const entryWithSpecial: FederatedAuthTokenEntry = {
                integrationId: 'i',
                refreshToken: 'a=b&c+d e',
                metadataFingerprint: 'fp'
            };

            await fetchFreshAccessToken(entryWithSpecial, sampleConfig);

            const [, init] = fetchStub.firstCall.args as [string, RequestInit];
            assert.strictEqual(
                init.body,
                `grant_type=refresh_token&refresh_token=${encodeURIComponent(entryWithSpecial.refreshToken)}`
            );
        });

        test('throws InvalidGrantError on HTTP 400 with error=invalid_grant', async () => {
            stubFetchResponse(400, { error: 'invalid_grant' });
            await expectThrow(InvalidGrantError);
        });

        (['invalid_client', 'unauthorized_client'] as const).forEach((errorCode) => {
            test(`throws InvalidClientError on HTTP 401 with error=${errorCode}`, async () => {
                stubFetchResponse(401, { error: errorCode });
                await expectThrow(InvalidClientError);
            });
        });

        test('throws a generic Error on HTTP 500', async () => {
            stubFetchResponse(500, { error: 'internal_server_error' });
            await expectThrow(Error, (err) => {
                assert.notInstanceOf(err, InvalidGrantError);
                assert.notInstanceOf(err, InvalidClientError);
            });
        });

        test('throws on a fetch AbortError (timeout)', async () => {
            const abortError = new Error('The user aborted a request.');
            abortError.name = 'AbortError';
            globalThis.fetch = sinon.stub().rejects(abortError) as unknown as typeof fetch;

            await expectThrow(Error, (err) => {
                assert.strictEqual(err.name, 'AbortError');
            });
        });

        test('throws when 2xx response does not include access_token', async () => {
            stubFetchResponse(200, { refresh_token: 'r' });
            await expectThrow(Error);
        });

        (
            [
                ['access_token', { access_token: 12345 }],
                ['refresh_token', { access_token: 'a', refresh_token: 42 }]
            ] as const
        ).forEach(([field, body]) => {
            test(`throws when ${field} in a 2xx response is not a string`, async () => {
                // Locks the zod schema contract on the token-response fields.
                stubFetchResponse(200, body);
                await expectThrow(Error, (err) => {
                    assert.include(err.message, 'invalid response body');
                });
            });
        });

        test('throws with SyntaxError cause when body is invalid JSON, preserving original error', async () => {
            const malformedResponse = new Response('not-json', {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
            globalThis.fetch = sinon.stub().resolves(malformedResponse) as unknown as typeof fetch;

            await expectThrow(Error, (err) => {
                assert.include(err.message, 'not valid JSON');
                assert.include(err.message, 'HTTP 200');
                assert.instanceOf(err.cause, SyntaxError);
            });
        });

        test('rejects when response.json() takes longer than the timeout', async () => {
            // Catches: a timeout that covers only `fetch()` and not `response.json()`, which would let a slow body hang.
            const makeSlowResponse = (signal: AbortSignal | undefined): Response => {
                const slowJson = (): Promise<unknown> =>
                    new Promise((_resolve, reject) => {
                        if (signal === undefined) {
                            return;
                        }
                        signal.addEventListener('abort', () => {
                            const abortError = new Error('The body read was aborted.');
                            abortError.name = 'AbortError';
                            reject(abortError);
                        });
                    });
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: slowJson
                } as unknown as Response;
            };

            globalThis.fetch = ((_url: string, init?: RequestInit) => {
                // Headers arrive immediately; body read stalls until abort.
                return Promise.resolve(makeSlowResponse(init?.signal ?? undefined));
            }) as unknown as typeof fetch;

            const start = Date.now();
            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig, 50);
                assert.fail('expected throw');
            } catch (err) {
                assert(err instanceof Error);
                assert.strictEqual(err.name, 'AbortError');
                assert.isBelow(Date.now() - start, 1500);
            }
        });
    });
});
