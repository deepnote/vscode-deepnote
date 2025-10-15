import { assert } from 'chai';
import { instance, mock, when, verify } from 'ts-mockito';
import { DeepnoteEnvironmentsActivationService } from './deepnoteEnvironmentsActivationService';
import { IDeepnoteEnvironmentManager } from '../types';
import { DeepnoteEnvironmentsView } from './deepnoteEnvironmentsView';

suite('DeepnoteEnvironmentsActivationService', () => {
    let activationService: DeepnoteEnvironmentsActivationService;
    let mockConfigManager: IDeepnoteEnvironmentManager;
    let mockEnvironmentsView: DeepnoteEnvironmentsView;

    setup(() => {
        mockConfigManager = mock<IDeepnoteEnvironmentManager>();
        mockEnvironmentsView = mock<DeepnoteEnvironmentsView>();

        activationService = new DeepnoteEnvironmentsActivationService(
            instance(mockConfigManager),
            instance(mockEnvironmentsView)
        );
    });

    suite('activate', () => {
        test('should call initialize on environment manager', async () => {
            when(mockConfigManager.initialize()).thenResolve();

            activationService.activate();

            // Wait for async initialization
            await new Promise((resolve) => setTimeout(resolve, 100));

            verify(mockConfigManager.initialize()).once();
        });

        test('should handle initialization errors gracefully', async () => {
            when(mockConfigManager.initialize()).thenReject(new Error('Initialization failed'));

            // Should not throw
            activationService.activate();

            // Wait for async initialization
            await new Promise((resolve) => setTimeout(resolve, 100));

            verify(mockConfigManager.initialize()).once();
        });

        test('should not throw when activate is called', () => {
            when(mockConfigManager.initialize()).thenResolve();

            assert.doesNotThrow(() => {
                activationService.activate();
            });
        });
    });

    suite('constructor', () => {
        test('should create service with dependencies', () => {
            assert.ok(activationService);
        });

        test('should accept environment manager', () => {
            const service = new DeepnoteEnvironmentsActivationService(
                instance(mockConfigManager),
                instance(mockEnvironmentsView)
            );

            assert.ok(service);
        });

        test('should accept environments view', () => {
            const service = new DeepnoteEnvironmentsActivationService(
                instance(mockConfigManager),
                instance(mockEnvironmentsView)
            );

            assert.ok(service);
        });
    });
});
