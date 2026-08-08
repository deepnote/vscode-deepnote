import { injectable, inject } from 'inversify';
import {
    commands,
    ConfigurationTarget,
    window,
    NotebookCellData,
    NotebookCellKind,
    NotebookEdit,
    NotebookRange,
    NotebookCell,
    NotebookEditorRevealType,
    l10n,
    QuickPickItem,
    NotebookEditor
} from 'vscode';
import z from 'zod';

import { logger } from '../../platform/logging';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IConfigurationService, IDisposableRegistry } from '../../platform/common/types';
import { Commands } from '../../platform/common/constants';
import { notebookUpdaterUtils } from '../../kernels/execution/notebookUpdater';
import { WrappedError } from '../../platform/errors/types';
import { formatInputBlockCellContent, getInputBlockLanguage } from './inputBlockContentFormatter';
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
import { DATAFRAME_SQL_INTEGRATION_ID } from '../../platform/notebooks/deepnote/integrationTypes';
import { Pocket } from '../../platform/deepnote/pocket';
import { AGENT_MODEL_AUTO, AGENT_MODEL_METADATA_KEY } from './agentCellStatusBarProvider';
import { generateBlockId, isAgentCell } from './dataConversionUtils';

export const INPUT_BLOCK_TYPES = [
    'input-text',
    'input-textarea',
    'input-select',
    'input-slider',
    'input-checkbox',
    'input-date',
    'input-date-range',
    'input-file',
    'button'
] as const;

export type InputBlockType = (typeof INPUT_BLOCK_TYPES)[number];

export const TEXT_BLOCK_TYPES = ['text-cell-p', 'text-cell-h1', 'text-cell-h2', 'text-cell-h3'] as const;

