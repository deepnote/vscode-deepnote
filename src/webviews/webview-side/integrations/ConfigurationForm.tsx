import * as React from 'react';
import { PostgresForm } from './PostgresForm';
import { BigQueryForm } from './BigQueryForm';
import { IntegrationConfig } from './types';

export interface IConfigurationFormProps {
    integrationId: string;
    existingConfig: IntegrationConfig | null;
    onSave: (config: IntegrationConfig) => void;
    onCancel: () => void;
}

export const ConfigurationForm: React.FC<IConfigurationFormProps> = ({
    integrationId,
    existingConfig,
    onSave,
    onCancel
}) => {
    // Determine integration type from ID or existing config
    const getIntegrationType = (): 'postgres' | 'bigquery' => {
        if (existingConfig) {
            return existingConfig.type;
        }
        // Infer from integration ID
        if (integrationId.includes('postgres')) {
            return 'postgres';
        }
        if (integrationId.includes('bigquery')) {
            return 'bigquery';
        }
        // Default to postgres
        return 'postgres';
    };

    const integrationType = getIntegrationType();

    return (
        <div className="configuration-form-overlay">
            <div className="configuration-form-container">
                <div className="configuration-form-header">
                    <h2>Configure Integration: {integrationId}</h2>
                    <button className="close-button" onClick={onCancel}>
                        ×
                    </button>
                </div>

                <div className="configuration-form-body">
                    {integrationType === 'postgres' ? (
                        <PostgresForm
                            integrationId={integrationId}
                            existingConfig={
                                existingConfig?.type === 'postgres' ? existingConfig : null
                            }
                            onSave={onSave}
                            onCancel={onCancel}
                        />
                    ) : (
                        <BigQueryForm
                            integrationId={integrationId}
                            existingConfig={
                                existingConfig?.type === 'bigquery' ? existingConfig : null
                            }
                            onSave={onSave}
                            onCancel={onCancel}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};

