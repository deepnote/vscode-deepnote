import { ExtensionMode, l10n, window } from 'vscode';

import { ServiceContainer } from '../../platform/ioc/container';
import { IExtensionContext } from '../../platform/common/types';

export interface SecretPromptOptions {
    prompt: string;
    placeHolder?: string;
    password?: boolean;
}

function getContext(): IExtensionContext | null {
    const context = ServiceContainer.instance.get<IExtensionContext>(IExtensionContext);

    if (context.extensionMode === ExtensionMode.Test) {
        return null;
    }

    return context;
}

export async function getSecret(key: string): Promise<string | undefined> {
    const context = getContext();

    if (!context) {
        return undefined;
    }

    const value = await context.secrets.get(key);

    return value && value.length > 0 ? value : undefined;
}

export async function setSecret(key: string, value: string): Promise<void> {
    const context = getContext();

    if (!context) {
        return;
    }

    await context.secrets.store(key, value);
}

export async function clearSecret(key: string): Promise<void> {
    const context = getContext();

    if (!context) {
        return;
    }

    await context.secrets.delete(key);
}

export async function promptForSecret(key: string, options: SecretPromptOptions): Promise<string | undefined> {
    const input = await window.showInputBox({
        prompt: options.prompt,
        placeHolder: options.placeHolder,
        password: options.password ?? true,
        ignoreFocusOut: true
    });

    if (!input || input.trim().length === 0) {
        return undefined;
    }

    const trimmed = input.trim();
    await setSecret(key, trimmed);

    return trimmed;
}

export async function getOrPromptSecret(
    key: string,
    options: SecretPromptOptions,
    errorMessage: string
): Promise<string> {
    let value = await getSecret(key);

    if (!value) {
        value = await promptForSecret(key, options);
    }

    if (!value) {
        throw new Error(errorMessage);
    }

    return value;
}

// OpenAI API key - specific wrappers

const OPENAI_API_KEY = 'openAiApiKey';

const OPENAI_PROMPT_OPTIONS: SecretPromptOptions = {
    prompt: l10n.t('Enter your OpenAI API key'),
    placeHolder: l10n.t('sk-...'),
    password: true
};

export async function getOpenAiApiKey(): Promise<string | undefined> {
    return getSecret(OPENAI_API_KEY);
}

export async function setOpenAiApiKey(key: string): Promise<void> {
    return setSecret(OPENAI_API_KEY, key);
}

export async function clearOpenAiApiKey(): Promise<void> {
    return clearSecret(OPENAI_API_KEY);
}

export async function promptForOpenAiApiKey(): Promise<string | undefined> {
    return promptForSecret(OPENAI_API_KEY, OPENAI_PROMPT_OPTIONS);
}

export async function getOrPromptOpenAiApiKey(): Promise<string> {
    return getOrPromptSecret(
        OPENAI_API_KEY,
        OPENAI_PROMPT_OPTIONS,
        l10n.t('OpenAI API key is not set. Use the command "Deepnote: Set OpenAI API Key" to configure it.')
    );
}
