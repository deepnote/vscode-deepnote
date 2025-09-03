// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export interface CustomNotebookCell {
    cell_type: 'code' | 'markdown' | 'raw' | 'button';
    metadata: {
        cell_id?: string;
        // Button cell specific metadata
        text?: string;
        variant?: 'primary' | 'secondary' | 'success' | 'danger';
        action?: {
            type: 'set_variable' | 'execute' | 'command';
            variable?: string;
            value?: any;
            code?: string;
            command?: string;
        };
        // Deepnote compatibility
        deepnote_cell_type?: 'button';
        deepnote_button_title?: string;
        deepnote_button_behavior?: 'set_variable';
        deepnote_button_color_scheme?: 'blue' | 'green' | 'red' | 'gray' | 'grey';
        deepnote_variable_name?: string;
        [key: string]: any;
    };
    source: string | string[];
    outputs?: any[];
    execution_count?: number | null;
}

export interface CustomNotebookData {
    cells: CustomNotebookCell[];
    metadata: {
        kernelspec?: {
            display_name: string;
            language: string;
            name: string;
        };
        language_info?: {
            name: string;
            version?: string;
            [key: string]: any;
        };
        [key: string]: any;
    };
    nbformat: number;
    nbformat_minor: number;
}

export enum CustomNotebookMessages {
    LoadNotebook = 'loadNotebook',
    UpdateCell = 'updateCell',
    AddCell = 'addCell',
    DeleteCell = 'deleteCell',
    MoveCell = 'moveCell',
    ExecuteCell = 'executeCell',
    Save = 'save',
    CellUpdated = 'cellUpdated',
    NotebookUpdated = 'notebookUpdated'
}

export interface CustomNotebookMapping {
    [CustomNotebookMessages.LoadNotebook]: CustomNotebookData;
    [CustomNotebookMessages.UpdateCell]: {
        cellId: string;
        cell: Partial<CustomNotebookCell>;
    };
    [CustomNotebookMessages.AddCell]: {
        cell: CustomNotebookCell;
        index?: number;
    };
    [CustomNotebookMessages.DeleteCell]: {
        cellId: string;
    };
    [CustomNotebookMessages.MoveCell]: {
        cellId: string;
        newIndex: number;
    };
    [CustomNotebookMessages.ExecuteCell]: {
        cellId: string;
        code: string;
    };
    [CustomNotebookMessages.Save]: CustomNotebookData;
    [CustomNotebookMessages.CellUpdated]: {
        cellId: string;
        cell: CustomNotebookCell;
    };
    [CustomNotebookMessages.NotebookUpdated]: CustomNotebookData;
}