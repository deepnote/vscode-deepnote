import { NotebookCellData, NotebookCellKind } from 'vscode';
import { z } from 'zod';

import { logger } from '../../../platform/logging';
import type { BlockConverter } from './blockConverter';
import type { DeepnoteBlock } from '../../../platform/deepnote/deepnoteTypes';
import {
    DeepnoteTextInputMetadataSchema,
    DeepnoteTextareaInputMetadataSchema,
    DeepnoteSelectInputMetadataSchema,
    DeepnoteSliderInputMetadataSchema,
    DeepnoteCheckboxInputMetadataSchema,
    DeepnoteDateInputMetadataSchema,
    DeepnoteDateRangeInputMetadataSchema,
    DeepnoteFileInputMetadataSchema,
    DeepnoteButtonMetadataSchema
} from '../deepnoteSchemas';
import { DEEPNOTE_VSCODE_RAW_CONTENT_KEY } from './constants';
import { formatInputBlockCellContent } from '../inputBlockContentFormatter';

export abstract class BaseInputBlockConverter<T extends z.ZodObject> implements BlockConverter {
    abstract schema(): T;
    abstract getSupportedType(): string;
    abstract defaultConfig(): z.infer<T>;

    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        // The cell value now contains just the variable name
        const variableName = cell.value.trim();

        // Preserve existing metadata and update only the variable name
        const existingMetadata = this.schema().safeParse(block.metadata);
        const baseMetadata = existingMetadata.success ? existingMetadata.data : this.defaultConfig();

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...baseMetadata,
            deepnote_variable_name: variableName
        };
    }

    canConvert(blockType: string): boolean {
        return blockType.toLowerCase() === this.getSupportedType();
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        const deepnoteMetadataResult = this.schema().safeParse(block.metadata);

        if (deepnoteMetadataResult.error != null) {
            logger.error('Error parsing deepnote input metadata', deepnoteMetadataResult.error);
        }

        // Create a code cell with Python language showing just the variable name
        const cell = new NotebookCellData(NotebookCellKind.Code, '', 'plaintext');

        return cell;
    }

    getSupportedTypes(): string[] {
        return [this.getSupportedType()];
    }
}

export class InputTextBlockConverter extends BaseInputBlockConverter<typeof DeepnoteTextInputMetadataSchema> {
    private readonly DEFAULT_INPUT_TEXT_CONFIG = DeepnoteTextInputMetadataSchema.parse({});

    schema() {
        return DeepnoteTextInputMetadataSchema;
    }
    getSupportedType() {
        return 'input-text';
    }
    defaultConfig() {
        return this.DEFAULT_INPUT_TEXT_CONFIG;
    }

    override convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cellValue = formatInputBlockCellContent('input-text', block.metadata ?? {});
        const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'plaintext');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        // The cell value contains the text value
        const value = cell.value;

        const existingMetadata = this.schema().safeParse(block.metadata);
        const baseMetadata = existingMetadata.success ? existingMetadata.data : this.defaultConfig();

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...baseMetadata,
            deepnote_variable_value: value
        };
    }
}

export class InputTextareaBlockConverter extends BaseInputBlockConverter<typeof DeepnoteTextareaInputMetadataSchema> {
    private readonly DEFAULT_INPUT_TEXTAREA_CONFIG = DeepnoteTextareaInputMetadataSchema.parse({});

    schema() {
        return DeepnoteTextareaInputMetadataSchema;
    }
    getSupportedType() {
        return 'input-textarea';
    }
    defaultConfig() {
        return this.DEFAULT_INPUT_TEXTAREA_CONFIG;
    }

    override convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cellValue = formatInputBlockCellContent('input-textarea', block.metadata ?? {});
        const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'plaintext');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        // The cell value contains the text value
        const value = cell.value;

        const existingMetadata = this.schema().safeParse(block.metadata);
        const baseMetadata = existingMetadata.success ? existingMetadata.data : this.defaultConfig();

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...baseMetadata,
            deepnote_variable_value: value
        };
    }
}

export class InputSelectBlockConverter extends BaseInputBlockConverter<typeof DeepnoteSelectInputMetadataSchema> {
    private readonly DEFAULT_INPUT_SELECT_CONFIG = DeepnoteSelectInputMetadataSchema.parse({});

    schema() {
        return DeepnoteSelectInputMetadataSchema;
    }
    getSupportedType() {
        return 'input-select';
    }
    defaultConfig() {
        return this.DEFAULT_INPUT_SELECT_CONFIG;
    }

    override convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cellValue = formatInputBlockCellContent('input-select', block.metadata ?? {});
        const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'python');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, _cell: NotebookCellData): void {
        block.content = '';

        // Select blocks are readonly - edits are reverted by DeepnoteInputBlockEditProtection
        // Just preserve existing metadata
        const existingMetadata = this.schema().safeParse(block.metadata);
        const baseMetadata = existingMetadata.success ? existingMetadata.data : this.defaultConfig();

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...baseMetadata
        };
    }
}

export class InputSliderBlockConverter extends BaseInputBlockConverter<typeof DeepnoteSliderInputMetadataSchema> {
    private readonly DEFAULT_INPUT_SLIDER_CONFIG = DeepnoteSliderInputMetadataSchema.parse({});

    schema() {
        return DeepnoteSliderInputMetadataSchema;
    }
    getSupportedType() {
        return 'input-slider';
    }
    defaultConfig() {
        return this.DEFAULT_INPUT_SLIDER_CONFIG;
    }

