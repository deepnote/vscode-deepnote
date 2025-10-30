import React, { memo } from 'react';

export interface SqlMetadataRendererProps {
    data: {
        cache_created_at?: string;
        compiled_query?: string;
        integration_id?: string;
        size_in_bytes?: number;
        status: string;
        variable_type?: string;
    };
}

const getStatusMessage = (status: string) => {
    switch (status) {
        case 'read_from_cache_success':
            return {
                icon: '✓',
                text: 'Query result loaded from cache',
                color: 'var(--vscode-testing-iconPassed)'
            };
        case 'success_no_cache':
            return {
                icon: 'ℹ',
                text: 'Query executed successfully',
                color: 'var(--vscode-notificationsInfoIcon-foreground)'
            };
        case 'cache_not_supported_for_query':
            return {
                icon: 'ℹ',
                text: 'Caching not supported for this query type',
                color: 'var(--vscode-notificationsInfoIcon-foreground)'
            };
        default:
            return {
                icon: 'ℹ',
                text: `Status: ${status}`,
                color: 'var(--vscode-foreground)'
            };
    }
};

const formatBytes = (bytes: number) => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const SqlMetadataRenderer = memo(function SqlMetadataRenderer({ data }: SqlMetadataRendererProps) {
    const statusInfo = getStatusMessage(data.status);

    return (
        <div
            style={{
                padding: '8px 12px',
                margin: '4px 0',
                borderLeft: `3px solid ${statusInfo.color}`,
                backgroundColor: 'var(--vscode-textBlockQuote-background)',
                fontSize: '12px',
                fontFamily: 'var(--vscode-font-family)',
                color: 'var(--vscode-foreground)'
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: data.cache_created_at || data.size_in_bytes ? '6px' : '0'
                }}
            >
                <span style={{ color: statusInfo.color, fontSize: '14px', fontWeight: 'bold' }}>{statusInfo.icon}</span>
                <span style={{ fontWeight: 500 }}>{statusInfo.text}</span>
            </div>

            {data.cache_created_at && (
                <div style={{ marginLeft: '22px', opacity: 0.8, fontSize: '11px' }}>
                    Cache created: {new Date(data.cache_created_at).toLocaleString()}
                </div>
            )}

            {data.size_in_bytes !== undefined && (
                <div style={{ marginLeft: '22px', opacity: 0.8, fontSize: '11px' }}>
                    Result size: {formatBytes(data.size_in_bytes)}
                </div>
            )}
        </div>
    );
});
