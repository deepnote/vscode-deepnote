import * as React from 'react';

import {
    DeepnoteBigNumberMetadataSchema,
    DeepnoteChartBigNumberOutputSchema
} from '../../../notebooks/deepnote/deepnoteSchemas';
import { ChartBigNumberOutputRenderer } from './ChartBigNumberOutputRenderer';

export function ChartBigNumberOutputRendererContainer({
    outputText,
    outputMetadata
}: {
    outputText: string;
    outputMetadata: unknown;
}) {
    // Remove single quotes from start and end of string if present
    const data = JSON.parse(outputText.replace(/^'|'$/g, ''));
    const blockMetadata = DeepnoteBigNumberMetadataSchema.parse(outputMetadata);

    const chartBigNumberOutput = DeepnoteChartBigNumberOutputSchema.parse(data);

    return <ChartBigNumberOutputRenderer output={chartBigNumberOutput} metadata={blockMetadata} />;
}
