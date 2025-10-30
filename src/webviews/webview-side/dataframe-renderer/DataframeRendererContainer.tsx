import * as React from 'react';

import { DataframeMetadata, DataframeRenderer } from './DataframeRenderer';
import { RendererContext } from 'vscode-notebook-renderer';

export interface Metadata {
    cellId?: string;
    cellIndex?: number;
    executionCount: number;
    metadata?: DataframeMetadata;
    outputType: string;
}

export function DataframeRendererContainer({
    context,
    outputJson,
    outputMetadata
}: {
    context: RendererContext<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputJson: any;
    outputMetadata: Metadata;
}) {
    console.log(`Dataframe renderer - received data with ${Object.keys(outputJson).length} keys`);

    console.log('[DataframeRenderer] Full metadata', outputMetadata);

    const dataFrameMetadata = outputMetadata?.metadata as DataframeMetadata | undefined;
    const cellId = outputMetadata?.cellId;

    console.log(`[DataframeRenderer] Extracted cellId: ${cellId}`);

    return <DataframeRenderer context={context} data={outputJson} metadata={dataFrameMetadata} cellId={cellId} />;
}
