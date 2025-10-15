import './tailwind.css';

import * as React from 'react';
import * as ReactDOM from 'react-dom';

import type { ActivationFunction, OutputItem, RendererContext } from 'vscode-notebook-renderer';

import { DataframeMetadata, DataframeRenderer } from './DataframeRenderer';

interface Metadata {
    cellId?: string;
    cellIndex?: number;
    executionCount: number;
    metadata?: DataframeMetadata;
    outputType: string;
}

export const activate: ActivationFunction = (context: RendererContext<unknown>) => {
    return {
        renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            console.log(`Dataframe renderer - rendering output item: ${outputItem.id}`);
            try {
                const data = outputItem.json();

                console.log(`Dataframe renderer - received data with ${Object.keys(data).length} keys`);

                const metadata = outputItem.metadata as Metadata | undefined;

                console.log('[DataframeRenderer] Full metadata', metadata);

                const dataFrameMetadata = metadata?.metadata as DataframeMetadata | undefined;
                const cellId = metadata?.cellId;
                const cellIndex = metadata?.cellIndex;

                console.log(`[DataframeRenderer] Extracted cellId: ${cellId}, cellIndex: ${cellIndex}`);

                const root = document.createElement('div');
                element.appendChild(root);

                ReactDOM.render(
                    React.createElement(DataframeRenderer, {
                        context,
                        data,
                        metadata: dataFrameMetadata,
                        cellId,
                        cellIndex
                    }),
                    root
                );
            } catch (error) {
                console.error(`Error rendering dataframe: ${error}`);
                const errorDiv = document.createElement('div');
                errorDiv.style.padding = '10px';
                errorDiv.style.color = 'var(--vscode-errorForeground)';
                errorDiv.textContent = `Error rendering dataframe: ${error}`;
                element.appendChild(errorDiv);
            }
        },

        disposeOutputItem(_id?: string) {
            // Cleanup if needed
        }
    };
};