export type TextBlockType = (typeof TEXT_BLOCK_TYPES)[number];

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
        const parsed = JSON.parse(content);
        // Chart blocks use 'variable' key, other blocks use 'deepnote_variable_name'
        const variableName = parsed['variable'] ?? parsed['deepnote_variable_name'];
        const variableNameResult = z.string().safeParse(variableName);
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
            if (!name.startsWith(`${prefix}_`)) {
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
    constructor(
        @inject(IConfigurationService) private readonly configurationService: IConfigurationService,
        @inject(IDisposableRegistry) private readonly disposableRegistry: IDisposableRegistry
    ) {}

    /**
     * Activates the service by registering Deepnote-specific commands.
     */
    public activate(): void {
        this.registerCommands();
    }

    private registerCommands(): void {
        this.disposableRegistry.push(commands.registerCommand(Commands.AddAgentBlock, () => this.addAgentBlock()));
        this.disposableRegistry.push(commands.registerCommand(Commands.AddSqlBlock, () => this.addSqlBlock()));
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddBigNumberChartBlock, () => this.addBigNumberChartBlock())
        );
        this.disposableRegistry.push(commands.registerCommand(Commands.AddChartBlock, () => this.addChartBlock()));
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
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddInputBlock, () => this.addInputBlockThroughPicker())
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddTextBlock, () => this.addTextBlockThroughPicker())
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddTextBlockHeading1, () =>
                this.addTextBlockCommandHandler({ textBlockType: 'text-cell-h1' })
            )
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddTextBlockHeading2, () =>
                this.addTextBlockCommandHandler({ textBlockType: 'text-cell-h2' })
            )
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddTextBlockHeading3, () =>
                this.addTextBlockCommandHandler({ textBlockType: 'text-cell-h3' })
            )
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddTextBlockParagraph, () =>
                this.addTextBlockCommandHandler({ textBlockType: 'text-cell-p' })
            )
        );
        this.disposableRegistry.push(commands.registerCommand(Commands.EnableSnapshots, () => this.enableSnapshots()));
        this.disposableRegistry.push(
            commands.registerCommand(Commands.DisableSnapshots, () => this.disableSnapshots())
        );
    }

    /**
     * Inserts an empty agent block below the selection. A notebook may hold at most one; a second
     * request reports that and leaves the notebook untouched.
     *
     * Unlike the other block commands this mints the block id up front: an agent block without one
     * gets a fresh random id on every `convertCellToBlock`, so each run would stamp its generated
     * cells with a different owner and the stale-run cleanup would never match them.
     */
    public async addAgentBlock(): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (!editor) {
            throw new Error(l10n.t('No active notebook editor found'));
        }
        const document = editor.notebook;
        const selection = editor.selection;

        if (document.getCells().some(isAgentCell)) {
            void window.showInformationMessage(l10n.t('This notebook already contains an agent block.'));

            return;
        }

        const insertIndex = selection ? selection.end : document.cellCount;
        const blockId = generateBlockId();

        const result = await notebookUpdaterUtils.chainWithPendingUpdates(document, (edit) => {
            const newCell = new NotebookCellData(NotebookCellKind.Code, '', 'plaintext');
            newCell.metadata = {
                __deepnotePocket: {
                    type: 'agent'
                },
                id: blockId,
                __deepnoteBlockId: blockId,
                [AGENT_MODEL_METADATA_KEY]: AGENT_MODEL_AUTO
            };
            const nbEdit = NotebookEdit.insertCells(insertIndex, [newCell]);
            edit.set(document.uri, [nbEdit]);
        });
        if (result !== true) {
            throw new Error(l10n.t('Failed to insert agent block'));
        }

        const notebookRange = new NotebookRange(insertIndex, insertIndex + 1);
        editor.revealRange(notebookRange, NotebookEditorRevealType.Default);
        editor.selection = notebookRange;
        await commands.executeCommand('notebook.cell.edit');
    }

    public async addSqlBlock(): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (!editor) {
            throw new Error(l10n.t('No active notebook editor found'));
        }
        const document = editor.notebook;
        const selection = editor.selection;
        const cells = editor.notebook.getCells();
        const deepnoteVariableName = getNextDeepnoteVariableName(cells, 'df');

        const defaultMetadata: DeepnoteSqlMetadata = {
            deepnote_variable_name: deepnoteVariableName,
            deepnote_return_variable_type: 'dataframe',
            sql_integration_id: DATAFRAME_SQL_INTEGRATION_ID
        };

        // Determine the index where to insert the new cell (below current selection or at the end)
        const insertIndex = selection ? selection.end : document.cellCount;

        const result = await notebookUpdaterUtils.chainWithPendingUpdates(document, (edit) => {
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
            throw new Error(l10n.t('Failed to insert SQL block'));
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
            throw new Error(l10n.t('No active notebook editor found'));
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

        const result = await notebookUpdaterUtils.chainWithPendingUpdates(document, (edit) => {
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
            throw new Error(l10n.t('Failed to insert big number chart block'));
        }

        const notebookRange = new NotebookRange(insertIndex, insertIndex + 1);
        editor.revealRange(notebookRange, NotebookEditorRevealType.Default);
        editor.selection = notebookRange;
        // Enter edit mode on the new cell
        await commands.executeCommand('notebook.cell.edit');
    }

    public async addChartBlock(): Promise<void> {
        const editor = window.activeNotebookEditor;

        if (!editor) {
            throw new WrappedError(l10n.t('No active notebook editor found'));
        }

        const document = editor.notebook;
        const selection = editor.selection;
        const insertIndex = selection ? selection.end : document.cellCount;

        const defaultVisualizationSpec = {
            mark: 'line',
            $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
            data: { values: [] },
            encoding: {
                x: { field: 'x', type: 'quantitative' },
                y: { field: 'y', type: 'quantitative' }
            }
        };

        const cellContent = {
            variable: 'df_1',
            spec: defaultVisualizationSpec,
            filters: []
        };

        const metadata = {
            __deepnotePocket: {
                type: 'visualization'
            }
        };

        const result = await notebookUpdaterUtils.chainWithPendingUpdates(document, (edit) => {
            const newCell = new NotebookCellData(NotebookCellKind.Code, JSON.stringify(cellContent, null, 2), 'json');

            newCell.metadata = metadata;

            const nbEdit = NotebookEdit.insertCells(insertIndex, [newCell]);

            edit.set(document.uri, [nbEdit]);
        });

        if (result !== true) {
            throw new WrappedError(l10n.t('Failed to insert chart block'));
        }

        const notebookRange = new NotebookRange(insertIndex, insertIndex + 1);

        editor.revealRange(notebookRange, NotebookEditorRevealType.Default);
        editor.selection = notebookRange;

        await commands.executeCommand('notebook.cell.edit');
    }

    public async addInputBlock(blockType: InputBlockType): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (!editor) {
            throw new Error(l10n.t('No active notebook editor found'));
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
            },
            ...defaultMetadata
        };

        const result = await notebookUpdaterUtils.chainWithPendingUpdates(document, (edit) => {
            // Use the formatter to get the correct cell content based on block type and metadata
            const cellContent = formatInputBlockCellContent(blockType, defaultMetadata);
            // Get the correct language mode for this input block type
            const languageMode = getInputBlockLanguage(blockType) ?? 'python';

            const newCell = new NotebookCellData(NotebookCellKind.Code, cellContent, languageMode);
            newCell.metadata = metadata;
            const nbEdit = NotebookEdit.insertCells(insertIndex, [newCell]);
            edit.set(document.uri, [nbEdit]);
        });
        if (result !== true) {
            throw new Error(l10n.t('Failed to insert input block'));
        }

        const notebookRange = new NotebookRange(insertIndex, insertIndex + 1);
        editor.revealRange(notebookRange, NotebookEditorRevealType.Default);
        editor.selection = notebookRange;
        // Enter edit mode on the new cell
        await commands.executeCommand('notebook.cell.edit');
    }

    public async addTextBlockThroughPicker(): Promise<void> {
        const TEXT_BLOCK_TYPE_LABELS = {
            'text-cell-p': l10n.t('Paragraph'),
            'text-cell-h1': l10n.t('Heading 1'),
            'text-cell-h2': l10n.t('Heading 2'),
            'text-cell-h3': l10n.t('Heading 3')
        } as const satisfies Record<TextBlockType, string>;

        const editor = window.activeNotebookEditor;
        if (!editor) {
            throw new Error(l10n.t('No active notebook editor found'));
        }

        const items: (QuickPickItem & { textBlockType: TextBlockType })[] = TEXT_BLOCK_TYPES.map((textBlockType) => {
            const label = TEXT_BLOCK_TYPE_LABELS[textBlockType];
            const description = l10n.t('Add a {0} text block', label);
            return {
                label,
                description,
                textBlockType
            };
        });

        const selected = await window.showQuickPick(items, {
            placeHolder: l10n.t('Select a text block type'),
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (selected == null) {
            return;
        }

        logger.info(`Selected text block type: ${selected.textBlockType}`);

        await this.addTextBlock({ editor, textBlockType: selected.textBlockType });
    }

    public async addInputBlockThroughPicker(): Promise<void> {
        const INPUT_BLOCK_TYPE_LABELS = {
            'input-text': l10n.t('Text Input'),
            'input-textarea': l10n.t('Textarea'),
            'input-select': l10n.t('Select Dropdown'),
            'input-slider': l10n.t('Slider'),
            'input-checkbox': l10n.t('Checkbox'),
            'input-date': l10n.t('Date'),
            'input-date-range': l10n.t('Date Range'),
            'input-file': l10n.t('File Upload'),
            button: l10n.t('Button')
        } as const satisfies Record<InputBlockType, string>;

        const editor = window.activeNotebookEditor;
        if (!editor) {
            throw new Error(l10n.t('No active notebook editor found'));
        }

        const items: (QuickPickItem & { inputBlockType: InputBlockType })[] = INPUT_BLOCK_TYPES.map(
            (inputBlockType) => {
                const label = INPUT_BLOCK_TYPE_LABELS[inputBlockType];
                const description = l10n.t('Add a {0} block', label);
                return {
                    label,
                    description,
                    inputBlockType
                };
            }
        );

        const selected = await window.showQuickPick(items, {
            placeHolder: l10n.t('Select an input block type'),
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (selected == null) {
            return;
        }

        logger.info(`Selected input block type: ${selected.inputBlockType}`);

        await this.addInputBlock(selected.inputBlockType);
    }

    public async addTextBlockCommandHandler({ textBlockType }: { textBlockType: TextBlockType }): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (!editor) {
            throw new Error(l10n.t('No active notebook editor found'));
        }

        await this.addTextBlock({ editor, textBlockType });
    }

    public async addTextBlock({
        editor,
        textBlockType
    }: {
        editor: NotebookEditor;
        textBlockType: TextBlockType;
    }): Promise<void> {
        const TEXT_BLOCK_TYPE_EMPTY_VALUES = {
            'text-cell-p': '',
            'text-cell-h1': '# ',
            'text-cell-h2': '## ',
            'text-cell-h3': '### '
        } as const satisfies Record<TextBlockType, string>;

        const cellContent = TEXT_BLOCK_TYPE_EMPTY_VALUES[textBlockType];

        const document = editor.notebook;
        const selection = editor.selection;
        const insertIndex = selection ? selection.end : document.cellCount;

        const result = await notebookUpdaterUtils.chainWithPendingUpdates(document, (edit) => {
            const newCell = new NotebookCellData(NotebookCellKind.Markup, cellContent, 'markdown');
            newCell.metadata = {
                __deepnotePocket: {
                    type: textBlockType
                } satisfies Pocket
            };
            const nbEdit = NotebookEdit.insertCells(insertIndex, [newCell]);
            edit.set(document.uri, [nbEdit]);
        });
        if (result !== true) {
            throw new Error(l10n.t('Failed to insert text block'));
        }

        const notebookRange = new NotebookRange(insertIndex, insertIndex + 1);
        editor.revealRange(notebookRange, NotebookEditorRevealType.Default);
        editor.selection = notebookRange;
        // Enter edit mode on the new cell
        await commands.executeCommand('notebook.cell.edit');
    }

    private async disableSnapshots(): Promise<void> {
        try {
            await this.configurationService.updateSetting(
                'snapshots.enabled',
                false,
                undefined,
                ConfigurationTarget.Workspace
            );
            void window.showInformationMessage(l10n.t('Snapshots disabled for this workspace.'));
        } catch (error) {
            logger.error('Failed to disable snapshots', error);
            void window.showErrorMessage(l10n.t('Failed to disable snapshots.'));
        }
    }

    private async enableSnapshots(): Promise<void> {
        try {
            await this.configurationService.updateSetting(
                'snapshots.enabled',
                true,
                undefined,
                ConfigurationTarget.Workspace
            );
        } catch (error) {
            logger.error('Failed to enable snapshots', error);
            void window.showErrorMessage(l10n.t('Failed to enable snapshots.'));
        }
    }
}
