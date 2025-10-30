import './styles.css';

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { ErrorBoundary } from 'react-error-boundary';

import type { ActivationFunction, OutputItem, RendererContext } from 'vscode-notebook-renderer';

import { ErrorFallback } from './ErrorBoundary';

import { ChartBigNumberOutputRendererContainer } from './ChartBigNumberOutputRendererContainer';

export const activate: ActivationFunction = (_context: RendererContext<unknown>) => {
    return {
        renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            ReactDOM.render(
                React.createElement(
                    ErrorBoundary,
                    {
                        FallbackComponent: ErrorFallback,
                        onError: (error, info) => {
                            console.error('Vega renderer error:', error, info);
                        }
                    },
                    React.createElement(ChartBigNumberOutputRendererContainer, {
                        outputText: outputItem.text(),
                        outputMetadata: outputItem.metadata
                    })
                ),
                element
            );
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
