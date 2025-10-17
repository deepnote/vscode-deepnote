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
        .string()
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

export type DeepnoteChartBigNumberOutput = z.infer<typeof DeepnoteChartBigNumberOutputSchema>;
export type DeepnoteBigNumberMetadata = z.infer<typeof DeepnoteBigNumberMetadataSchema>;
