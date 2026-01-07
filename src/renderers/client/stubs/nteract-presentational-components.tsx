/**
 * Minimal stub for @nteract/presentational-components
 * Only exports the Error component used by @nteract/transform-vega
 */
import * as React from 'react';

interface ErrorProps {
    error?: Error | string | null;
}

export const Error: React.FC<ErrorProps> = ({ error }) => {
    if (!error) {
        return null;
    }
    const message = error instanceof window.Error ? error.message : String(error);

    return <div style={{ color: 'var(--vscode-errorForeground, #f44336)', padding: '8px' }}>{message}</div>;
};
