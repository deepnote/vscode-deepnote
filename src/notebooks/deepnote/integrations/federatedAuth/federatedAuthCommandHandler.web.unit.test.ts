import { assert } from 'chai';
import { anyString, anything, instance, mock, verify, when } from 'ts-mockito';

import { IDisposable, IExtensionContext } from '../../../../platform/common/types';
import { Commands } from '../../../../platform/common/constants';
import { FederatedAuthCommandHandlerWeb } from './federatedAuthCommandHandler.web';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../../test/vscode-mock';

suite('FederatedAuthCommandHandlerWeb', () => {
    let extensionContext: IExtensionContext;
    let subscriptions: IDisposable[];
    let registeredCallback: ((...args: unknown[]) => unknown) | undefined;
    let handler: FederatedAuthCommandHandlerWeb;

    setup(() => {
        resetVSCodeMocks();
        subscriptions = [];
        registeredCallback = undefined;

        extensionContext = mock<IExtensionContext>();
        when(extensionContext.subscriptions).thenReturn(subscriptions);

        when(mockedVSCodeNamespaces.commands.registerCommand(anyString(), anything())).thenCall(
            (_command: string, callback: (...args: unknown[]) => unknown) => {
                registeredCallback = callback;
                return { dispose: () => undefined } as IDisposable;
            }
        );

        handler = new FederatedAuthCommandHandlerWeb(instance(extensionContext));
    });

    test('activate registers the AuthenticateIntegration command with the extension context', () => {
        handler.activate();

        verify(mockedVSCodeNamespaces.commands.registerCommand(Commands.AuthenticateIntegration, anything())).once();
        assert.strictEqual(subscriptions.length, 1);
    });

    test('the registered command surfaces the not-supported-in-web information toast', () => {
        handler.activate();
        assert.isDefined(registeredCallback, 'command callback should have been captured');

        // Invoke the command — should not throw and should show the toast.
        registeredCallback!('some-integration-id');

        verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
    });
});
