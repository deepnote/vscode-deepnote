import { assert, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';

import { IApplicationEnvironment } from '../common/application/types';
import {
    IAsyncDisposableRegistry,
    IDisposableRegistry,
    IPersistentState,
    IPersistentStateFactory
} from '../common/types';
import { TelemetryService } from './telemetryService';

use(chaiAsPromised);

suite('TelemetryService', () => {
    let analyticsService: TelemetryService;
    let mockDisposables: IDisposableRegistry;
    let mockStateFactory: IPersistentStateFactory;
    let mockAsyncDisposableRegistry: IAsyncDisposableRegistry;
    let mockUserIdState: IPersistentState<string>;
    let mockAppEnv: IApplicationEnvironment;

    function createMockPersistentState(initialValue: string): IPersistentState<string> {
        let storedValue = initialValue;

        return {
            get value() {
                return storedValue;
            },
            updateValue: sinon.stub().callsFake(async (newValue: string) => {
                storedValue = newValue;
            })
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function getPostHogClient(service: TelemetryService): any {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (service as any).client;
    }

    function stubTelemetryEnabled(service: TelemetryService, enabled: boolean): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (service as any).isTelemetryEnabled = () => enabled;
    }

    function stubPostHogConfigured(service: TelemetryService, configured: boolean): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (service as any).isPostHogConfigured = () => configured;
    }

    // Replaces createClient so no test constructs a real, network-capable PostHog client,
    // while preserving the real configured + enabled gating.
    function stubClientFactory(service: TelemetryService): { capture: sinon.SinonStub; shutdown: sinon.SinonStub } {
        const fakeClient = { capture: sinon.stub(), shutdown: sinon.stub().resolves() };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const internal = service as any;
        internal.createClient = () => {
            if (internal.client || !internal.isPostHogConfigured() || !internal.isTelemetryEnabled()) {
                return;
            }

            internal.client = fakeClient;
        };

        return fakeClient;
    }

    setup(() => {
        mockUserIdState = createMockPersistentState('');
        mockDisposables = [];
        mockAppEnv = { extensionVersion: '1.2.3' };
        mockStateFactory = {
            createGlobalPersistentState: sinon.stub().returns(mockUserIdState),
            createWorkspacePersistentState: sinon.stub().returns(mockUserIdState)
        } as unknown as IPersistentStateFactory;
        mockAsyncDisposableRegistry = {
            push: sinon.stub(),
            dispose: sinon.stub().resolves()
        };
    });

    test('should create instance without errors', () => {
        analyticsService = new TelemetryService(
            mockDisposables,
            mockStateFactory,
            mockAsyncDisposableRegistry,
            mockAppEnv
        );

        assert.isDefined(analyticsService);
    });

    test('activate should not create client when telemetry is disabled', async () => {
        analyticsService = new TelemetryService(
            mockDisposables,
            mockStateFactory,
            mockAsyncDisposableRegistry,
            mockAppEnv
        );
        stubTelemetryEnabled(analyticsService, false);

        await analyticsService.activate();

        assert.isNull(getPostHogClient(analyticsService), 'PostHog client should not be created');
        assert.isTrue(
            (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).calledOnce,
            'Should still create persistent state during construction'
        );
    });

    test('activate should create client when telemetry is enabled', async () => {
        analyticsService = new TelemetryService(
            mockDisposables,
            mockStateFactory,
            mockAsyncDisposableRegistry,
            mockAppEnv
        );
        stubTelemetryEnabled(analyticsService, true);
        stubPostHogConfigured(analyticsService, true);
        stubClientFactory(analyticsService);

        await analyticsService.activate();

        const client = getPostHogClient(analyticsService);

        assert.isNotNull(client, 'PostHog client should be initialized');
    });

    test('activate should not create client when PostHog is not configured', async () => {
        analyticsService = new TelemetryService(
            mockDisposables,
            mockStateFactory,
            mockAsyncDisposableRegistry,
            mockAppEnv
        );
        stubTelemetryEnabled(analyticsService, true);
        stubPostHogConfigured(analyticsService, false);

        await analyticsService.activate();

        assert.isNull(
            getPostHogClient(analyticsService),
            'PostHog client should not be created with the placeholder key'
        );
    });

    test('should generate and persist a user ID and send it as distinctId with common properties', async () => {
        const userIdState = createMockPersistentState('');
        (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).returns(userIdState);

        analyticsService = new TelemetryService(
            mockDisposables,
            mockStateFactory,
            mockAsyncDisposableRegistry,
            mockAppEnv
        );
        stubTelemetryEnabled(analyticsService, true);
        stubPostHogConfigured(analyticsService, true);
        const fakeClient = stubClientFactory(analyticsService);

        await analyticsService.activate();

        assert.isTrue(
            (userIdState.updateValue as sinon.SinonStub).calledOnce,
            'A user ID should be generated and persisted on first activation'
        );

        const persistedId = userIdState.value;

        assert.isNotEmpty(persistedId, 'Persisted user ID should not be empty');

        analyticsService.trackEvent({ eventName: 'execute_notebook' });

        assert.isTrue(fakeClient.capture.calledOnce, 'PostHog capture should be called');

        const captured = fakeClient.capture.firstCall.args[0];

        assert.strictEqual(captured.distinctId, persistedId, 'distinctId should be the persisted user ID');
        assert.strictEqual(captured.event, 'execute_notebook');
        assert.strictEqual(captured.properties.$process_person_profile, false, 'events must be personless');
        assert.strictEqual(captured.properties.channel, 'development');
        assert.strictEqual(captured.properties.extensionVersion, '1.2.3', 'common properties must be attached');
    });

    test('should reuse existing user ID', async () => {
        mockUserIdState = createMockPersistentState('existing-user-id');
        (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).returns(mockUserIdState);

        analyticsService = new TelemetryService(
            mockDisposables,
            mockStateFactory,
            mockAsyncDisposableRegistry,
            mockAppEnv
        );
        stubTelemetryEnabled(analyticsService, true);

        await analyticsService.activate();

        assert.isFalse(
            (mockUserIdState.updateValue as sinon.SinonStub).called,
            'Should not update value when user ID already exists'
        );
    });

    // A fresh profile whose global-state write never settles or outright rejects. Either way the
    // client and distinctId must not wait on it — activate() is registered as a sync service.
    function buildServiceWithUnsettledPersist(updateValue: sinon.SinonStub) {
        (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).returns({
            get value() {
                return '';
            },
            updateValue
        } as IPersistentState<string>);

        analyticsService = new TelemetryService(
            mockDisposables,
            mockStateFactory,
            mockAsyncDisposableRegistry,
            mockAppEnv
        );
        stubTelemetryEnabled(analyticsService, true);
        stubPostHogConfigured(analyticsService, true);

        return stubClientFactory(analyticsService);
    }

    test('should track events without waiting for user ID persistence to settle', () => {
        const fakeClient = buildServiceWithUnsettledPersist(sinon.stub().returns(new Promise<void>(() => {})));

        analyticsService.activate();
        analyticsService.trackEvent({ eventName: 'execute_notebook' });

        assert.isTrue(
            fakeClient.capture.calledOnce,
            'The first event must not be dropped while persistence is pending'
        );
        assert.isNotEmpty(
            fakeClient.capture.firstCall.args[0].distinctId,
            'distinctId should come from the in-memory user ID'
        );
    });

    test('should still create the client when persisting the user ID fails', () => {
        buildServiceWithUnsettledPersist(sinon.stub().rejects(new Error('global state unavailable')));

        analyticsService.activate();

        assert.isNotNull(
            getPostHogClient(analyticsService),
            'A failed user ID write must not disable telemetry for the whole session'
        );
    });

    test('settings change should destroy client when telemetry is disabled', async () => {
        analyticsService = new TelemetryService(
            mockDisposables,
            mockStateFactory,
            mockAsyncDisposableRegistry,
            mockAppEnv
        );
        stubTelemetryEnabled(analyticsService, true);
        stubPostHogConfigured(analyticsService, true);
        stubClientFactory(analyticsService);

        await analyticsService.activate();

        const client = getPostHogClient(analyticsService);

        assert.isNotNull(client, 'Client should be created initially');

        const shutdownStub = sinon.stub().resolves();
        client.shutdown = shutdownStub;

        stubTelemetryEnabled(analyticsService, false);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (analyticsService as any).handleConfigChanged();

        assert.isNull(getPostHogClient(analyticsService), 'Client should be destroyed when telemetry is disabled');
    });

    test('settings change should create client when telemetry is enabled', async () => {
        analyticsService = new TelemetryService(
            mockDisposables,
            mockStateFactory,
            mockAsyncDisposableRegistry,
            mockAppEnv
        );
        stubTelemetryEnabled(analyticsService, false);
        stubPostHogConfigured(analyticsService, true);
        stubClientFactory(analyticsService);

        await analyticsService.activate();

        assert.isNull(getPostHogClient(analyticsService), 'Client should not be created initially');

        stubTelemetryEnabled(analyticsService, true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (analyticsService as any).handleConfigChanged();

        assert.isNotNull(getPostHogClient(analyticsService), 'Client should be created when telemetry is enabled');
    });

    test('dispose should not throw even when client is not initialized', async () => {
        analyticsService = new TelemetryService(
            mockDisposables,
            mockStateFactory,
            mockAsyncDisposableRegistry,
            mockAppEnv
        );

        await assert.isFulfilled(analyticsService.dispose());
    });
});
