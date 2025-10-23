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
}
