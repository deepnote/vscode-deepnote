// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RendererContext } from 'vscode-notebook-renderer';
import { CustomCellRenderer, ButtonCellMetadata } from './types';

export class ButtonRenderer implements CustomCellRenderer {
    render(
        element: HTMLElement,
        source: string,
        metadata: ButtonCellMetadata | undefined,
        context: RendererContext<any>
    ): void {
        // Parse button configuration from source or metadata
        const config = this.parseConfiguration(source, metadata);
        
        // Create button container
        const container = document.createElement('div');
        container.style.cssText = 'padding: 10px; display: flex; align-items: center; gap: 10px;';
        
        // Create the button element
        const button = document.createElement('button');
        button.textContent = config.label || 'Button';
        button.disabled = config.disabled || false;
        
        // Apply styling based on variant and size
        this.applyStyles(button, config);
        
        // Add click handler
        button.addEventListener('click', () => this.handleClick(config, context));
        
        // Add description if provided in source
        if (source && source.trim() && source !== config.label) {
            const description = document.createElement('span');
            description.textContent = source;
            description.style.cssText = 'color: #666; font-size: 14px;';
            container.appendChild(description);
        }
        
        container.appendChild(button);
        element.appendChild(container);
    }

    private parseConfiguration(source: string, metadata?: any): ButtonCellMetadata {
        // For button cells with text in metadata
        let label = 'Button';
        
        // Check if metadata has text field (as in the example)
        if (metadata?.text) {
            label = metadata.text;
        } else if (source && source.trim()) {
            // Try to parse JSON from source
            try {
                const parsedSource = JSON.parse(source);
                label = parsedSource.label || source;
            } catch {
                // If not JSON, use source as label
                label = source;
            }
        }
        
        // Merge configuration from metadata
        return {
            label: label,
            variant: metadata?.variant || 'primary',
            size: metadata?.size || 'medium',
            disabled: metadata?.disabled || false,
            action: metadata?.action
        };
    }

    private applyStyles(button: HTMLElement, config: ButtonCellMetadata): void {
        // Base styles
        button.style.cssText = `
            border: none;
            border-radius: 4px;
            cursor: ${config.disabled ? 'not-allowed' : 'pointer'};
            font-weight: 500;
            transition: all 0.2s ease;
            opacity: ${config.disabled ? '0.6' : '1'};
        `;
        
        // Size styles
        switch (config.size) {
            case 'small':
                button.style.padding = '6px 12px';
                button.style.fontSize = '12px';
                break;
            case 'large':
                button.style.padding = '12px 24px';
                button.style.fontSize = '16px';
                break;
            default: // medium
                button.style.padding = '8px 16px';
                button.style.fontSize = '14px';
                break;
        }
        
        // Variant styles
        switch (config.variant) {
            case 'secondary':
                button.style.backgroundColor = '#6c757d';
                button.style.color = 'white';
                break;
            case 'danger':
                button.style.backgroundColor = '#dc3545';
                button.style.color = 'white';
                break;
            case 'success':
                button.style.backgroundColor = '#28a745';
                button.style.color = 'white';
                break;
            default: // primary
                button.style.backgroundColor = '#007bff';
                button.style.color = 'white';
                break;
        }
        
        // Hover effects
        if (!config.disabled) {
            button.addEventListener('mouseenter', () => {
                button.style.filter = 'brightness(1.1)';
            });
            button.addEventListener('mouseleave', () => {
                button.style.filter = 'brightness(1)';
            });
        }
    }

    private handleClick(config: ButtonCellMetadata, context: RendererContext<any>): void {
        if (!config.action) {
            console.log('Button clicked with no action defined');
            return;
        }

        switch (config.action.type) {
            case 'execute':
                // Execute code in the kernel
                if (context.postMessage) {
                    context.postMessage({
                        command: 'execute',
                        code: config.action.value || ''
                    });
                }
                break;
                
            case 'message':
                // Send a message to the extension
                if (context.postMessage) {
                    context.postMessage({
                        command: 'button-clicked',
                        message: config.action.value || '',
                        label: config.label
                    });
                }
                break;
                
            case 'command':
                // Execute a VS Code command
                if (context.postMessage) {
                    context.postMessage({
                        command: 'execute-command',
                        commandId: config.action.value || ''
                    });
                }
                break;
                
            default:
                console.warn(`Unknown action type: ${config.action.type}`);
        }
    }
}