import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';

import { IEncryptedStorage } from '../../platform/common/application/types';
import { mockedVSCodeNamespaces } from '../../test/vscode-mock';
import { clearOpenAiApiKey, getOrPromptOpenAiApiKey, promptForOpenAiApiKey } from './deepnoteSecretStore';

// The real EncryptedStorage namespaces secrets as `${service}.${key}`; the fake mirrors that so a
// store/retrieve mismatch between the two service names would surface here.
const STORED_KEY = 'deepnote-agent.openAiApiKey';

suite('deepnoteSecretStore', () => {
    let storageData: Map<string, string>;
    let encryptedStorage: IEncryptedStorage;
    let promptCount: number;

    function whenPromptReturns(value: string | undefined) {
        when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenCall(() => {
            promptCount++;

            return Promise.resolve(value);
        });
    }

    setup(() => {
        storageData = new Map();
        promptCount = 0;
        encryptedStorage = mock<IEncryptedStorage>();

        when(encryptedStorage.store(anything(), anything(), anything())).thenCall(
            (service: string, key: string, value: string | undefined) => {
                if (value === undefined) {
                    storageData.delete(`${service}.${key}`);
                } else {
                    storageData.set(`${service}.${key}`, value);
                }

                return Promise.resolve();
            }
        );

        when(encryptedStorage.retrieve(anything(), anything())).thenCall((service: string, key: string) =>
            Promise.resolve(storageData.get(`${service}.${key}`))
        );

        whenPromptReturns(undefined);
    });

    suite('promptForOpenAiApiKey', () => {
        test('trims, stores and returns the entered key', async () => {
            whenPromptReturns('  sk-entered  ');

            const value = await promptForOpenAiApiKey(instance(encryptedStorage));

            assert.strictEqual(value, 'sk-entered');
            assert.strictEqual(storageData.get(STORED_KEY), 'sk-entered');
        });

        for (const input of [undefined, '   ']) {
            test(`stores nothing and returns undefined when the user enters ${JSON.stringify(input)}`, async () => {
                whenPromptReturns(input);

                const value = await promptForOpenAiApiKey(instance(encryptedStorage));

                assert.isUndefined(value);
                assert.isFalse(storageData.has(STORED_KEY));
            });
        }
    });

    suite('clearOpenAiApiKey', () => {
        test('deletes the stored key', async () => {
            storageData.set(STORED_KEY, 'sk-stored');

            await clearOpenAiApiKey(instance(encryptedStorage));

            assert.isFalse(storageData.has(STORED_KEY));
        });
    });

    suite('getOrPromptOpenAiApiKey', () => {
        test('returns the stored key without prompting', async () => {
            storageData.set(STORED_KEY, 'sk-stored');

            const value = await getOrPromptOpenAiApiKey(instance(encryptedStorage));

            assert.strictEqual(value, 'sk-stored');
            assert.strictEqual(promptCount, 0);
        });

        test('prompts and returns the entered key when nothing is stored', async () => {
            whenPromptReturns('sk-prompted');

            const value = await getOrPromptOpenAiApiKey(instance(encryptedStorage));

            assert.strictEqual(value, 'sk-prompted');
            assert.strictEqual(promptCount, 1);
        });

        test('treats an empty stored value as missing and prompts', async () => {
            storageData.set(STORED_KEY, '');
            whenPromptReturns('sk-prompted');

            const value = await getOrPromptOpenAiApiKey(instance(encryptedStorage));

            assert.strictEqual(value, 'sk-prompted');
            assert.strictEqual(promptCount, 1);
        });

        test('throws when nothing is stored and the user cancels the prompt', async () => {
            try {
                await getOrPromptOpenAiApiKey(instance(encryptedStorage));
                assert.fail('Should have thrown');
            } catch (e) {
                assert.include((e as Error).message, 'OpenAI API key is not set');
            }
        });
    });
});
