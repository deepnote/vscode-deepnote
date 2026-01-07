import * as vegaEmbed from 'vega-embed';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { isDarkTheme } from './constants';
import { ActivationFunction, OutputItem, RendererContext } from 'vscode-notebook-renderer';

const vegaViews = new Map<string, vegaEmbed.Result>();
const VEGA_MIME_TYPE = 'application/vnd.vega.v5+json';
export const activate: ActivationFunction = (_ctx: RendererContext<unknown>) => {
    return {
        async renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            try {
                const metadata: Record<typeof outputItem.mime, { embed_options?: vegaEmbed.EmbedOptions }> =
                    outputItem.metadata && typeof outputItem.metadata === 'object' && 'metadata' in outputItem.metadata
                        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          (outputItem.metadata as any)['metadata']
                        : {};
                const mode: vegaEmbed.Mode = outputItem.mime === VEGA_MIME_TYPE ? 'vega' : 'vega-lite';
                const spec: vegaEmbed.VisualizationSpec = outputItem.json();
                if (spec === undefined) {
                    return;
                }
                const mimeMetadata = metadata && outputItem.mime in metadata ? metadata[outputItem.mime] || {} : {};
                const embedOptions: vegaEmbed.EmbedOptions =
                    typeof mimeMetadata === 'object' && mimeMetadata ? mimeMetadata.embed_options || {} : {};

                if (isDarkTheme() && !embedOptions.theme && !spec.background) {
                    // Set the theme as dark only if user has not already defined a theme or background color for the chart.
                    // I.e. we don't want to override user settings.
                    embedOptions.theme = 'dark';
                }
                // Dispose of any existing view.
                vegaViews.get(outputItem.id)?.finalize();
                const loader = vegaEmbed.vega.loader({
                    http: { credentials: 'same-origin' }
                });
                const sanitize = async (uri: string, options: unknown) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return loader.sanitize(uri, options as any);
                };
                // Don't use `element`, else the menu options appear on the far right.
                // Because `element` has a fixed width, and `ele` (newly created) does not.
                const ele = document.createElement('div');
                element.appendChild(ele);
                const result = await vegaEmbed.default(ele, spec, {
                    actions: {
                        export: true,
                        compiled: false, // No point displaying these menu options if they do not work.
                        editor: false, // No point displaying these menu options if they do not work.
                        source: false // No point displaying these menu options if they do not work.
                    },
                    defaultStyle: true,
                    ...embedOptions,
                    mode,
                    loader: { ...loader, sanitize }
                });
                vegaViews.set(outputItem.id, result);
            } catch (error) {
                element.textContent = `Failed to render Vega visualization: ${
                    error instanceof Error ? error.message : String(error)
                }`;
            }
        },
        disposeOutputItem(id?) {
            if (id) {
                vegaViews.get(id)?.finalize();
                vegaViews.delete(id);
            }
        }
    };
};
