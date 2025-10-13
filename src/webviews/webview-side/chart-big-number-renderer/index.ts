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
                // .slice(1, -1) is to remove the quotes from the json string
                const data = JSON.parse(outputItem.text().slice(1, -1));
                const metadata = DeepnoteBigNumberMetadataSchema.parse(outputItem.metadata);
                console.log('Chart Big Number renderer - received data:', data);

                const chartBigNumberOutput = DeepnoteChartBigNumberOutputSchema.parse(data);
                console.log('bigNumberConfig', chartBigNumberOutput);

                const root = document.createElement('div');
                element.appendChild(root);

                ReactDOM.render(
                    React.createElement(ChartBigNumberOutputRenderer, { output: chartBigNumberOutput, metadata }),
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
