import React, { useMemo } from 'react';
import { DeepnoteBigNumberMetadata, DeepnoteChartBigNumberOutput } from '../../../notebooks/deepnote/deepnoteSchemas';
import { formatValue } from '../../deepnote-utils/format-value';

export function ChartBigNumberOutputRenderer({
    output,
    metadata
}: {
    output: DeepnoteChartBigNumberOutput;
    metadata: DeepnoteBigNumberMetadata;
}) {
    const hasErrors = false;

    const title = useMemo(() => {
        if (hasErrors) {
            return 'Not defined';
        }

        return output.title || 'Title';
    }, [output.title, hasErrors]);

    const value = useMemo(() => {
        if (hasErrors) {
            return 'N/A';
        }

        if (!output.value) {
            return 'Value';
        }

        const parsedValue = parseFloat(output.value);

        if (isNaN(parsedValue)) {
            return 'NaN';
        }

        return formatValue(parsedValue, metadata.deepnote_big_number_format ?? 'number');
    }, [hasErrors, output.value, metadata.deepnote_big_number_format]);

    const comparisonValue = useMemo(() => {
        if (hasErrors) {
            return undefined;
        }

        if (!output.comparisonValue) {
            return undefined;
        }

        if (!output.value) {
            return;
        }

        const isFloat = output.value.includes('.') || output.comparisonValue.includes('.');

        const parsedValue = isFloat ? parseFloat(output.value) : parseInt(output.value, 10);
        const parsedComparisonValue = isFloat
            ? parseFloat(output.comparisonValue)
            : parseInt(output.comparisonValue, 10);

        if (isNaN(parsedValue) || isNaN(parsedComparisonValue)) {
            return undefined;
        }

        if (metadata.deepnote_big_number_comparison_type === 'percentage-change') {
            return (parsedValue - parsedComparisonValue) / parsedComparisonValue;
        }

        if (metadata.deepnote_big_number_comparison_type === 'absolute-value') {
            return parsedComparisonValue;
        }

        return parsedValue - parsedComparisonValue;
    }, [hasErrors, metadata.deepnote_big_number_comparison_type, output.comparisonValue, output.value]);

    const formattedComparisonValue = useMemo(() => {
        if (hasErrors) {
            return '-';
        }

        if (!comparisonValue) {
            return '-';
        }

        if (metadata.deepnote_big_number_comparison_type === 'percentage-change') {
            const roundedPercentage = Math.round(comparisonValue * 100) / 100;

            return formatValue(roundedPercentage, 'percent');
        }

        return formatValue(comparisonValue, metadata.deepnote_big_number_format ?? 'number');
    }, [comparisonValue, metadata.deepnote_big_number_format, hasErrors, metadata.deepnote_big_number_comparison_type]);

    const changeDirection = useMemo(() => {
        if (!comparisonValue) {
            return 1;
        }

        return comparisonValue >= 0 ? 1 : -1;
    }, [comparisonValue]);

    const comparisonClassName = useMemo(() => {
        if (metadata.deepnote_big_number_comparison_format === 'off') {
            return 'deepnote-comparison-neutral';
        }

        const formatModifier = metadata.deepnote_big_number_comparison_format === 'inverse' ? -1 : 1;
        const modifiedDirection = changeDirection * formatModifier;

        if (modifiedDirection < 0) {
            return 'deepnote-comparison-negative';
        }

        return 'deepnote-comparison-positive';
    }, [changeDirection, metadata.deepnote_big_number_comparison_format]);

    return (
        <div className="deepnote-big-number-container">
            <div className="deepnote-big-number-card">
                <div className="deepnote-big-number-content">
                    <div>
                        <p className="deepnote-big-number-title">{title}</p>
                    </div>
                    <div>
                        <p className="deepnote-big-number-value">{value}</p>
                    </div>
                    <div className="deepnote-big-number-comparison">
                        <div>
                            <p className={`deepnote-comparison-text ${comparisonClassName}`}>
                                {formattedComparisonValue}
                            </p>
                        </div>
                        {output.comparisonTitle != null ? (
                            <>
                                {' '}
                                <div>
                                    <p className="deepnote-comparison-title">{output.comparisonTitle}</p>
                                </div>
                            </>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}
