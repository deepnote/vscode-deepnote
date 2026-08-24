import { l10n, window } from 'vscode';

import { IEncryptedStorage } from '../../platform/common/application/types';

const AGENT_SERVICE_NAME = 'deepnote-agent';
const OPENAI_API_KEY = 'openAiApiKey';

async function retrieveOpenAiApiKey(storage: IEncryptedStorage): Promise<string | undefined> {
    const value = await storage.retrieve(AGENT_SERVICE_NAME, OPENAI_API_KEY);

    return value && value.length > 0 ? value : undefined;
}

export async function clearOpenAiApiKey(storage: IEncryptedStorage): Promise<void> {
    await storage.store(AGENT_SERVICE_NAME, OPENAI_API_KEY, undefined);
}

export async function getOrPromptOpenAiApiKey(storage: IEncryptedStorage): Promise<string> {
    const value = (await retrieveOpenAiApiKey(storage)) ?? (await promptForOpenAiApiKey(storage));

    if (!value) {
        throw new Error(
            l10n.t('OpenAI API key is not set. Use the command "Deepnote: Set OpenAI API Key" to configure it.')
        );
    }

    return value;
}

export async function promptForOpenAiApiKey(storage: IEncryptedStorage): Promise<string | undefined> {
    const input = await window.showInputBox({
        prompt: l10n.t('Enter your OpenAI API key'),
        placeHolder: l10n.t('sk-...'),
        password: true,
        ignoreFocusOut: true
    });

    const trimmed = input?.trim();

    if (!trimmed) {
        return undefined;
    }

    await storage.store(AGENT_SERVICE_NAME, OPENAI_API_KEY, trimmed);

    return trimmed;
}
