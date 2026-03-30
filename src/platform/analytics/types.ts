import { IAsyncDisposable } from '../common/types';

export type TelemetryEventName =
    | 'add_block'
    | 'configure_integration'
    | 'create_environment'
    | 'create_notebook'
    | 'create_project'
    | 'delete_environment'
    | 'delete_integration'
    | 'delete_notebook'
    | 'delete_project'
    | 'duplicate_notebook'
    | 'execute_cell'
    | 'execute_notebook'
    | 'export_notebook'
    | 'import_notebook'
    | 'open_in_deepnote'
    | 'open_notebook'
    | 'reset_integration'
    | 'save_integration'
    | 'select_environment'
    | 'toggle_snapshots';

export interface TelemetryEvent {
    eventName: TelemetryEventName;
    properties?: Record<string, string | number | boolean>;
}

export const ITelemetryService = Symbol('ITelemetryService');

export interface ITelemetryService extends IAsyncDisposable {
    trackEvent(event: TelemetryEvent): void;
}
