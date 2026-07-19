import { assert, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';

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
        analyticsService = new TelemetryService(mockDisposables, mockStateFactory, mockAsyncDisposableRegistry);

        assert.isDefined(analyticsService);
    });

    test('activate should not create client when telemetry is disabled', async () => {
        analyticsService = new TelemetryService(mockDisposables, mockStateFactory, mockAsyncDisposableRegistry);
        stubTelemetryEnabled(analyticsService, false);

        await analyticsService.activate();

        assert.isNull(getPostHogClient(analyticsService), 'PostHog client should not be created');
        assert.isTrue(
            (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).calledOnce,
            'Should still create persistent state during construction'
        );
    });

    test('activate should create client when telemetry is enabled', async () => {
        analyticsService = new TelemetryService(mockDisposables, mockStateFactory, mockAsyncDisposableRegistry);
        stubTelemetryEnabled(analyticsService, true);
        stubPostHogConfigured(analyticsService, true);
        stubClientFactory(analyticsService);

        await analyticsService.activate();

        const client = getPostHogClient(analyticsService);

        assert.isNotNull(client, 'PostHog client should be initialized');
    });

    test('activate should not create client when PostHog is not configured', async () => {
        analyticsService = new TelemetryService(mockDisposables, mockStateFactory, mockAsyncDisposableRegistry);
        stubTelemetryEnabled(analyticsService, true);
        stubPostHogConfigured(analyticsService, false);

        await analyticsService.activate();

        assert.isNull(
            getPostHogClient(analyticsService),
            'PostHog client should not be created with the placeholder key'
        );
    });

    test('should generate user ID and call PostHog capture on first trackEvent', async () => {
        (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).callsFake(
            (_key: string, defaultValue: string) => createMockPersistentState(defaultValue)
        );

        analyticsService = new TelemetryService(mockDisposables, mockStateFactory, mockAsyncDisposableRegistry);
        stubTelemetryEnabled(analyticsService, true);
        stubPostHogConfigured(analyticsService, true);
        stubClientFactory(analyticsService);

        await analyticsService.activate();

        const createStateSpy = mockStateFactory.createGlobalPersistentState as sinon.SinonStub;

        assert.isTrue(createStateSpy.calledOnce, 'Should create persistent state');

        const generatedId = createStateSpy.firstCall.args[1];

        assert.isString(generatedId);
        assert.isNotEmpty(generatedId, 'Generated user ID should not be empty');

        const client = getPostHogClient(analyticsService);

        assert.isNotNull(client, 'PostHog client should be initialized');

        const captureStub = sinon.stub();
        client.capture = captureStub;

        analyticsService.trackEvent({ eventName: 'execute_notebook' });

        assert.isTrue(captureStub.calledOnce, 'PostHog capture should be called');
        assert.deepStrictEqual(captureStub.firstCall.args[0], {
            distinctId: generatedId,
            event: 'execute_notebook',
            properties: { channel: 'development', $process_person_profile: false }
        });
    });

    test('should reuse existing user ID', async () => {
        mockUserIdState = createMockPersistentState('existing-user-id');
        (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).returns(mockUserIdState);

        analyticsService = new TelemetryService(mockDisposables, mockStateFactory, mockAsyncDisposableRegistry);
        stubTelemetryEnabled(analyticsService, true);

        await analyticsService.activate();

        assert.isFalse(
            (mockUserIdState.updateValue as sinon.SinonStub).called,
            'Should not update value when user ID already exists'
        );
    });

    test('settings change should destroy client when telemetry is disabled', async () => {
        analyticsService = new TelemetryService(mockDisposables, mockStateFactory, mockAsyncDisposableRegistry);
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
        analyticsService = new TelemetryService(mockDisposables, mockStateFactory, mockAsyncDisposableRegistry);
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
        analyticsService = new TelemetryService(mockDisposables, mockStateFactory, mockAsyncDisposableRegistry);

        await assert.isFulfilled(analyticsService.dispose());
    });
});
