import { z } from 'zod';

import { OUTPUT_BLOCK_METADATA_KEY } from './deepnoteConstants';

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
        .transform((val) => val ?? null),
    deepnote_big_number_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_big_number_format: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_big_number_comparison_type: z
        .enum(['absolute-value', 'percentage-change', 'absolute-change'])
        .nullish()
        .transform((val) => val ?? null),
    deepnote_big_number_comparison_title: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_big_number_comparison_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_big_number_comparison_format: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_big_number_comparison_enabled: z
        .boolean()
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteTextInputMetadataSchema = z.object({
    deepnote_variable_name: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_default_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_input_label: z
        .string()
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteTextareaInputMetadataSchema = z.object({
    deepnote_variable_name: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_input_label: z
        .string()
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteSelectInputMetadataSchema = z.object({
    deepnote_input_label: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_name: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_value: z
        .union([z.string(), z.array(z.string())])
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_options: z
        .array(z.string())
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_custom_options: z
        .array(z.string())
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_select_type: z
        .enum(['from-options', 'from-variable'])
        .nullish()
        .transform((val) => val ?? null),
    deepnote_allow_multiple_values: z
        .boolean()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_allow_empty_values: z
        .boolean()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_default_value: z
        .union([z.string(), z.array(z.string())])
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_selected_variable: z
        .string()
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteSliderInputMetadataSchema = z.object({
    deepnote_input_label: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_name: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_value: z
        .union([z.string(), z.number()])
        .nullish()
        .transform((val) => val ?? null),
    deepnote_slider_min_value: z
        .number()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_slider_max_value: z
        .number()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_slider_step: z
        .number()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_default_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteCheckboxInputMetadataSchema = z.object({
    deepnote_input_label: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_name: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_value: z
        .boolean()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_default_value: z
        .boolean()
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteDateInputMetadataSchema = z.object({
    deepnote_input_label: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_name: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_default_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_input_date_version: z
        .number()
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteDateRangeInputMetadataSchema = z.object({
    deepnote_input_label: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_name: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_value: z
        .union([z.string(), z.tuple([z.string(), z.string()])])
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_default_value: z
        .union([z.string(), z.tuple([z.string(), z.string()])])
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteFileInputMetadataSchema = z.object({
    deepnote_input_label: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_name: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_value: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_allowed_file_extensions: z
        .string()
        .nullish()
        .transform((val) => val ?? null)
});

export const DeepnoteButtonMetadataSchema = z.object({
    deepnote_button_title: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_variable_name: z
        .string()
        .nullish()
        .transform((val) => val ?? null),
    deepnote_button_behavior: z
        .enum(['run', 'set_variable'])
        .nullish()
        .transform((val) => val ?? null),
    deepnote_button_color_scheme: z
        .enum(['blue', 'red', 'neutral', 'green', 'yellow'])
        .nullish()
        .transform((val) => val ?? null)
});

export function getDeepnoteBlockMetadataSchema<T extends z.ZodTypeAny>(schema: T) {
    return z.object({
        [OUTPUT_BLOCK_METADATA_KEY]: schema
    });
}

export type DeepnoteChartBigNumberOutput = z.infer<typeof DeepnoteChartBigNumberOutputSchema>;
export type DeepnoteBigNumberMetadata = z.infer<typeof DeepnoteBigNumberMetadataSchema>;
