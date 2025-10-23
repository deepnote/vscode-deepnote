/**
 * Utility for formatting input block cell content based on block type and metadata.
 * This is the single source of truth for how input block values are displayed in cells.
 */

/**
 * Formats the cell content for an input block based on its type and metadata.
 * @param blockType The type of the input block (e.g., 'input-text', 'input-select')
 * @param metadata The cell metadata containing the value and other configuration
 * @returns The formatted cell content string
 */
export function formatInputBlockCellContent(blockType: string, metadata: Record<string, unknown>): string {
    switch (blockType) {
        case 'input-text':
        case 'input-textarea': {
            const value = metadata.deepnote_variable_value;
            return typeof value === 'string' ? value : '';
        }

        case 'input-select': {
            const value = metadata.deepnote_variable_value;
            if (Array.isArray(value)) {
                // Multi-select: show as array of quoted strings
                return `[${value.map((v) => `"${v}"`).join(', ')}]`;
            } else if (typeof value === 'string') {
                // Single select: show as quoted string
                return `"${value}"`;
            }
            return '';
        }

        case 'input-slider': {
            const value = metadata.deepnote_variable_value;
            return typeof value === 'number' ? String(value) : '';
        }

        case 'input-checkbox': {
            const value = metadata.deepnote_variable_value ?? false;
            return value ? 'True' : 'False';
        }

        case 'input-date': {
            const value = metadata.deepnote_variable_value;
            if (value) {
                const dateStr = formatDateValue(value);
                return dateStr ? `"${dateStr}"` : '""';
            }
            return '""';
        }

        case 'input-date-range': {
            const value = metadata.deepnote_variable_value;
            if (Array.isArray(value) && value.length === 2) {
                const start = formatDateValue(value[0]);
                const end = formatDateValue(value[1]);
                if (start || end) {
                    return `("${start}", "${end}")`;
                }
            } else {
                const defaultValue = metadata.deepnote_variable_default_value;
                if (Array.isArray(defaultValue) && defaultValue.length === 2) {
                    const start = formatDateValue(defaultValue[0]);
                    const end = formatDateValue(defaultValue[1]);
                    if (start || end) {
                        return `("${start}", "${end}")`;
                    }
                }
            }
            return '';
        }

        case 'input-file': {
            const value = metadata.deepnote_variable_value;
            return typeof value === 'string' && value ? `"${value}"` : '';
        }

        case 'button': {
            return '';
        }

        default:
            return '';
    }
}

/**
 * Helper to format date value (could be string or Date object).
 * Converts to YYYY-MM-DD format.
 */
function formatDateValue(val: unknown): string {
    if (!val) {
        return '';
    }
    if (typeof val === 'string') {
        return val;
    }
    if (val instanceof Date) {
        // Convert Date to YYYY-MM-DD format
        return val.toISOString().split('T')[0];
    }
    return String(val);
}

