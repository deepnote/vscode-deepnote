import { injectable } from 'inversify';
import { Disposable } from 'vscode';

import { IDeepnoteCloudOperationLock } from './types';

@injectable()
export class DeepnoteCloudOperationLock implements IDeepnoteCloudOperationLock {
    private held = false;

    public tryAcquire(): Disposable | undefined {
        if (this.held) {
            return undefined;
        }

        this.held = true;

        return new Disposable(() => {
            this.held = false;
        });
    }
}
