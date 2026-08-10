import { injectable } from 'inversify';
import { IServerHandleRegistry } from './types';

/**
 * Tracks the Deepnote server handle registered for each notebook.
 * One server handle per notebook, keyed by getNotebookKey().
 */
@injectable()
export class ServerHandleRegistry implements IServerHandleRegistry {
    private readonly handles = new Map<string, string>();

    public get(notebookKey: string): string | undefined {
        return this.handles.get(notebookKey);
    }

    public set(notebookKey: string, handle: string): void {
        this.handles.set(notebookKey, handle);
    }
}