    override convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cellValue = formatInputBlockCellContent('input-slider', block.metadata ?? {});
        const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'python');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        // Parse numeric value; fall back to existing/default
        const str = cell.value.trim();
        const parsed = Number(str);

        const existingMetadata = this.schema().safeParse(block.metadata);
        const baseMetadata = existingMetadata.success ? existingMetadata.data : this.defaultConfig();

        let value: number;
        if (Number.isFinite(parsed)) {
            value = parsed;
        } else if (existingMetadata.success) {
            // Parse existing value as number (it might be stored as string in schema)
            const existingValue = existingMetadata.data.deepnote_variable_value;
            const existingParsed = Number(existingValue);
            value = Number.isFinite(existingParsed) ? existingParsed : 0;
        } else {
            const defaultValue = this.defaultConfig().deepnote_variable_value;
            const defaultParsed = Number(defaultValue);
            value = Number.isFinite(defaultParsed) ? defaultParsed : 0;
        }

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...baseMetadata,
            deepnote_variable_value: value
        };
    }
}

export class InputCheckboxBlockConverter extends BaseInputBlockConverter<typeof DeepnoteCheckboxInputMetadataSchema> {
    private readonly DEFAULT_INPUT_CHECKBOX_CONFIG = DeepnoteCheckboxInputMetadataSchema.parse({});

    schema() {
        return DeepnoteCheckboxInputMetadataSchema;
    }
    getSupportedType() {
        return 'input-checkbox';
    }
    defaultConfig() {
        return this.DEFAULT_INPUT_CHECKBOX_CONFIG;
    }

    override convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cellValue = formatInputBlockCellContent('input-checkbox', block.metadata ?? {});
        const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'python');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, _cell: NotebookCellData): void {
        block.content = '';

        // Checkbox blocks are readonly - edits are reverted by DeepnoteInputBlockEditProtection
        // Just preserve existing metadata
        const existingMetadata = this.schema().safeParse(block.metadata);
        const baseMetadata = existingMetadata.success ? existingMetadata.data : this.defaultConfig();

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...baseMetadata
        };
    }
}

export class InputDateBlockConverter extends BaseInputBlockConverter<typeof DeepnoteDateInputMetadataSchema> {
    private readonly DEFAULT_INPUT_DATE_CONFIG = DeepnoteDateInputMetadataSchema.parse({});

    schema() {
        return DeepnoteDateInputMetadataSchema;
    }
    getSupportedType() {
        return 'input-date';
    }
    defaultConfig() {
        return this.DEFAULT_INPUT_DATE_CONFIG;
    }

    override convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cellValue = formatInputBlockCellContent('input-date', block.metadata ?? {});
        const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'python');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, _cell: NotebookCellData): void {
        block.content = '';

        // Date blocks are readonly - edits are reverted by DeepnoteInputBlockEditProtection
        // Just preserve existing metadata
        const existingMetadata = this.schema().safeParse(block.metadata);
        const baseMetadata = existingMetadata.success ? existingMetadata.data : this.defaultConfig();

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...baseMetadata
        };
    }
}

export class InputDateRangeBlockConverter extends BaseInputBlockConverter<typeof DeepnoteDateRangeInputMetadataSchema> {
    private readonly DEFAULT_INPUT_DATE_RANGE_CONFIG = DeepnoteDateRangeInputMetadataSchema.parse({});

    schema() {
        return DeepnoteDateRangeInputMetadataSchema;
    }
    getSupportedType() {
        return 'input-date-range';
    }
    defaultConfig() {
        return this.DEFAULT_INPUT_DATE_RANGE_CONFIG;
    }

    override convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cellValue = formatInputBlockCellContent('input-date-range', block.metadata ?? {});
        const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'python');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, _cell: NotebookCellData): void {
        block.content = '';

        // Date range blocks are readonly - edits are reverted by DeepnoteInputBlockEditProtection
        // Just preserve existing metadata
        const existingMetadata = this.schema().safeParse(block.metadata);
        const baseMetadata = existingMetadata.success ? existingMetadata.data : this.defaultConfig();

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...baseMetadata
        };
    }
}

export class InputFileBlockConverter extends BaseInputBlockConverter<typeof DeepnoteFileInputMetadataSchema> {
    private readonly DEFAULT_INPUT_FILE_CONFIG = DeepnoteFileInputMetadataSchema.parse({});

    schema() {
        return DeepnoteFileInputMetadataSchema;
    }
    getSupportedType() {
        return 'input-file';
    }
    defaultConfig() {
        return this.DEFAULT_INPUT_FILE_CONFIG;
    }

    override convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cellValue = formatInputBlockCellContent('input-file', block.metadata ?? {});
        const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'python');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        // Remove quotes from the cell value
        const value = cell.value.trim().replace(/^["']|["']$/g, '');

        const existingMetadata = this.schema().safeParse(block.metadata);
        const baseMetadata = existingMetadata.success ? existingMetadata.data : this.defaultConfig();

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...baseMetadata,
            deepnote_variable_value: value
        };
    }
}

export class ButtonBlockConverter extends BaseInputBlockConverter<typeof DeepnoteButtonMetadataSchema> {
    private readonly DEFAULT_BUTTON_CONFIG = DeepnoteButtonMetadataSchema.parse({});

    schema() {
        return DeepnoteButtonMetadataSchema;
    }
    getSupportedType() {
        return 'button';
    }
    defaultConfig() {
        return this.DEFAULT_BUTTON_CONFIG;
    }

    override convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cellValue = formatInputBlockCellContent('button', block.metadata ?? {});
        const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'python');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, _cell: NotebookCellData): void {
        block.content = '';

        // Button blocks don't store any value from the cell content
        const existingMetadata = this.schema().safeParse(block.metadata);
        const baseMetadata = existingMetadata.success ? existingMetadata.data : this.defaultConfig();

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...baseMetadata
        };
    }
}
