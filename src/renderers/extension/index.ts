import { Event, EventEmitter, notebooks, NotebookEditor } from 'vscode';
import { OpenImageInPlotViewer, SaveImageAs, IsDeepnoteExtensionInstalled } from './constants';

let rendererMessaging: ReturnType<typeof createRendererMessagingInternal> | undefined;

function createRendererMessagingInternal() {
    const onDidReceiveMessage = new EventEmitter<{
        editor: NotebookEditor;
        message: OpenImageInPlotViewer | SaveImageAs;
    }>();

    const messaging = notebooks.createRendererMessaging('deepnote-notebook-renderer');

    messaging.onDidReceiveMessage(({ editor, message }) => {
        const msg = message as OpenImageInPlotViewer | SaveImageAs | IsDeepnoteExtensionInstalled;
        if (!msg.type) {
            return;
        }
        if (msg.type === 'isDeepnoteExtensionInstalled') {
            messaging
                .postMessage(
                    {
                        type: 'isDeepnoteExtensionInstalled',
                        response: true
                    } as IsDeepnoteExtensionInstalled,
                    editor
                )
                .then(
                    () => {
                        /* noop */
                    },
                    (ex) => console.error('Failed to send', ex)
                );
            return;
        }
        onDidReceiveMessage.fire({ editor, message: msg });
    });

    void messaging.postMessage({
        type: 'isDeepnoteExtensionInstalled',
        response: true
    } as IsDeepnoteExtensionInstalled);

    return {
        onDidReceiveMessage: onDidReceiveMessage.event
    };
}

export function createRendererMessaging(): {
    onDidReceiveMessage: Event<{ editor: NotebookEditor; message: OpenImageInPlotViewer | SaveImageAs }>;
} {
    if (!rendererMessaging) {
        rendererMessaging = createRendererMessagingInternal();
    }

    return rendererMessaging;
}

export { OpenImageInPlotViewer, SaveImageAs } from './constants';
