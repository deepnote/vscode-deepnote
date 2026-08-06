import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { EventEmitter, ExtensionMode, SecretStorage, SecretStorageChangeEvent } from 'vscode';

import { mockedVSCodeNamespaces } from '../../test/vscode-mock';
import { IExtensionContext } from '../../platform/common/types';
import { ServiceContainer } from '../../platform/ioc/container';
import {
    clearSecret,
    getOrPromptOpenAiApiKey,
    getOrPromptSecret,
    getSecret,
    promptForSecret,
    setSecret
} from './deepnoteSecretStore';

suite('deepnoteSecretStore', () => {
    const secretStorage = new Map<string, string>();
    let context: IExtensionContext;
    let secrets: SecretStorage;
    let onDidChangeSecrets: EventEmitter<SecretStorageChangeEvent>;

    setup(() => {
        secretStorage.clear();
        context = mock<IExtensionContext>();
        secrets = mock<SecretStorage>();
        onDidChangeSecrets = new EventEmitter<SecretStorageChangeEvent>();

        const serviceContainer = mock<ServiceContainer>();
        sinon.stub(ServiceContainer, 'instance').get(() => instance(serviceContainer));
        when(serviceContainer.get<IExtensionContext>(IExtensionContext)).thenReturn(instance(context));
        when(context.extensionMode).thenReturn(ExtensionMode.Production);
        when(context.secrets).thenReturn(instance(secrets));
        when(secrets.onDidChange).thenReturn(onDidChangeSecrets.event);
        when(secrets.get(anything())).thenCall((key: string) => Promise.resolve(secretStorage.get(key)));
        when(secrets.store(anything(), anything())).thenCall((key: string, value: string) => {
            secretStorage.set(key, value);
            onDidChangeSecrets.fire({ key });

            return Promise.resolve();
        });
        when(secrets.delete(anything())).thenCall((key: string) => {
            secretStorage.delete(key);

            return Promise.resolve();
        });
    });

    teardown(() => {
        sinon.restore();
    });

    suite('generic getSecret', () => {
        test('returns value when stored', async () => {
            secretStorage.set('customKey', 'custom-value');

            const value = await getSecret('customKey');

            assert.strictEqual(value, 'custom-value');
        });

        test('returns undefined when not set', async () => {
            const value = await getSecret('customKey');

            assert.isUndefined(value);
        });

        test('returns undefined when value is empty string', async () => {
            secretStorage.set('customKey', '');

            const value = await getSecret('customKey');

            assert.isUndefined(value);
        });
    });

    suite('generic setSecret', () => {
        test('stores value in secrets', async () => {
            await setSecret('customKey', 'custom-value');

            assert.strictEqual(secretStorage.get('customKey'), 'custom-value');
        });
    });

    suite('generic clearSecret', () => {
        test('deletes value from secrets', async () => {
            secretStorage.set('customKey', 'custom-value');

            await clearSecret('customKey');

            assert.isFalse(secretStorage.has('customKey'));
        });
    });

    suite('generic promptForSecret', () => {
        test('stores and returns value when user enters input', async () => {
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('user-input'));

            const value = await promptForSecret('customKey', {
                prompt: 'Enter value',
                placeHolder: 'placeholder',
                password: false
            });

            assert.strictEqual(value, 'user-input');
            assert.strictEqual(secretStorage.get('customKey'), 'user-input');
        });

        test('returns undefined when user cancels', async () => {
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            const value = await promptForSecret('customKey', { prompt: 'Enter value' });

            assert.isUndefined(value);
        });

        test('returns undefined when user enters empty string', async () => {
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('   '));

            const value = await promptForSecret('customKey', { prompt: 'Enter value' });

            assert.isUndefined(value);
        });
    });

    suite('generic getOrPromptSecret', () => {
        test('returns value when present in store', async () => {
            secretStorage.set('customKey', 'stored-value');

            const value = await getOrPromptSecret('customKey', { prompt: 'Enter value' }, 'Value is required');

            assert.strictEqual(value, 'stored-value');
        });

        test('prompts and returns value when missing', async () => {
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('prompted-value'));

            const value = await getOrPromptSecret('customKey', { prompt: 'Enter value' }, 'Value is required');

            assert.strictEqual(value, 'prompted-value');
        });

        for (const scenario of [
            {
                label: 'generic',
                run: () => getOrPromptSecret('customKey', { prompt: 'Enter value' }, 'Value is required'),
                assertError: (e: Error) => assert.strictEqual(e.message, 'Value is required')
            },
            {
                label: 'openAi',
                run: () => getOrPromptOpenAiApiKey(),
                assertError: (e: Error) => assert.include(e.message, 'OpenAI API key is not set')
            }
        ]) {
            test(`throws when value missing and user cancels prompt (${scenario.label})`, async () => {
                when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

                try {
                    await scenario.run();
                    assert.fail('Should have thrown');
                } catch (e) {
                    scenario.assertError(e as Error);
                }
            });
        }
    });
});
