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

export function getDeepnoteBlockMetadataSchema<T extends z.ZodTypeAny>(schema: T) {
    return z.object({
        [OUTPUT_BLOCK_METADATA_KEY]: schema
    });
}

export type DeepnoteChartBigNumberOutput = z.infer<typeof DeepnoteChartBigNumberOutputSchema>;
export type DeepnoteBigNumberMetadata = z.infer<typeof DeepnoteBigNumberMetadataSchema>;
