export function formatValue(value: number, format = 'number'): string {
    if (format === 'plain') {
        return value.toString();
    }

    if (format === 'number') {
        return value.toLocaleString();
    }

    if (format === 'percent') {
        const percentage = value * 100;

        if (Math.round(percentage) === percentage) {
            return `${percentage}%`;
        }

        return `${percentage.toFixed(2)}%`;
    }

    if (format === 'scientific') {
        return value.toExponential(2).toUpperCase();
    }

    if (format === 'currency') {
        return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    }

    if (format === 'financial') {
        const financialValue = value < 0 ? value * -1 : value;
        const formattedValue = financialValue.toLocaleString('en-US', { minimumFractionDigits: 2 });

        return value >= 0 ? formattedValue : `(${formattedValue})`;
    }

    return value.toLocaleString();
}
