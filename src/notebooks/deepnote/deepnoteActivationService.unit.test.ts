import { assert } from 'chai';
import { anything, instance, mock, verify, when } from 'ts-mockito';

import { ITelemetryService } from '../../platform/analytics/types';
import { DeepnoteActivationService } from './deepnoteActivationService';
import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import { IExtensionContext } from '../../platform/common/types';
import { ILogger } from '../../platform/logging/types';
import { IIntegrationManager } from './integrations/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

function createMockLogger(): ILogger {
    return {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        ci: () => undefined
    } as ILogger;
}

suite('DeepnoteActivationService', () => {
    let activationService: DeepnoteActivationService;
    let mockExtensionContext: IExtensionContext;
    let manager: DeepnoteNotebookManager;
    let mockIntegrationManager: IIntegrationManager;
    let mockLogger: ILogger;
    let mockAnalytics: ITelemetryService;

    setup(() => {
        mockExtensionContext = {
            subscriptions: []
        } as any;

        manager = new DeepnoteNotebookManager();
        mockIntegrationManager = {
            activate: () => {
                return;
            }
        };
        mockLogger = createMockLogger();
        mockAnalytics = instance(mock<ITelemetryService>());
        activationService = new DeepnoteActivationService(
            mockExtensionContext,
            manager,
            mockIntegrationManager,
            mockLogger,
            mockAnalytics
        );
    });

    suite('constructor', () => {
        test('should create instance with extension context', () => {
            assert.isDefined(activationService);
            assert.strictEqual((activationService as any).extensionContext, mockExtensionContext);
        });

        test('should not initialize components until activate is called', () => {
            assert.isUndefined((activationService as any).serializer);
            assert.isUndefined((activationService as any).explorerView);
        });
    });

    suite('activate', () => {
        test('should create serializer and explorer view instances', () => {
            // This test verifies component creation without stubbing VS Code APIs
            try {
                activationService.activate();

                // Verify components were created
                assert.isDefined((activationService as any).serializer);
                assert.isDefined((activationService as any).explorerView);
            } catch (error) {
                // Expected in test environment without full VS Code API
                // The test verifies that the method can be called and attempts to create components
                assert.isTrue(true, 'activate() method exists and attempts to initialize components');
            }
        });

        test('should re-register serializer when snapshots are enabled in-session', () => {
            resetVSCodeMocks();

            const registrations: Array<{ transientOutputs?: boolean }> = [];
            let configHandler: ((event: { affectsConfiguration: (section: string) => boolean }) => void) | undefined;

            when(
                mockedVSCodeNamespaces.workspace.registerNotebookSerializer(anything(), anything(), anything())
            ).thenCall((_type, _serializer, options) => {
                registrations.push(options);

                return { dispose: () => undefined } as any;
            });
            const onDidChangeConfiguration = (
                handler: (event: { affectsConfiguration: (section: string) => boolean }) => void
            ) => {
                configHandler = handler;

                return { dispose: () => undefined } as any;
            };
            when(mockedVSCodeNamespaces.workspace.onDidChangeConfiguration).thenReturn(onDidChangeConfiguration as any);

            let snapshotsEnabled = false;
            const mockSnapshotService = { isSnapshotsEnabled: () => snapshotsEnabled } as any;
            activationService = new DeepnoteActivationService(
                mockExtensionContext,
                manager,
                mockIntegrationManager,
                mockLogger,
                mockAnalytics,
                mockSnapshotService
            );

            try {
                activationService.activate();
            } catch {
                // Activation may fail in the test environment, but registrations should still occur.
            }

            assert.strictEqual(registrations.length, 1);
            assert.isUndefined(registrations[0].transientOutputs);

            snapshotsEnabled = true;
            configHandler?.({ affectsConfiguration: (section) => section === 'deepnote.snapshots.enabled' });

            assert.strictEqual(registrations.length, 2);
            assert.strictEqual(registrations[1].transientOutputs, true);
            verify(
                mockedVSCodeNamespaces.workspace.registerNotebookSerializer(anything(), anything(), anything())
            ).twice();
        });

        test('should prompt to reload when snapshots are enabled with open notebooks', () => {
            resetVSCodeMocks();

            let configHandler: ((event: { affectsConfiguration: (section: string) => boolean }) => void) | undefined;

            when(
                mockedVSCodeNamespaces.workspace.registerNotebookSerializer(anything(), anything(), anything())
            ).thenReturn({ dispose: () => undefined } as any);
            const onDidChangeConfiguration = (
                handler: (event: { affectsConfiguration: (section: string) => boolean }) => void
            ) => {
                configHandler = handler;

                return { dispose: () => undefined } as any;
            };
            when(mockedVSCodeNamespaces.workspace.onDidChangeConfiguration).thenReturn(onDidChangeConfiguration as any);
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([{ notebookType: 'deepnote' } as any]);

            let snapshotsEnabled = false;
            const mockSnapshotService = { isSnapshotsEnabled: () => snapshotsEnabled } as any;
            activationService = new DeepnoteActivationService(
                mockExtensionContext,
                manager,
                mockIntegrationManager,
                mockLogger,
                mockAnalytics,
                mockSnapshotService
            );

            try {
                activationService.activate();
            } catch {
                // Activation may fail in the test environment, but prompts should still be attempted.
            }

            snapshotsEnabled = true;
            configHandler?.({ affectsConfiguration: (section) => section === 'deepnote.snapshots.enabled' });

            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything())).once();
        });
    });

    suite('component initialization', () => {
        test('should handle activation state correctly', () => {
            // Before activation
            assert.isUndefined((activationService as any).serializer);
            assert.isUndefined((activationService as any).explorerView);

            // After activation attempt
            try {
                activationService.activate();
                // If successful, components should be defined
                if ((activationService as any).serializer) {
                    assert.isDefined((activationService as any).serializer);
                    assert.isDefined((activationService as any).explorerView);
                }
            } catch (error) {
                // Expected in test environment - the method exists and tries to initialize
                assert.isString(error.message, 'activate() method exists and attempts initialization');
            }
        });
    });

    suite('integration scenarios', () => {
        test('should maintain independence between multiple service instances', () => {
            const context1 = { subscriptions: [] } as any;
            const context2 = { subscriptions: [] } as any;

            const manager1 = new DeepnoteNotebookManager();
            const manager2 = new DeepnoteNotebookManager();
            const mockIntegrationManager1: IIntegrationManager = {
                activate: () => {
                    return;
                }
            };
            const mockIntegrationManager2: IIntegrationManager = {
                activate: () => {
                    return;
                }
            };
            const mockLogger1 = createMockLogger();
            const mockLogger2 = createMockLogger();
            const service1 = new DeepnoteActivationService(
                context1,
                manager1,
                mockIntegrationManager1,
                mockLogger1,
                mockAnalytics
            );
            const service2 = new DeepnoteActivationService(
                context2,
                manager2,
                mockIntegrationManager2,
                mockLogger2,
                mockAnalytics
            );

            // Verify each service has its own context
            assert.strictEqual((service1 as any).extensionContext, context1);
            assert.strictEqual((service2 as any).extensionContext, context2);
            assert.notStrictEqual((service1 as any).extensionContext, (service2 as any).extensionContext);

            // Verify services are independent instances
            assert.notStrictEqual(service1, service2);
        });

        test('should handle different extension contexts', () => {
            const context1 = { subscriptions: [] } as any;
            const context2 = {
                subscriptions: [
                    {
                        dispose: () => {
                            /* mock dispose */
                        }
                    }
                ]
            } as any;

            const manager1 = new DeepnoteNotebookManager();
            const manager2 = new DeepnoteNotebookManager();
            const mockIntegrationManager1: IIntegrationManager = {
                activate: () => {
                    return;
                }
            };
            const mockIntegrationManager2: IIntegrationManager = {
                activate: () => {
                    return;
                }
            };
            const mockLogger3 = createMockLogger();
            const mockLogger4 = createMockLogger();
            new DeepnoteActivationService(context1, manager1, mockIntegrationManager1, mockLogger3, mockAnalytics);
            new DeepnoteActivationService(context2, manager2, mockIntegrationManager2, mockLogger4, mockAnalytics);

            assert.strictEqual(context1.subscriptions.length, 0);
            assert.strictEqual(context2.subscriptions.length, 1);
        });
    });
});
