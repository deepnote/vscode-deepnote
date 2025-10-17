import { chartColors10, chartColors20, deepnoteBlues } from './colors';
import React, { memo, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Vega } from 'react-vega';
import { vega } from 'vega-embed';
import { produce } from 'immer';

import { numberFormats } from './number-formats';
import { detectBaseTheme } from '../react-common/themeDetector';

export interface VegaRendererProps {
    spec: Record<string, unknown>;
    renderer?: 'svg' | 'canvas';
}

interface ThemeColors {
    backgroundColor: string;
    foregroundColor: string;
    isDark: boolean;
}

const getThemeColors = (): ThemeColors => {
    const theme = detectBaseTheme();
    const isDark = theme === 'vscode-dark' || theme === 'vscode-high-contrast';
    const styles = getComputedStyle(document.body);
    const backgroundColor = styles.getPropertyValue('--vscode-editor-background').trim() || 'transparent';
    const foregroundColor = styles.getPropertyValue('--vscode-editor-foreground').trim() || '#000000';

    return { backgroundColor, foregroundColor, isDark };
};

function useThemeColors(): ThemeColors {
    const [themeColors, setThemeColors] = useState(getThemeColors);

    useEffect(() => {
        const observer = new MutationObserver(() => {
            console.log('Observed body change')
            setThemeColors(getThemeColors());
        });

        observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'data-vscode-theme-name']
        });

        return () => observer.disconnect();
    }, []);

    return themeColors;
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

    const { backgroundColor, foregroundColor, isDark } = useThemeColors();
    const themedSpec = useMemo(() => {
        const patchedSpec = produce(spec, (draft: any) => {
            draft.background = backgroundColor;

            if (!draft.config) {
                draft.config = {};
            }

            draft.config.background = backgroundColor;

            if (!draft.config.axis) {
                draft.config.axis = {};
            }
            draft.config.axis.domainColor = foregroundColor;
            draft.config.axis.gridColor = isDark ? '#3e3e3e' : '#e0e0e0';
            draft.config.axis.tickColor = foregroundColor;
            draft.config.axis.labelColor = foregroundColor;
            draft.config.axis.titleColor = foregroundColor;

            if (!draft.config.legend) {
                draft.config.legend = {};
            }
            draft.config.legend.labelColor = foregroundColor;
            draft.config.legend.titleColor = foregroundColor;

            if (!draft.config.title) {
                draft.config.title = {};
            }
            draft.config.title.color = foregroundColor;

            if (!draft.config.text) {
                draft.config.text = {};
            }
            draft.config.text.color = foregroundColor;
        });
        return structuredClone(patchedSpec); // Immer freezes the spec, which doesn't play well with Vega
    }, [spec, backgroundColor, foregroundColor, isDark]);

    return (
        <Vega
            spec={themedSpec}
            renderer={renderer}
            actions={false}
            style={{
                height: '100%',
                width: '100%'
            }}
        />
    );
});
