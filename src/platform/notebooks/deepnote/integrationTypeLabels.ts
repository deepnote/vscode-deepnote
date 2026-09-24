import type { ConfigurableDatabaseIntegrationType } from './integrationTypes';

/**
 * Where an integration type's display label sits in the string bundle the extension host sends the webview.
 *
 * Derived from the type rather than listed, so `localize.Integrations.typeLabels` is the only place the labels
 * themselves are written down — the webview is bundled separately and cannot read `localize.ts` directly.
 */
export type IntegrationTypeLabelKey = `integrationType.${ConfigurableDatabaseIntegrationType}`;

export function integrationTypeLabelKey(type: ConfigurableDatabaseIntegrationType): IntegrationTypeLabelKey {
    return `integrationType.${type}`;
}
