import { assert } from 'chai';
import * as sinon from 'sinon';

import { IAsyncDisposableRegistry, IPersistentState, IPersistentStateFactory } from '../common/types';
import { TelemetryService } from './telemetryService';

suite('TelemetryService', () => {
    let analyticsService: TelemetryService;
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

    setup(() => {
        mockUserIdState = createMockPersistentState('');
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
        analyticsService = new TelemetryService(mockStateFactory, mockAsyncDisposableRegistry);

        assert.isDefined(analyticsService);
    });

    test('trackEvent should not initialize when telemetry is disabled', () => {
        analyticsService = new TelemetryService(mockStateFactory, mockAsyncDisposableRegistry);
        stubTelemetryEnabled(analyticsService, false);

        analyticsService.trackEvent({ eventName: 'open_notebook', properties: { prop: 'value' } });

        assert.isUndefined(getPostHogClient(analyticsService), 'PostHog client should not be created');
        assert.isFalse(
            (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).called,
            'Should not create persistent state when telemetry is disabled'
        );
    });

    test('trackEvent should initialize and call capture when telemetry is enabled', () => {
        analyticsService = new TelemetryService(mockStateFactory, mockAsyncDisposableRegistry);
        stubTelemetryEnabled(analyticsService, true);

        analyticsService.trackEvent({ eventName: 'open_notebook' });

        const client = getPostHogClient(analyticsService);

        assert.isDefined(client, 'PostHog client should be initialized');
    });

    test('should generate user ID and call PostHog capture on first trackEvent', () => {
        analyticsService = new TelemetryService(mockStateFactory, mockAsyncDisposableRegistry);
        stubTelemetryEnabled(analyticsService, true);

        analyticsService.trackEvent({ eventName: 'open_notebook' });

        assert.isTrue(
            (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).calledOnce,
            'Should create persistent state'
        );
        assert.isTrue(
            (mockUserIdState.updateValue as sinon.SinonStub).calledOnce,
            'Should generate and persist user ID'
        );

        const generatedId = (mockUserIdState.updateValue as sinon.SinonStub).firstCall.args[0];

        assert.isString(generatedId);
        assert.isNotEmpty(generatedId, 'Generated user ID should not be empty');

        // Stub capture on the initialized client and verify next event
        const client = getPostHogClient(analyticsService);

        assert.isDefined(client, 'PostHog client should be initialized');

        const captureStub = sinon.stub();
        client.capture = captureStub;

        analyticsService.trackEvent({ eventName: 'execute_notebook' });

        assert.isTrue(captureStub.calledOnce, 'PostHog capture should be called');
        assert.deepStrictEqual(captureStub.firstCall.args[0], {
            distinctId: generatedId,
            event: 'execute_notebook',
            properties: undefined
        });
    });

    test('should reuse existing user ID', () => {
        mockUserIdState = createMockPersistentState('existing-user-id');
        (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).returns(mockUserIdState);

        analyticsService = new TelemetryService(mockStateFactory, mockAsyncDisposableRegistry);
        stubTelemetryEnabled(analyticsService, true);

        analyticsService.trackEvent({ eventName: 'open_notebook' });

        assert.isFalse(
            (mockUserIdState.updateValue as sinon.SinonStub).called,
            'Should not update value when user ID already exists'
        );
    });

    test('dispose should not throw even when client is not initialized', async () => {
        analyticsService = new TelemetryService(mockStateFactory, mockAsyncDisposableRegistry);

        await assert.isFulfilled(analyticsService.dispose());
    });
});
