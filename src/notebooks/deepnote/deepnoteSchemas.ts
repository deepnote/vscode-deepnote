import { z } from 'zod';

export const DeepnoteChartBigNumberOutputSchema = z.object({
    title: z.string().nullish(),
    value: z.string().nullish(),

    comparisonTitle: z.string().nullish(),
    comparisonValue: z.string().nullish()
});

export const DeepnoteBigNumberMetadataSchema = z.object({
    deepnote_big_number_title: z
        .string()
        .nullish()
        .transform((val) => val ?? ''),
    deepnote_big_number_value: z
        .string()
        .nullish()
        .transform((val) => val ?? ''),
    deepnote_big_number_format: z
        .string()
        .nullish()
        .transform((val) => val ?? 'number'),
    deepnote_big_number_comparison_type: z
        .string()
        .nullish()
        .transform((val) => val ?? ''),
    deepnote_big_number_comparison_title: z
        .string()
        .nullish()
        .transform((val) => val ?? ''),
    deepnote_big_number_comparison_value: z
        .string()
        .nullish()
        .transform((val) => val ?? ''),
    deepnote_big_number_comparison_format: z
        .string()
        .nullish()
        .transform((val) => val ?? ''),
    deepnote_big_number_comparison_enabled: z
        .boolean()
        .nullish()
        .transform((val) => val ?? false)
});

// Base schema with common fields for all input types
const DeepnoteBaseInputMetadataSchema = z.object({
    deepnote_variable_name: z
        .string()
        .nullish()
        .transform((val) => val ?? '')
});

// Extended base schema with label (used by most input types)
const DeepnoteBaseInputWithLabelMetadataSchema = DeepnoteBaseInputMetadataSchema.extend({
    deepnote_input_label: z
        .string()
        .nullish()
        .transform((val) => val ?? '')
});

export const DeepnoteTextInputMetadataSchema = DeepnoteBaseInputWithLabelMetadataSchema.extend({
    deepnote_variable_value: z
        .string()
        .nullish()
        .transform((val) => val ?? ''),
    deepnote_variable_default_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteTextareaInputMetadataSchema = DeepnoteBaseInputWithLabelMetadataSchema.extend({
    deepnote_variable_value: z
        .string()
        .nullish()
        .transform((val) => val ?? ''),
    deepnote_variable_default_value: z
        .string()
        .nullish()
        .transform((val) => val ?? '')
});

export const DEEPNOTE_SELECT_INPUT_DEFAULT_OPTIONS = ['Option 1', 'Option 2'] as const;

export const DeepnoteSelectInputMetadataSchema = DeepnoteBaseInputWithLabelMetadataSchema.extend({
    deepnote_variable_value: z
        .union([z.string(), z.array(z.string())])
        .nullish()
        .transform((val) => val ?? DEEPNOTE_SELECT_INPUT_DEFAULT_OPTIONS[0]),
    deepnote_variable_default_value: z
        .union([z.string(), z.array(z.string())])
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_options: z
        .array(z.string())
        .nullish()
        .transform((val) => val ?? DEEPNOTE_SELECT_INPUT_DEFAULT_OPTIONS),
    deepnote_variable_custom_options: z
        .array(z.string())
        .nullish()
        .transform((val) => val ?? DEEPNOTE_SELECT_INPUT_DEFAULT_OPTIONS),
    deepnote_variable_select_type: z
        .enum(['from-options', 'from-variable'])
        // .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_allow_multiple_values: z
        .boolean()
        .nullish()
        .transform((val) => val ?? false),
    deepnote_allow_empty_values: z
        .boolean()
        .nullish()
        .transform((val) => val ?? false),
    deepnote_variable_selected_variable: z
        .string()
        .nullish()
        .transform((val) => val ?? '')
});

export const DeepnoteSliderInputMetadataSchema = DeepnoteBaseInputWithLabelMetadataSchema.extend({
    deepnote_variable_value: z
        .string()
        .nullish()
        .transform((val) => val ?? '5'),
    deepnote_slider_min_value: z
        .number()
        .nullish()
        .transform((val) => val ?? 0),
    deepnote_slider_max_value: z
        .number()
        .nullish()
        .transform((val) => val ?? 10),
    deepnote_slider_step: z
        .number()
        .nullish()
        .transform((val) => val ?? 1),
    deepnote_variable_default_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteCheckboxInputMetadataSchema = DeepnoteBaseInputWithLabelMetadataSchema.extend({
    deepnote_variable_value: z
        .boolean()
        .nullish()
        .transform((val) => val ?? false),
    deepnote_variable_default_value: z
        .boolean()
        .nullish()
        .transform((val) => val ?? null)
});

export function getStartOfDayDate(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

export const DeepnoteDateInputMetadataSchema = DeepnoteBaseInputWithLabelMetadataSchema.extend({
    deepnote_variable_value: z
        .string()
        .nullish()
        .transform((val) => val ?? getStartOfDayDate().toISOString()),
    deepnote_variable_default_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_input_date_version: z
        .number()
        .nullish()
        .transform((val) => val ?? 2)
});

export const DeepnoteDateRangeInputMetadataSchema = DeepnoteBaseInputWithLabelMetadataSchema.extend({
    deepnote_variable_value: z
        .union([z.string(), z.tuple([z.string(), z.string()])])
        .nullish()
        .transform((val) => val ?? ''),
    deepnote_variable_default_value: z
        .union([z.string(), z.tuple([z.string(), z.string()])])
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteFileInputMetadataSchema = DeepnoteBaseInputWithLabelMetadataSchema.extend({
    deepnote_variable_value: z
        .string()
        .nullish()
        .transform((val) => val ?? ''),
    deepnote_allowed_file_extensions: z
        .string()
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteButtonMetadataSchema = DeepnoteBaseInputMetadataSchema.extend({
    deepnote_button_title: z
        .string()
        .nullish()
        .transform((val) => val ?? 'Run'),
    deepnote_button_behavior: z
        .enum(['run', 'set_variable'])
        .nullish()
        .transform((val) => val ?? 'set_variable'),
    deepnote_button_color_scheme: z
        .enum(['blue', 'red', 'neutral', 'green', 'yellow'])
        .nullish()
        .transform((val) => val ?? 'blue')
});

export type DeepnoteChartBigNumberOutput = z.infer<typeof DeepnoteChartBigNumberOutputSchema>;
export type DeepnoteBigNumberMetadata = z.infer<typeof DeepnoteBigNumberMetadataSchema>;
