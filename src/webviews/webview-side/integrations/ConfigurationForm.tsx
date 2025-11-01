import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';
import { PostgresForm } from './PostgresForm';
import { BigQueryForm } from './BigQueryForm';
import { SnowflakeForm } from './SnowflakeForm';
import { DatabaseIntegrationConfig, DatabaseIntegrationType } from '@deepnote/database-integrations';

export interface IConfigurationFormProps {
    integrationId: string;
    existingConfig: DatabaseIntegrationConfig | null;
    defaultName?: string;
    integrationType: DatabaseIntegrationType;
    onSave: (config: DatabaseIntegrationConfig) => void;
    onCancel: () => void;
}

export const ConfigurationForm: React.FC<IConfigurationFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    integrationType,
    onSave,
    onCancel
}) => {
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
                    {(() => {
                        switch (integrationType) {
                            case 'pgsql':
                                return (
                                    <PostgresForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'pgsql' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'big-query':
                                return (
                                    <BigQueryForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'big-query' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'snowflake':
                                return (
                                    <SnowflakeForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'snowflake' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            default:
                                return <div>Unsupported integration type: {integrationType}</div>;
                        }
                    })()}
                </div>
            </div>
        </div>
    );
};
