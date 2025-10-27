import { injectable, inject } from 'inversify';
import {
    commands,
    window,
    NotebookCellData,
    NotebookCellKind,
    NotebookEdit,
    NotebookRange,
    NotebookCell,
    NotebookEditorRevealType
} from 'vscode';
import z from 'zod';

import { logger } from '../../platform/logging';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { Commands } from '../../platform/common/constants';
import { chainWithPendingUpdates } from '../../kernels/execution/notebookUpdater';
import {
    DeepnoteBigNumberMetadataSchema,
    DeepnoteTextInputMetadataSchema,
    DeepnoteTextareaInputMetadataSchema,
    DeepnoteSelectInputMetadataSchema,
    DeepnoteSliderInputMetadataSchema,
    DeepnoteCheckboxInputMetadataSchema,
    DeepnoteDateInputMetadataSchema,
    DeepnoteDateRangeInputMetadataSchema,
    DeepnoteFileInputMetadataSchema,
    DeepnoteButtonMetadataSchema,
    DeepnoteSqlMetadata
} from './deepnoteSchemas';

export type InputBlockType =
    | 'input-text'
    | 'input-textarea'
    | 'input-select'
    | 'input-slider'
    | 'input-checkbox'
    | 'input-date'
    | 'input-date-range'
    | 'input-file'
    | 'button';

export function getInputBlockMetadata(blockType: InputBlockType, variableName: string) {
    const defaultInput = {
        deepnote_variable_name: variableName
    };

    switch (blockType) {
        case 'input-text':
            return DeepnoteTextInputMetadataSchema.parse(defaultInput);
        case 'input-textarea':
            return DeepnoteTextareaInputMetadataSchema.parse(defaultInput);
        case 'input-select':
            return DeepnoteSelectInputMetadataSchema.parse(defaultInput);
        case 'input-slider':
            return DeepnoteSliderInputMetadataSchema.parse(defaultInput);
        case 'input-checkbox':
            return DeepnoteCheckboxInputMetadataSchema.parse(defaultInput);
        case 'input-date':
            return DeepnoteDateInputMetadataSchema.parse(defaultInput);
        case 'input-date-range':
            return DeepnoteDateRangeInputMetadataSchema.parse(defaultInput);
        case 'input-file':
            return DeepnoteFileInputMetadataSchema.parse(defaultInput);
        case 'button':
            return DeepnoteButtonMetadataSchema.parse(defaultInput);
        default: {
            const exhaustiveCheck: never = blockType;
            throw new Error(`Unhandled block type: ${exhaustiveCheck satisfies never}`);
        }
    }
}

export function safeParseDeepnoteVariableNameFromContentJson(content: string): string | undefined {
    try {
        const variableNameResult = z.string().safeParse(JSON.parse(content)['deepnote_variable_name']);
        return variableNameResult.success ? variableNameResult.data : undefined;
    } catch (error) {
        logger.error('Error parsing deepnote variable name from content JSON', error);
        return undefined;
    }
}

export function getNextDeepnoteVariableName(cells: NotebookCell[], prefix: 'df' | 'query' | 'input'): string {
    const deepnoteVariableNames = cells.reduce<string[]>((acc, cell) => {
        const contentValue = safeParseDeepnoteVariableNameFromContentJson(cell.document.getText());

        if (contentValue != null) {
            acc.push(contentValue);
        }

        const parsedMetadataValue = z.string().safeParse(cell.metadata['deepnote_variable_name']);
        if (parsedMetadataValue.success) {
            acc.push(parsedMetadataValue.data);
        }

        const parsedPocketMetadataValue = z.string().safeParse(cell.metadata.__deepnotePocket?.deepnote_variable_name);

        if (parsedPocketMetadataValue.success) {
            acc.push(parsedPocketMetadataValue.data);
        }

        return acc;
    }, []);

    const maxDeepnoteVariableNamesSuffixNumber =
        deepnoteVariableNames.reduce<number | null>((acc, name) => {
            if (!name.startsWith(prefix)) {
                return acc;
            }

            const m = name.match(/_(\d+)$/);
            if (m == null) {
                return acc;
            }

            const suffixNumber = parseInt(m[1]);

            if (isNaN(suffixNumber)) {
                return acc;
            }

            return acc == null || suffixNumber > acc ? suffixNumber : acc;
        }, null) ?? 0;

    return `${prefix}_${maxDeepnoteVariableNamesSuffixNumber + 1}`;
}

/**
 * Service responsible for registering and handling Deepnote-specific notebook commands.
 */
@injectable()
export class DeepnoteNotebookCommandListener implements IExtensionSyncActivationService {
    constructor(@inject(IDisposableRegistry) private readonly disposableRegistry: IDisposableRegistry) {}

    /**
     * Activates the service by registering Deepnote-specific commands.
     */
    public activate(): void {
        this.registerCommands();
    }

