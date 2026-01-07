import { inject, injectable } from 'inversify';
import { NotebookEditor, window } from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { IDisposable } from '../../../platform/common/types';
import { noop } from '../../../platform/common/utils/misc';
import { PlotViewHandler } from './plotViewHandler';
import { IPlotSaveHandler } from './types';
import { logger } from '../../../platform/logging';
import { DataScience } from '../../../platform/common/utils/localize';
import { createRendererMessaging, OpenImageInPlotViewer, SaveImageAs } from '../../../renderers/extension';

export { OpenImageInPlotViewer, SaveImageAs };

@injectable()
export class RendererCommunication implements IExtensionSyncActivationService, IDisposable {
    private readonly disposables: IDisposable[] = [];

    constructor(
        @inject(IPlotSaveHandler) private readonly plotSaveHandler: IPlotSaveHandler,
        @inject(PlotViewHandler) private readonly plotViewHandler: PlotViewHandler
    ) {}

    public dispose() {
        dispose(this.disposables);
    }

    public activate() {
        const { onDidReceiveMessage } = createRendererMessaging();

        onDidReceiveMessage(
            async ({ editor, message }: { editor: NotebookEditor; message: OpenImageInPlotViewer | SaveImageAs }) => {
                const document = editor.notebook || window.activeNotebookEditor?.notebook;
                if (!document) {
                    return;
                }
                try {
                    if (message.type === 'saveImageAs') {
                        await this.plotSaveHandler.savePlot(document, message.outputId, message.mimeType);
                    } else if (message.type === 'openImageInPlotViewer') {
                        await this.plotViewHandler.openPlot(document, message.outputId);
                    }
                } catch (ex) {
                    logger.error(ex);
                    window.showErrorMessage(DataScience.exportImageFailed(ex.message)).then(noop, noop);
                }
            },
            this,
            this.disposables
        );
    }
}
