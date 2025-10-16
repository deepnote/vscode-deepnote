import { chartColors10, chartColors20, deepnoteBlues } from './colors';
import React, { memo, useLayoutEffect } from 'react';
import { Vega } from 'react-vega';
import { vega } from 'vega-embed';

import { numberFormats } from './number-formats';

export interface VegaRendererProps {
    spec: Record<string, unknown>;
    renderer?: 'svg' | 'canvas';
}

export const VegaRenderer = memo(function VegaRenderer(props: VegaRendererProps) {
    const { renderer, spec } = props;

    useLayoutEffect(function registerCustomVegaConfigsOnce() {
        if (vega.expressionFunction('numberFormatFromNumberType')) {
            return;
        }

        vega.expressionFunction(
            'numberFormatFromNumberType',
            (value: number, params: { type: string; decimals: number | null }) => {
                // NOTE: default params.type to "default" value to ensure that eg "Sum of" labels are displayed in custom tooltip
                return numberFormats[params?.type ?? 'default']?.formatter(value, params?.decimals);
            }
        );

        vega.scheme('deepnote10', chartColors10);
        vega.scheme('deepnote20', chartColors20);
        vega.scheme('deepnote_blues', deepnoteBlues);
    }, []);

    return (
        <Vega
            spec={spec}
            renderer={renderer}
            actions={false}
            style={{
                height: '100%',
                width: '100%'
            }}
        />
    );
});
