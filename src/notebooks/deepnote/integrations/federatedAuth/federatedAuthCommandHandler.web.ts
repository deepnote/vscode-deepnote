import { inject, injectable } from 'inversify';
import { commands, window } from 'vscode';

import { IExtensionSyncActivationService } from '../../../../platform/activation/types';
import { Commands } from '../../../../platform/common/constants';
import { IExtensionContext } from '../../../../platform/common/types';
import { Integrations } from '../../../../platform/common/utils/localize';

/** Web-side stub for `deepnote.authenticateIntegration` that shows a "not supported in web" toast (the OAuth loopback flow needs Node's `http`/`express`). */
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
