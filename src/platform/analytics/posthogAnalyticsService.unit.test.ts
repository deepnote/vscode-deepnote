import { assert } from 'chai';
import * as sinon from 'sinon';

import { IPersistentState, IPersistentStateFactory } from '../common/types';
import { PostHogAnalyticsService } from './posthogAnalyticsService';

suite('PostHogAnalyticsService', () => {
    let analyticsService: PostHogAnalyticsService;
    let mockStateFactory: IPersistentStateFactory;
    let mockUserIdState: IPersistentState<string>;
    let sandbox: sinon.SinonSandbox;

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

    setup(() => {
        sandbox = sinon.createSandbox();
        mockUserIdState = createMockPersistentState('');
        mockStateFactory = {
            createGlobalPersistentState: sinon.stub().returns(mockUserIdState),
            createWorkspacePersistentState: sinon.stub().returns(mockUserIdState)
        } as unknown as IPersistentStateFactory;
    });

    teardown(() => {
        sandbox.restore();
    });

    test('should create instance without errors', () => {
        analyticsService = new PostHogAnalyticsService(mockStateFactory);

        assert.isDefined(analyticsService);
    });

    test('trackEvent should not throw when telemetry is disabled', () => {
        // Stub workspace.getConfiguration to return telemetry disabled
        const vscode = require('vscode');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section: any) => ({
            get: (_key: string, defaultValue: unknown) => {
                if (section === 'deepnote' && _key === 'telemetry.enabled') {
                    return false;
                }

                return defaultValue;
            }
        }));

        analyticsService = new PostHogAnalyticsService(mockStateFactory);

        assert.doesNotThrow(() => {
            analyticsService.trackEvent('test_event', { prop: 'value' });
        });

        // Should not have initialized (no state access)
        assert.isFalse(
            (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).called,
            'Should not create persistent state when telemetry is disabled'
        );
    });

    test('trackEvent should not throw when VSCode telemetry level is off', () => {
        const vscode = require('vscode');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section: any) => ({
            get: (_key: string, defaultValue: unknown) => {
                if (section === 'telemetry' && _key === 'telemetryLevel') {
                    return 'off';
                }

                return defaultValue;
            }
        }));

        analyticsService = new PostHogAnalyticsService(mockStateFactory);

        assert.doesNotThrow(() => {
            analyticsService.trackEvent('test_event');
        });

        assert.isFalse(
            (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).called,
            'Should not create persistent state when VSCode telemetry is off'
        );
    });

    test('should generate user ID on first trackEvent when telemetry enabled', () => {
        const vscode = require('vscode');

        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(() => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        }));

        analyticsService = new PostHogAnalyticsService(mockStateFactory);
        analyticsService.trackEvent('test_event');

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
    });

    test('should reuse existing user ID', () => {
        const vscode = require('vscode');

        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(() => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        }));

        mockUserIdState = createMockPersistentState('existing-user-id');
        (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).returns(mockUserIdState);

        analyticsService = new PostHogAnalyticsService(mockStateFactory);
        analyticsService.trackEvent('test_event');

        assert.isFalse(
            (mockUserIdState.updateValue as sinon.SinonStub).called,
            'Should not update value when user ID already exists'
        );
    });

    test('shutdown should not throw even when client is not initialized', async () => {
        analyticsService = new PostHogAnalyticsService(mockStateFactory);

        await assert.isFulfilled(analyticsService.shutdown());
    });
});
