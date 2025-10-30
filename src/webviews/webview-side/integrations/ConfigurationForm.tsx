import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { PostgresForm } from './PostgresForm';
import { BigQueryForm } from './BigQueryForm';
import { SnowflakeForm } from './SnowflakeForm';
import { IntegrationConfig, IntegrationType } from './types';

export interface IConfigurationFormProps {
    integrationId: string;
    existingConfig: IntegrationConfig | null;
    integrationName?: string;
    integrationType?: IntegrationType;
    onSave: (config: IntegrationConfig) => void;
    onCancel: () => void;
}

export const ConfigurationForm: React.FC<IConfigurationFormProps> = ({
    integrationId,
    existingConfig,
    integrationName,
    integrationType,
    onSave,
    onCancel
}) => {
    // Determine integration type from existing config, integration metadata from project, or ID
    const getIntegrationType = (): 'postgres' | 'bigquery' | 'snowflake' => {
        if (existingConfig) {
            return existingConfig.type;
        }
        // Use integration type from project if available
        if (integrationType) {
            return integrationType;
        }
        // Infer from integration ID
        if (integrationId.includes('postgres')) {
            return 'postgres';
        }
        if (integrationId.includes('bigquery')) {
            return 'bigquery';
        }
        if (integrationId.includes('snowflake')) {
            return 'snowflake';
        }
        // Default to postgres
        return 'postgres';
    };

    const selectedIntegrationType = getIntegrationType();

    const title = getLocString('integrationsConfigureTitle', 'Configure Integration: {0}').replace(
        '{0}',
        integrationId
    );

    return (
        <div className="configuration-form-overlay">
            <div className="configuration-form-container">
                <div className="configuration-form-header">
                    <h2>{title}</h2>
                    <button type="button" className="close-button" onClick={onCancel}>
                        ×
                    </button>
                </div>

                <div className="configuration-form-body">
                    {selectedIntegrationType === 'postgres' ? (
                        <PostgresForm
                            integrationId={integrationId}
                            existingConfig={existingConfig?.type === 'postgres' ? existingConfig : null}
                            integrationName={integrationName}
                            onSave={onSave}
                            onCancel={onCancel}
                        />
                    ) : selectedIntegrationType === 'bigquery' ? (
                        <BigQueryForm
                            integrationId={integrationId}
                            existingConfig={existingConfig?.type === 'bigquery' ? existingConfig : null}
                            integrationName={integrationName}
                            onSave={onSave}
                            onCancel={onCancel}
                        />
                    ) : (
                        <SnowflakeForm
                            integrationId={integrationId}
                            existingConfig={existingConfig?.type === 'snowflake' ? existingConfig : null}
                            integrationName={integrationName}
                            onSave={onSave}
                            onCancel={onCancel}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};
