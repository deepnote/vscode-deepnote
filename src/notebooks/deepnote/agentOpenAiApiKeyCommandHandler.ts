import { inject, injectable } from 'inversify';
import { commands, l10n, window } from 'vscode';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IExtensionContext } from '../../platform/common/types';
import { clearOpenAiApiKey, promptForOpenAiApiKey } from './deepnoteSecretStore';

@injectable()
export class AgentOpenAiApiKeyCommandHandler implements IExtensionSyncActivationService {
    constructor(@inject(IExtensionContext) private readonly extensionContext: IExtensionContext) {}

    public activate(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.setOpenAiApiKey', () => this.setApiKey()),
            commands.registerCommand('deepnote.clearOpenAiApiKey', () => this.clearApiKey())
        );
    }

    private async setApiKey(): Promise<void> {
        const key = await promptForOpenAiApiKey();
        if (key) {
            void window.showInformationMessage(l10n.t('OpenAI API key has been saved.'));
        }
    }

    private async clearApiKey(): Promise<void> {
        await clearOpenAiApiKey();
        void window.showInformationMessage(l10n.t('OpenAI API key has been cleared.'));
    }
}
