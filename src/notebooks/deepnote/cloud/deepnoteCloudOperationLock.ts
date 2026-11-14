import { injectable } from 'inversify';

import { IDeepnoteCloudOperationLock } from './types';

@injectable()
export class DeepnoteCloudOperationLock implements IDeepnoteCloudOperationLock {
    private held = false;

    public async tryRunExclusive<T>(run: () => Promise<T>, onBusy?: () => void): Promise<T | undefined> {
        if (this.held) {
            onBusy?.();

            return undefined;
        }

        this.held = true;
        try {
            return await run();
        } finally {
            this.held = false;
        }
    }
}
