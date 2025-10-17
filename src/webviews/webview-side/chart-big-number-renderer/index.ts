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

                ReactDOM.render(
                    React.createElement(ChartBigNumberOutputRenderer, {
                        output: chartBigNumberOutput,
                        metadata: blockMetadata
                    }),
                    element
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

        disposeOutputItem(id?: string) {
            // If undefined, all cells are being removed.
            if (id == null) {
                for (let i = 0; i < document.children.length; i++) {
                    const child = document.children.item(i);
                    if (child == null) {
                        continue;
                    }
                    ReactDOM.unmountComponentAtNode(child);
                }
                return;
            }

            const element = document.getElementById(id);
            if (element == null) {
                return;
            }
            ReactDOM.unmountComponentAtNode(element);
        }
    };
};
