import './styles.css';

import * as React from 'react';
import * as ReactDOM from 'react-dom';

import type { ActivationFunction, OutputItem, RendererContext } from 'vscode-notebook-renderer';

import { ChartBigNumberOutputRenderer } from './ChartBigNumberOutputRenderer';
import {
    DeepnoteBigNumberMetadataSchema,
    DeepnoteChartBigNumberOutputSchema
} from '../../../notebooks/deepnote/deepnoteSchemas';

export const activate: ActivationFunction = (_context: RendererContext<unknown>) => {
    return {
        renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            try {
                // Remove single quotes from start and end of string if present
                const data = JSON.parse(outputItem.text().replace(/^'|'$/g, ''));
                const blockMetadata = DeepnoteBigNumberMetadataSchema.parse(outputItem.metadata);

                const chartBigNumberOutput = DeepnoteChartBigNumberOutputSchema.parse(data);

                const root = document.createElement('div');
                element.appendChild(root);

                ReactDOM.render(
                    React.createElement(ChartBigNumberOutputRenderer, {
                        output: chartBigNumberOutput,
                        metadata: blockMetadata
                    }),
                    root
                );
            } catch (error) {
                console.error('Error rendering chart big number:', error);
                const errorDiv = document.createElement('div');
                errorDiv.style.padding = '10px';
                errorDiv.style.color = 'var(--vscode-errorForeground)';
                errorDiv.textContent = `Error rendering chart big number: ${error}`;
                element.appendChild(errorDiv);
            }
        },

        disposeOutputItem(_id?: string) {
            // Cleanup if needed
        }
    };
};
