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

/** Result of a tracked command, so telemetry can separate user drop-off from real failures. */
export type CommandOutcome = 'completed' | 'cancelled' | 'failed';

/**
 * Caller-supplied property shape per event. `undefined` means the event carries no caller
 * properties (the service still attaches common properties such as version/platform/channel).
 */
export interface TelemetryEventProperties {
    add_block: { blockType: string };
    authenticate_integration: { integrationType: string };
    configure_integration: { integrationType: string };
    create_environment: { hasDescription: boolean; packageCount: number };
    create_notebook: { outcome: CommandOutcome; source: 'toolbar' | 'project_menu' };
    create_project: { outcome: CommandOutcome };
    delete_environment: undefined;
    delete_integration: { integrationType: string };
    delete_notebook: { outcome: CommandOutcome };
    duplicate_notebook: { outcome: CommandOutcome };
    execute_cell: { cellType: 'sql' | 'markdown' | 'code'; integrationType?: string };
    execute_notebook: undefined;
    export_notebook: { outcome: CommandOutcome; format?: string };
    import_notebook: { outcome: CommandOutcome; source: 'deepnote' | 'jupyter' };
    open_in_deepnote: { completed: boolean };
    open_notebook: { outcome: CommandOutcome };
    rename_notebook: { outcome: CommandOutcome };
    rename_project: { outcome: CommandOutcome };
    reset_integration: { integrationType: string };
    save_integration: { integrationType: string };
    select_environment: undefined;
    split_notebook: { notebookCount: number };
    switch_sql_integration: { integrationType: string };
    toggle_snapshots: { enabled: boolean };
    update_environment: { field: 'name' | 'packages'; packageCount?: number };
}

/**
 * An event name paired with its event-specific properties. Events whose property type is
 * `undefined` may omit `properties`. Distributes over `E` so a union of event names yields the
 * corresponding union of `{ eventName, properties }` shapes.
 */
export type TelemetryEvent<E extends TelemetryEventName = TelemetryEventName> = E extends TelemetryEventName
    ? TelemetryEventProperties[E] extends undefined
        ? { eventName: E; properties?: never }
        : { eventName: E; properties: TelemetryEventProperties[E] }
    : never;

export const ITelemetryService = Symbol('ITelemetryService');

export interface ITelemetryService extends IAsyncDisposable {
    trackEvent<E extends TelemetryEventName>(event: TelemetryEvent<E>): void;
}
