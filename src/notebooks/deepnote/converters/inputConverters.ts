import { NotebookCellData, NotebookCellKind } from 'vscode';
import { z } from 'zod';

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
            console.error('Error parsing deepnote input metadata:', deepnoteMetadataResult.error);
            console.debug('Metadata:', JSON.stringify(block.metadata));
        }

        // Extract the variable name from metadata
        const variableName = deepnoteMetadataResult.success
            ? (deepnoteMetadataResult.data as { deepnote_variable_name?: string }).deepnote_variable_name || ''
            : '';

        // Create a code cell with Python language showing just the variable name
        const cell = new NotebookCellData(NotebookCellKind.Code, `# ${variableName}`, 'python');

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
        const deepnoteMetadataResult = this.schema().safeParse(block.metadata);
        const value = deepnoteMetadataResult.success
            ? (deepnoteMetadataResult.data.deepnote_variable_value as string) || ''
            : '';

        // Use plaintext language for text input
        const cell = new NotebookCellData(NotebookCellKind.Code, value, 'plaintext');
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
        const deepnoteMetadataResult = this.schema().safeParse(block.metadata);
        const value = deepnoteMetadataResult.success
            ? (deepnoteMetadataResult.data.deepnote_variable_value as string) || ''
            : '';

        // Use plaintext language for textarea input
        const cell = new NotebookCellData(NotebookCellKind.Code, value, 'plaintext');
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
        const deepnoteMetadataResult = this.schema().safeParse(block.metadata);
        const value = deepnoteMetadataResult.success ? deepnoteMetadataResult.data.deepnote_variable_value : '';

        let cellValue = '';
        if (Array.isArray(value)) {
            // Multi-select: show as array of quoted strings
            cellValue = `[${value.map((v) => `"${v}"`).join(', ')}]`;
        } else if (typeof value === 'string') {
            // Single select: show as quoted string
            cellValue = `"${value}"`;
        }

        const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'python');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        // Parse the cell value to extract the selection
        const cellValue = cell.value.trim();
        let value: string | string[];

        if (cellValue.startsWith('[') && cellValue.endsWith(']')) {
            // Multi-select: parse array
            const arrayContent = cellValue.slice(1, -1);
            value = arrayContent
                .split(',')
                .map((v) => v.trim())
                .filter((v) => v)
                .map((v) => v.replace(/^["']|["']$/g, ''));
        } else {
            // Single select: remove quotes
            value = cellValue.replace(/^["']|["']$/g, '');
        }

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
        const deepnoteMetadataResult = this.schema().safeParse(block.metadata);
        const value = deepnoteMetadataResult.success
            ? (deepnoteMetadataResult.data.deepnote_variable_value as string) || '5'
            : '5';

        // Show the numeric value
        const cell = new NotebookCellData(NotebookCellKind.Code, value, 'python');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        // The cell value contains the numeric value as a string
        const value = cell.value.trim();

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
        const deepnoteMetadataResult = this.schema().safeParse(block.metadata);
        const value = deepnoteMetadataResult.success
            ? (deepnoteMetadataResult.data.deepnote_variable_value as boolean) ?? false
            : false;

        // Show true/false
        const cell = new NotebookCellData(NotebookCellKind.Code, value ? 'True' : 'False', 'python');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        // Parse the cell value to get boolean
        const cellValue = cell.value.trim();
        const value = cellValue === 'True' || cellValue === 'true';

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
        // Get value directly from metadata to avoid Date object conversion
        const rawValue = block.metadata?.deepnote_variable_value;

        // Format date value (could be string or Date object)
        let value = '';
        if (rawValue) {
            if (typeof rawValue === 'string') {
                value = rawValue;
            } else if (rawValue instanceof Date) {
                // Convert Date to YYYY-MM-DD format
                value = rawValue.toISOString().split('T')[0];
            } else {
                value = String(rawValue);
            }
        }

        // Show date as quoted string
        const cellValue = value ? `"${value}"` : '""';
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
        // Get value directly from metadata first, then try schema parsing
        const rawValue = block.metadata?.deepnote_variable_value;
        const rawDefaultValue = block.metadata?.deepnote_variable_default_value;

        let cellValue = '';

        // Helper to format date value (could be string or Date object)
        const formatDateValue = (val: unknown): string => {
            if (!val) {
                return '';
            }
            if (typeof val === 'string') {
                return val;
            }
            if (val instanceof Date) {
                // Convert Date to YYYY-MM-DD format
                return val.toISOString().split('T')[0];
            }
            return String(val);
        };

        // Check raw value first (before schema transformation)
        if (Array.isArray(rawValue) && rawValue.length === 2) {
            // Show as tuple of quoted strings
            const start = formatDateValue(rawValue[0]);
            const end = formatDateValue(rawValue[1]);
            if (start || end) {
                cellValue = `("${start}", "${end}")`;
            }
        } else if (Array.isArray(rawDefaultValue) && rawDefaultValue.length === 2) {
            // Use default value if available
            const start = formatDateValue(rawDefaultValue[0]);
            const end = formatDateValue(rawDefaultValue[1]);
            if (start || end) {
                cellValue = `("${start}", "${end}")`;
            }
        } else if (typeof rawValue === 'string' && rawValue) {
            // Single date string (shouldn't happen but handle it)
            cellValue = `"${rawValue}"`;
        }
        // If no value, cellValue remains empty string

        const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'python');
        return cell;
    }

    override applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        // Parse the cell value to extract the date range
        const cellValue = cell.value.trim();
        let value: [string, string] | string = '';

        // Try to parse as tuple
        const tupleMatch = cellValue.match(/\(\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']\s*\)/);
        if (tupleMatch) {
            value = [tupleMatch[1], tupleMatch[2]];
        }

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
        const deepnoteMetadataResult = this.schema().safeParse(block.metadata);
        const value = deepnoteMetadataResult.success
            ? (deepnoteMetadataResult.data.deepnote_variable_value as string) || ''
            : '';

        // Show file path as quoted string
        const cellValue = value ? `"${value}"` : '""';
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

    override convertToCell(_block: DeepnoteBlock): NotebookCellData {
        // Button blocks have no content
        const cell = new NotebookCellData(NotebookCellKind.Code, '', 'python');
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
