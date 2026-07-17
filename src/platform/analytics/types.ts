import { IAsyncDisposable } from '../common/types';

export type TelemetryEventName =
    | 'add_block'
    | 'authenticate_integration'
    | 'configure_integration'
    | 'create_environment'
    | 'create_notebook'
    | 'create_project'
    | 'delete_environment'
    | 'delete_integration'
    | 'delete_notebook'
    | 'duplicate_notebook'
    | 'execute_cell'
    | 'execute_notebook'
    | 'export_notebook'
    | 'import_notebook'
    | 'open_in_deepnote'
    | 'open_notebook'
    | 'rename_notebook'
    | 'rename_project'
    | 'reset_integration'
    | 'save_integration'
    | 'select_environment'
    | 'split_notebook'
    | 'switch_sql_integration'
    | 'toggle_snapshots'
    | 'update_environment';

export interface TelemetryEvent {
    eventName: TelemetryEventName;
    properties?: Record<string, string | number | boolean>;
}

export const ITelemetryService = Symbol('ITelemetryService');

export interface ITelemetryService extends IAsyncDisposable {
    trackEvent(event: TelemetryEvent): void;
}
