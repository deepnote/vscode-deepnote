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

    /**
     * Helper method to update block metadata with common logic.
     * Clears block.content, parses schema, deletes DEEPNOTE_VSCODE_RAW_CONTENT_KEY,
     * and merges metadata with updates.
     */
    protected updateBlockMetadata(block: DeepnoteBlock, updates: Partial<z.infer<T>>): void {
        block.content = '';

        const existingMetadata = this.schema().safeParse(block.metadata);
        const baseMetadata = existingMetadata.success ? existingMetadata.data : this.defaultConfig();

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...baseMetadata,
            ...updates
        };
    }

    applyChangesToBlock(block: DeepnoteBlock, _cell: NotebookCellData): void {
        // Default implementation: preserve existing metadata
        // Readonly blocks (select, checkbox, date, date-range, button) use this default behavior
        // Editable blocks override this method to update specific metadata fields
        this.updateBlockMetadata(block, {});
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
        // The cell value contains the text value
        const value = cell.value;

        this.updateBlockMetadata(block, {
            deepnote_variable_value: value
        });
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
        // The cell value contains the text value
        const value = cell.value;

        this.updateBlockMetadata(block, {
            deepnote_variable_value: value
        });
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

    // Select blocks are readonly - edits are reverted by DeepnoteInputBlockEditProtection
    // Uses base class applyChangesToBlock which preserves existing metadata
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
        // Parse numeric value; fall back to existing/default
        const str = cell.value.trim();
        const parsed = Number(str);

        const existingMetadata = this.schema().safeParse(block.metadata);

        const existingValue = existingMetadata.success
            ? Number(existingMetadata.data.deepnote_variable_value)
            : Number(this.defaultConfig().deepnote_variable_value);
        const fallback = Number.isFinite(existingValue) ? existingValue : 0;
        const value = Number.isFinite(parsed) ? parsed : fallback;

        this.updateBlockMetadata(block, {
            deepnote_variable_value: value
        });
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

    // Checkbox blocks are readonly - edits are reverted by DeepnoteInputBlockEditProtection
    // Uses base class applyChangesToBlock which preserves existing metadata
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

    // Date blocks are readonly - edits are reverted by DeepnoteInputBlockEditProtection
    // Uses base class applyChangesToBlock which preserves existing metadata
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

    // Date range blocks are readonly - edits are reverted by DeepnoteInputBlockEditProtection
    // Uses base class applyChangesToBlock which preserves existing metadata
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
        // Remove quotes from the cell value
        const value = cell.value.trim().replace(/^["']|["']$/g, '');

        this.updateBlockMetadata(block, {
            deepnote_variable_value: value
        });
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

    // Button blocks don't store any value from the cell content
    // Uses base class applyChangesToBlock which preserves existing metadata
}
