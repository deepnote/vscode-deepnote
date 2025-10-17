import React from 'react';
import type { FallbackProps } from 'react-error-boundary';

export function ErrorFallback({ error }: FallbackProps) {
    return (
        <div
            style={{
                padding: '16px',
                color: 'var(--vscode-errorForeground)',
                backgroundColor: 'var(--vscode-inputValidation-errorBackground)',
                border: '1px solid var(--vscode-inputValidation-errorBorder)',
                borderRadius: '4px',
                fontFamily: 'var(--vscode-font-family)',
                fontSize: '13px'
            }}
        >
            <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Error rendering chart</div>
            <div style={{ marginBottom: '8px' }}>{error.message}</div>
            <details style={{ marginTop: '8px', cursor: 'pointer' }}>
                <summary>Stack trace</summary>
                <pre
                    style={{
                        marginTop: '8px',
                        padding: '8px',
                        backgroundColor: 'var(--vscode-editor-background)',
                        overflow: 'auto',
                        fontSize: '11px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word'
                    }}
                >
                    {error.stack}
                </pre>
            </details>
        </div>
    );
}

