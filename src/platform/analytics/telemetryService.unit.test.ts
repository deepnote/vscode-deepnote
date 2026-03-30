import { assert } from 'chai';
import * as sinon from 'sinon';

import { IAsyncDisposableRegistry, IPersistentState, IPersistentStateFactory } from '../common/types';
import { TelemetryService } from './telemetryService';

suite('TelemetryService', () => {
    let analyticsService: TelemetryService;
    let mockStateFactory: IPersistentStateFactory;
    let mockAsyncDisposableRegistry: IAsyncDisposableRegistry;
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
        mockAsyncDisposableRegistry = {
            push: sinon.stub(),
            dispose: sinon.stub().resolves()
        };
    });

    teardown(() => {
        sandbox.restore();
    });

    test('should create instance without errors', () => {
        analyticsService = new TelemetryService(mockStateFactory, mockAsyncDisposableRegistry);

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

        analyticsService = new TelemetryService(mockStateFactory, mockAsyncDisposableRegistry);

        assert.doesNotThrow(() => {
            analyticsService.trackEvent({ eventName: 'open_notebook', properties: { prop: 'value' } });
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

        analyticsService = new TelemetryService(mockStateFactory, mockAsyncDisposableRegistry);

        assert.doesNotThrow(() => {
            analyticsService.trackEvent({ eventName: 'open_notebook' });
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

        analyticsService = new TelemetryService(mockStateFactory, mockAsyncDisposableRegistry);
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
    });

    test('should reuse existing user ID', () => {
        const vscode = require('vscode');

        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(() => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        }));

        mockUserIdState = createMockPersistentState('existing-user-id');
        (mockStateFactory.createGlobalPersistentState as sinon.SinonStub).returns(mockUserIdState);

        analyticsService = new TelemetryService(mockStateFactory, mockAsyncDisposableRegistry);
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
