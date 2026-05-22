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
        test('is deterministic for the same inputs', () => {
            const meta = { clientId: 'c-1', clientSecret: 's-1', project: 'p-1' };
            assert.strictEqual(computeMetadataFingerprint(meta), computeMetadataFingerprint(meta));
        });

        test('produces a 64-char hex SHA-256 digest', () => {
            const fp = computeMetadataFingerprint({ clientId: 'a', clientSecret: 'b', project: 'c' });
            assert.match(fp, /^[a-f0-9]{64}$/);
        });

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
            // Catches a bug where someone concatenates without a separator and `a|bc`
            // collides with `ab|c`. Empirically each field must be independent.
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

        test('returns undefined for unknown integration id', async () => {
            const result = await storage.get('does-not-exist');
            assert.strictEqual(result, undefined);
        });

        test('has returns false for unknown integration id', async () => {
            assert.strictEqual(await storage.has('does-not-exist'), false);
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

        test('listIntegrationIds returns empty array when no tokens are stored', async () => {
            const ids = await storage.listIntegrationIds();
            assert.deepStrictEqual(ids, []);
        });

        test('listIntegrationIds returns all stored integration ids', async () => {
            await storage.save(sampleEntry('integration-a'));
            await storage.save(sampleEntry('integration-b'));
            await storage.save(sampleEntry('integration-c'));

            const ids = await storage.listIntegrationIds();
            assert.deepStrictEqual(ids.sort(), ['integration-a', 'integration-b', 'integration-c']);
        });

        test('listIntegrationIds reflects deletions', async () => {
            await storage.save(sampleEntry('integration-a'));
            await storage.save(sampleEntry('integration-b'));
            await storage.delete('integration-a');

            const ids = await storage.listIntegrationIds();
            assert.deepStrictEqual(ids, ['integration-b']);
        });

        test('delete removes the entry', async () => {
            const entry = sampleEntry();
            await storage.save(entry);
            await storage.delete(entry.integrationId);
            assert.strictEqual(await storage.get(entry.integrationId), undefined);
            assert.strictEqual(await storage.has(entry.integrationId), false);
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
            // Catches: a refresh-token rotation that flips the kernel-restart
            // bridge mid-cell. Rotation lands on disk so the next cell reads
            // the new refresh token, but no listeners should observe it as
            // an auth state change.
            const events: string[] = [];
            storage.onDidChangeTokens((id) => events.push(id));

            const entry = sampleEntry();
            await storage.save(entry, { silent: true });

            assert.deepStrictEqual(events, [], 'silent save must not fire the change event');
            assert.deepStrictEqual(await storage.get(entry.integrationId), entry, 'silent save must still persist');
        });

        test('save with { silent: false } fires onDidChangeTokens (explicit default)', async () => {
            const events: string[] = [];
            storage.onDidChangeTokens((id) => events.push(id));

            const entry = sampleEntry();
            await storage.save(entry, { silent: false });

            assert.deepStrictEqual(events, [entry.integrationId]);
        });

        test('save updates the index secret with the integration id', async () => {
            await storage.save(sampleEntry('integration-1'));
            await storage.save(sampleEntry('integration-2'));

            const indexJson = storageData.get('index');
            assert.ok(indexJson);
            assert.deepStrictEqual((JSON.parse(indexJson!) as string[]).sort(), ['integration-1', 'integration-2']);
        });

        test('delete updates the index secret', async () => {
            await storage.save(sampleEntry('integration-1'));
            await storage.save(sampleEntry('integration-2'));
            await storage.delete('integration-1');

            const indexJson = storageData.get('index');
            assert.ok(indexJson);
            assert.deepStrictEqual(JSON.parse(indexJson!), ['integration-2']);
        });

        test('a fresh instance backed by the same storage rehydrates the cache', async () => {
            const entry = sampleEntry();
            await storage.save(entry);

            // New instance, same underlying storageData.
            const reloaded = new FederatedAuthTokenStorage(instance(encryptedStorage), instance(asyncRegistry));
            try {
                const result = await reloaded.get(entry.integrationId);
                assert.deepStrictEqual(result, entry);
            } finally {
                reloaded.dispose();
            }
        });

        test('a fresh instance after multiple saves loads all entries', async () => {
            await storage.save(sampleEntry('a'));
            await storage.save(sampleEntry('b'));
            await storage.save(sampleEntry('c'));

            const reloaded = new FederatedAuthTokenStorage(instance(encryptedStorage), instance(asyncRegistry));
            try {
                assert.strictEqual(await reloaded.has('a'), true);
                assert.strictEqual(await reloaded.has('b'), true);
                assert.strictEqual(await reloaded.has('c'), true);
            } finally {
                reloaded.dispose();
            }
        });

        test('handles missing index gracefully', async () => {
            // Nothing in storageData.
            const result = await storage.get('integration-1');
            assert.strictEqual(result, undefined);
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

        test('skips malformed entries during reload', async () => {
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
                assert.strictEqual(await reloaded.has('malformed-1'), false);
                assert.strictEqual(await reloaded.has('good-1'), true);
            } finally {
                reloaded.dispose();
            }
        });

        test('removes malformed entries from encrypted storage during reload', async () => {
            // Catches: orphaned refresh-token secrets persist forever when an
            // entry's JSON shape is wrong on disk.
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
                // Trigger cache load.
                await reloaded.has('good-1');

                assert.strictEqual(storageData.has('malformed-1'), false, 'malformed entry should be purged');
                assert.strictEqual(storageData.has('good-1'), true, 'good entry should remain');
            } finally {
                reloaded.dispose();
            }
        });

        test('removes malformed entries from the persisted index during reload', async () => {
            // Catches: the index keeps referencing the malformed id even after
            // the entry itself is gone, leading to repeated load attempts.
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
                // Trigger cache load.
                await reloaded.has('good-1');

                const indexJson = storageData.get('index');
                assert.ok(indexJson, 'index should still be present');
                assert.deepStrictEqual(JSON.parse(indexJson!), ['good-1']);
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

        test('sends Basic auth header and form-encoded refresh_token body', async () => {
            const fetchStub = sinon.stub().resolves(makeResponse(200, { access_token: 'fresh-access' }));
            globalThis.fetch = fetchStub as unknown as typeof fetch;

            await fetchFreshAccessToken(sampleEntry, sampleConfig);

            sinon.assert.calledOnce(fetchStub);
            const [url, init] = fetchStub.firstCall.args as [string, RequestInit];
            assert.strictEqual(url, sampleConfig.tokenUrl);
            assert.strictEqual(init.method, 'POST');

            const expectedBasic = Buffer.from(`${sampleConfig.clientId}:${sampleConfig.clientSecret}`).toString(
                'base64'
            );
            const headers = init.headers as Record<string, string>;
            assert.strictEqual(headers.Authorization, `Basic ${expectedBasic}`);
            assert.strictEqual(headers['Content-Type'], 'application/x-www-form-urlencoded');

            assert.strictEqual(init.body, `grant_type=refresh_token&refresh_token=${sampleEntry.refreshToken}`);
        });

        test('returns the access token and the rotated refresh token on success', async () => {
            globalThis.fetch = sinon
                .stub()
                .resolves(
                    makeResponse(200, { access_token: 'fresh-access', refresh_token: 'rotated-refresh' })
                ) as unknown as typeof fetch;

            const result = await fetchFreshAccessToken(sampleEntry, sampleConfig);
            assert.deepStrictEqual(result, {
                accessToken: 'fresh-access',
                newRefreshToken: 'rotated-refresh'
            });
        });

        test('returns the access token with newRefreshToken=undefined when not rotated', async () => {
            globalThis.fetch = sinon
                .stub()
                .resolves(makeResponse(200, { access_token: 'fresh-access' })) as unknown as typeof fetch;

            const result = await fetchFreshAccessToken(sampleEntry, sampleConfig);
            assert.strictEqual(result.accessToken, 'fresh-access');
            assert.strictEqual(result.newRefreshToken, undefined);
        });

        test('URL-encodes the refresh token in the body', async () => {
            const fetchStub = sinon.stub().resolves(makeResponse(200, { access_token: 'a' }));
            globalThis.fetch = fetchStub as unknown as typeof fetch;

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
            globalThis.fetch = sinon
                .stub()
                .resolves(makeResponse(400, { error: 'invalid_grant' })) as unknown as typeof fetch;

            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig);
                assert.fail('expected throw');
            } catch (err) {
                assert.instanceOf(err, InvalidGrantError);
            }
        });

        test('throws InvalidClientError on HTTP 401 with error=invalid_client', async () => {
            globalThis.fetch = sinon
                .stub()
                .resolves(makeResponse(401, { error: 'invalid_client' })) as unknown as typeof fetch;

            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig);
                assert.fail('expected throw');
            } catch (err) {
                assert.instanceOf(err, InvalidClientError);
            }
        });

        test('throws InvalidClientError on error=unauthorized_client', async () => {
            globalThis.fetch = sinon
                .stub()
                .resolves(makeResponse(401, { error: 'unauthorized_client' })) as unknown as typeof fetch;

            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig);
                assert.fail('expected throw');
            } catch (err) {
                assert.instanceOf(err, InvalidClientError);
            }
        });

        test('throws a generic Error on HTTP 500', async () => {
            globalThis.fetch = sinon
                .stub()
                .resolves(makeResponse(500, { error: 'internal_server_error' })) as unknown as typeof fetch;

            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig);
                assert.fail('expected throw');
            } catch (err) {
                assert.instanceOf(err, Error);
                assert.notInstanceOf(err, InvalidGrantError);
                assert.notInstanceOf(err, InvalidClientError);
            }
        });

        test('throws on a fetch AbortError (timeout)', async () => {
            const abortError = new Error('The user aborted a request.');
            abortError.name = 'AbortError';
            globalThis.fetch = sinon.stub().rejects(abortError) as unknown as typeof fetch;

            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig);
                assert.fail('expected throw');
            } catch (err) {
                assert.instanceOf(err, Error);
                assert.strictEqual((err as Error).name, 'AbortError');
            }
        });

        test('throws when the response body is not valid JSON', async () => {
            const malformedResponse = new Response('not-json', {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
            globalThis.fetch = sinon.stub().resolves(malformedResponse) as unknown as typeof fetch;

            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig);
                assert.fail('expected throw');
            } catch (err) {
                assert.instanceOf(err, Error);
            }
        });

        test('throws when 2xx response does not include access_token', async () => {
            globalThis.fetch = sinon
                .stub()
                .resolves(makeResponse(200, { refresh_token: 'r' })) as unknown as typeof fetch;

            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig);
                assert.fail('expected throw');
            } catch (err) {
                assert.instanceOf(err, Error);
            }
        });

        test('throws when access_token in a 2xx response is not a string', async () => {
            // Zod schema drift / proxy-injected garbage: locks the schema
            // contract on the access_token field.
            globalThis.fetch = sinon
                .stub()
                .resolves(makeResponse(200, { access_token: 12345 })) as unknown as typeof fetch;

            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig);
                assert.fail('expected throw');
            } catch (err) {
                assert.instanceOf(err, Error);
                assert.include((err as Error).message, 'invalid response body');
            }
        });

        test('throws when refresh_token in a 2xx response is not a string', async () => {
            globalThis.fetch = sinon
                .stub()
                .resolves(makeResponse(200, { access_token: 'a', refresh_token: 42 })) as unknown as typeof fetch;

            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig);
                assert.fail('expected throw');
            } catch (err) {
                assert.instanceOf(err, Error);
                assert.include((err as Error).message, 'invalid response body');
            }
        });

        test('throws with SyntaxError cause when body is invalid JSON, preserving original error', async () => {
            const malformedResponse = new Response('not-json', {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
            globalThis.fetch = sinon.stub().resolves(malformedResponse) as unknown as typeof fetch;

            try {
                await fetchFreshAccessToken(sampleEntry, sampleConfig);
                assert.fail('expected throw');
            } catch (err) {
                assert.instanceOf(err, Error);
                assert.include((err as Error).message, 'not valid JSON');
                assert.include((err as Error).message, 'HTTP 200');
                assert.instanceOf((err as Error).cause, SyntaxError);
            }
        });

        test('rejects when response.json() takes longer than the timeout', async () => {
            // Headers arrive instantly, but `response.json()` never settles
            // unless the AbortController inside fetchFreshAccessToken fires
            // and rejects the body read. If the timeout only covered the
            // initial fetch (the pre-fix behaviour), this test would hang
            // until mocha's own 2s timeout — instead we want a quick reject
            // when the body read is aborted.
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
                assert.instanceOf(err, Error);
                assert.strictEqual((err as Error).name, 'AbortError');
                // Sanity: should have rejected close to the timeout, not after a
                // many-second delay.
                assert.isBelow(Date.now() - start, 1500);
            }
        });
    });
});
