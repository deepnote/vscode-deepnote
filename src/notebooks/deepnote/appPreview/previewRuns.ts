import { LRUCache } from '../../../platform/common/utils/map';
import type { PreviewRun } from './types';

/**
 * Keeps unfinished runs, and each notebook's success that started last, which `appData()` answers from. Of the other
 * finished runs it keeps the {@link LRUCache.limit} that finished last, so a long run is still there for the page to
 * poll once it finishes.
 */
export class PreviewRuns extends LRUCache<string, PreviewRun> {
    protected override checkTrim(): void {
        const newestSuccess = new Map<string, PreviewRun>();
        for (const run of this.values()) {
            const newest = newestSuccess.get(run.notebookId);
            if (run.status === 'success' && (!newest || run.createdAt >= newest.createdAt)) {
                newestSuccess.set(run.notebookId, run);
            }
        }
        const removable = [...this.values()]
            .filter((run) => run.completedAt !== null && newestSuccess.get(run.notebookId) !== run)
            .sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''));
        removable.slice(0, Math.max(0, removable.length - this.limit)).forEach((run) => this.delete(run.runId));
    }
}
