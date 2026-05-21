import { inject, injectable } from 'inversify';
import { commands, window } from 'vscode';

import { IExtensionSyncActivationService } from '../../../../platform/activation/types';
import { Commands } from '../../../../platform/common/constants';
import { IExtensionContext } from '../../../../platform/common/types';
import { Integrations } from '../../../../platform/common/utils/localize';

/**
 * Web-side command handler for `deepnote.authenticateIntegration`.
 *
 * The OAuth loopback flow (Step 5 of the M2 plan) depends on Node's `http`,
 * `express`, and `passport`, none of which run in the web extension host.
 * Rather than bind nothing on web — which would make the command id throw
 * `command 'deepnote.authenticateIntegration' not found` — we register a
 * stub that shows a localized "not supported in web" toast.
 */
@injectable()
export class FederatedAuthCommandHandlerWeb implements IExtensionSyncActivationService {
    constructor(@inject(IExtensionContext) private readonly extensionContext: IExtensionContext) {}

    public activate(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.AuthenticateIntegration, () => {
                void window.showInformationMessage(Integrations.federatedAuthNotSupportedInWeb);
            })
        );
    }
}
