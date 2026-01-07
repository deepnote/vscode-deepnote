import { inject, injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { IDisposable, IDisposableRegistry } from '../../../platform/common/types';

/**
 * This class previously checked for the external jupyter-renderers extension version.
 * Since the renderer is now integrated into the extension, version checking is no longer needed.
 */
@injectable()
export class RendererVersionChecker implements IExtensionSyncActivationService {
    private readonly disposables: IDisposable[] = [];

    constructor(@inject(IDisposableRegistry) disposables: IDisposableRegistry) {
        disposables.push(this);
    }

    dispose(): void {
        dispose(this.disposables);
    }

    activate(): void {
        // No-op: Renderer is now integrated into the extension, no version check needed
    }
}
