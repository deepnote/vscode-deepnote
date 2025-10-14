import { assert } from 'chai';
import { instance, mock, when, verify } from 'ts-mockito';
import { DeepnoteConfigurationsActivationService } from './deepnoteConfigurationsActivationService';
import { IDeepnoteConfigurationManager } from '../types';
import { DeepnoteConfigurationsView } from './deepnoteConfigurationsView';

suite('DeepnoteConfigurationsActivationService', () => {
    let activationService: DeepnoteConfigurationsActivationService;
    let mockConfigManager: IDeepnoteConfigurationManager;
    let mockConfigurationsView: DeepnoteConfigurationsView;

    setup(() => {
        mockConfigManager = mock<IDeepnoteConfigurationManager>();
        mockConfigurationsView = mock<DeepnoteConfigurationsView>();

        activationService = new DeepnoteConfigurationsActivationService(
            instance(mockConfigManager),
            instance(mockConfigurationsView)
        );
    });

    suite('activate', () => {
        test('should call initialize on configuration manager', async () => {
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

        test('should accept configuration manager', () => {
            const service = new DeepnoteConfigurationsActivationService(
                instance(mockConfigManager),
                instance(mockConfigurationsView)
            );

            assert.ok(service);
        });

        test('should accept configurations view', () => {
            const service = new DeepnoteConfigurationsActivationService(
                instance(mockConfigManager),
                instance(mockConfigurationsView)
            );

            assert.ok(service);
        });
    });
});