    private registerCommands(): void {
        this.disposableRegistry.push(commands.registerCommand(Commands.AddSqlBlock, () => this.addSqlBlock()));
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddBigNumberChartBlock, () => this.addBigNumberChartBlock())
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddInputTextBlock, () => this.addInputBlock('input-text'))
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddInputTextareaBlock, () => this.addInputBlock('input-textarea'))
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddInputSelectBlock, () => this.addInputBlock('input-select'))
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddInputSliderBlock, () => this.addInputBlock('input-slider'))
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddInputCheckboxBlock, () => this.addInputBlock('input-checkbox'))
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddInputDateBlock, () => this.addInputBlock('input-date'))
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddInputDateRangeBlock, () => this.addInputBlock('input-date-range'))
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddInputFileBlock, () => this.addInputBlock('input-file'))
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddButtonBlock, () => this.addInputBlock('button'))
        );
    }

    public async addSqlBlock(): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (!editor) {
            throw new Error('No active notebook editor found');
        }
        const document = editor.notebook;
        const selection = editor.selection;
        const cells = editor.notebook.getCells();
        const deepnoteVariableName = getNextDeepnoteVariableName(cells, 'df');

        const defaultMetadata: DeepnoteSqlMetadata = {
            deepnote_variable_name: deepnoteVariableName,
            deepnote_return_variable_type: 'dataframe',
            sql_integration_id: 'deepnote-dataframe-sql'
        };

        // Determine the index where to insert the new cell (below current selection or at the end)
        const insertIndex = selection ? selection.end : document.cellCount;

        const result = await chainWithPendingUpdates(document, (edit) => {
            // Create a SQL cell with SQL language for syntax highlighting
            // This matches the SqlBlockConverter representation
            const newCell = new NotebookCellData(NotebookCellKind.Code, '', 'sql');
            newCell.metadata = {
                __deepnotePocket: {
                    type: 'sql',
                    ...defaultMetadata
                },
                ...defaultMetadata
            };
            const nbEdit = NotebookEdit.insertCells(insertIndex, [newCell]);
            edit.set(document.uri, [nbEdit]);
        });
        if (result !== true) {
            throw new Error('Failed to insert SQL block');
        }

        const notebookRange = new NotebookRange(insertIndex, insertIndex + 1);
        editor.revealRange(notebookRange, NotebookEditorRevealType.Default);
        editor.selection = notebookRange;
        // Enter edit mode on the new cell
        await commands.executeCommand('notebook.cell.edit');
    }

    public async addBigNumberChartBlock(): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (!editor) {
            throw new Error('No active notebook editor found');
        }
        const document = editor.notebook;
        const selection = editor.selection;

        // Determine the index where to insert the new cell (below current selection or at the end)
        const insertIndex = selection ? selection.end : document.cellCount;

        // Initialize empty metadata from the zod schema
        const bigNumberMetadata = DeepnoteBigNumberMetadataSchema.parse({});

        const metadata = {
            __deepnotePocket: {
                type: 'big-number'
            }
        };

        const result = await chainWithPendingUpdates(document, (edit) => {
            const newCell = new NotebookCellData(
                NotebookCellKind.Code,
                JSON.stringify(bigNumberMetadata, null, 2),
                'json'
            );
            newCell.metadata = metadata;
            const nbEdit = NotebookEdit.insertCells(insertIndex, [newCell]);
            edit.set(document.uri, [nbEdit]);
        });
        if (result !== true) {
            throw new Error('Failed to insert big number chart block');
        }

        const notebookRange = new NotebookRange(insertIndex, insertIndex + 1);
        editor.revealRange(notebookRange, NotebookEditorRevealType.Default);
        editor.selection = notebookRange;
        // Enter edit mode on the new cell
        await commands.executeCommand('notebook.cell.edit');
    }

    public async addInputBlock(blockType: InputBlockType): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (!editor) {
            throw new Error('No active notebook editor found');
        }
        const document = editor.notebook;
        const selection = editor.selection;
        const cells = editor.notebook.getCells();
        const deepnoteVariableName = getNextDeepnoteVariableName(cells, 'input');

        // Determine the index where to insert the new cell (below current selection or at the end)
        const insertIndex = selection ? selection.end : document.cellCount;

        // Get the appropriate schema and parse default metadata based on block type
        const defaultMetadata = getInputBlockMetadata(blockType, deepnoteVariableName);

        const metadata = {
            __deepnotePocket: {
                type: blockType,
                ...defaultMetadata
            }
        };

        const result = await chainWithPendingUpdates(document, (edit) => {
            const newCell = new NotebookCellData(
                NotebookCellKind.Code,
                JSON.stringify(defaultMetadata, null, 2),
                'json'
            );
            newCell.metadata = metadata;
            const nbEdit = NotebookEdit.insertCells(insertIndex, [newCell]);
            edit.set(document.uri, [nbEdit]);
        });
        if (result !== true) {
            throw new Error('Failed to insert input block');
        }

        const notebookRange = new NotebookRange(insertIndex, insertIndex + 1);
        editor.revealRange(notebookRange, NotebookEditorRevealType.Default);
        editor.selection = notebookRange;
        // Enter edit mode on the new cell
        await commands.executeCommand('notebook.cell.edit');
    }
}
