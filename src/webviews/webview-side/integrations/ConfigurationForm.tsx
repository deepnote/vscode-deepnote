import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { AlloyDBForm } from './AlloyDBForm';
import { AthenaForm } from './AthenaForm';
import { BigQueryForm } from './BigQueryForm';
import { ClickHouseForm } from './ClickHouseForm';
import { CloudSQLForm } from './CloudSQLForm';
import { DatabricksForm } from './DatabricksForm';
import { DremioForm } from './DremioForm';
import { MariaDBForm } from './MariaDBForm';
import { MaterializeForm } from './MaterializeForm';
import { MindsDBForm } from './MindsDBForm';
import { MongoDBForm } from './MongoDBForm';
import { MySQLForm } from './MySQLForm';
import { PostgresForm } from './PostgresForm';
import { RedshiftForm } from './RedshiftForm';
import { SnowflakeForm } from './SnowflakeForm';
import { SpannerForm } from './SpannerForm';
import { SQLServerForm } from './SQLServerForm';
import { isTrinoPasswordConfig, TrinoForm } from './TrinoForm';
import { ConfigurableDatabaseIntegrationConfig, ConfigurableDatabaseIntegrationType } from './types';
import { integrationTypeLabels } from './integrationUtils';

export interface IConfigurationFormProps {
    integrationId: string;
    existingConfig: ConfigurableDatabaseIntegrationConfig | null;
    defaultName?: string;
    integrationType: ConfigurableDatabaseIntegrationType;
    onSave: (config: ConfigurableDatabaseIntegrationConfig) => void;
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
    const typeLabel = integrationTypeLabels[integrationType] || integrationType;
    const title = getLocString('integrationsConfigureTitle', '{0} integration').replace('{0}', typeLabel);

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
                            case 'mysql':
                                return (
                                    <MySQLForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'mysql' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'mariadb':
                                return (
                                    <MariaDBForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'mariadb' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'alloydb':
                                return (
                                    <AlloyDBForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'alloydb' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'cloud-sql':
                                return (
                                    <CloudSQLForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'cloud-sql' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'clickhouse':
                                return (
                                    <ClickHouseForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'clickhouse' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'materialize':
                                return (
                                    <MaterializeForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'materialize' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'mindsdb':
                                return (
                                    <MindsDBForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'mindsdb' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'sql-server':
                                return (
                                    <SQLServerForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'sql-server' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'trino':
                                return (
                                    <TrinoForm
                                        integrationId={integrationId}
                                        existingConfig={
                                            existingConfig?.type === 'trino' && isTrinoPasswordConfig(existingConfig)
                                                ? existingConfig
                                                : null
                                        }
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'athena':
                                return (
                                    <AthenaForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'athena' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'databricks':
                                return (
                                    <DatabricksForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'databricks' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'dremio':
                                return (
                                    <DremioForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'dremio' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'mongodb':
                                return (
                                    <MongoDBForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'mongodb' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'redshift':
                                return (
                                    <RedshiftForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'redshift' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            case 'spanner':
                                return (
                                    <SpannerForm
                                        integrationId={integrationId}
                                        existingConfig={existingConfig?.type === 'spanner' ? existingConfig : null}
                                        defaultName={defaultName}
                                        onSave={onSave}
                                        onCancel={onCancel}
                                    />
                                );
                            default: {
                                const unsupportedMessage = getLocString(
                                    'integrationsUnsupportedIntegrationType',
                                    'Unsupported integration type: {0}'
                                );
                                return <div>{format(unsupportedMessage, integrationType)}</div>;
                            }
                        }
                    })()}
                </div>
            </div>
        </div>
    );
};
