import * as React from 'react';
import { format, getLocString } from '../react-common/locReactSide';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

function createEmptyAthenaConfig(params: {
    id: string;
    name?: string;
}): Extract<DatabaseIntegrationConfig, { type: 'athena' }> {
    const unnamedIntegration = getLocString('integrationsUnnamedIntegration', 'Unnamed Integration ({0})');

    return {
        id: params.id,
        name: (params.name || format(unnamedIntegration, params.id)).trim(),
        type: 'athena',
        metadata: {
            access_key_id: '',
            secret_access_key: '',
            region: '',
            s3_output_path: '',
            workgroup: ''
        }
    };
}

export interface IAthenaFormProps {
    integrationId: string;
    existingConfig: Extract<DatabaseIntegrationConfig, { type: 'athena' }> | null;
    defaultName?: string;
    onSave: (config: Extract<DatabaseIntegrationConfig, { type: 'athena' }>) => void;
    onCancel: () => void;
}

export const AthenaForm: React.FC<IAthenaFormProps> = ({
    integrationId,
    existingConfig,
    defaultName,
    onSave,
    onCancel
}) => {
    const [pendingConfig, setPendingConfig] = React.useState<Extract<DatabaseIntegrationConfig, { type: 'athena' }>>(
        existingConfig
            ? structuredClone(existingConfig)
            : createEmptyAthenaConfig({ id: integrationId, name: defaultName })
    );

    React.useEffect(() => {
        setPendingConfig(
            existingConfig
                ? structuredClone(existingConfig)
                : createEmptyAthenaConfig({ id: integrationId, name: defaultName })
        );
    }, [existingConfig, integrationId, defaultName]);

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, name: e.target.value }));
    };

    const handleAccessKeyIdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, access_key_id: e.target.value } }));
    };

    const handleSecretAccessKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, secret_access_key: e.target.value } }));
    };

    const handleRegionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, region: e.target.value } }));
    };

    const handleS3OutputPathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, s3_output_path: e.target.value } }));
    };

    const handleWorkgroupChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPendingConfig((prev) => ({ ...prev, metadata: { ...prev.metadata, workgroup: e.target.value } }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(pendingConfig);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{getLocString('integrationsAthenaNameLabel', 'Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={pendingConfig.name}
                    onChange={handleNameChange}
                    placeholder={getLocString('integrationsAthenaNamePlaceholder', 'My Athena Database')}
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="access_key_id">
                    {getLocString('integrationsAthenaAccessKeyIdLabel', 'AWS Access Key ID')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="access_key_id"
                    value={pendingConfig.metadata.access_key_id}
                    onChange={handleAccessKeyIdChange}
                    placeholder={getLocString('integrationsAthenaAccessKeyIdPlaceholder', 'AKIAIOSFODNN7EXAMPLE')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="secret_access_key">
                    {getLocString('integrationsAthenaSecretAccessKeyLabel', 'AWS Secret Access Key')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="password"
                    id="secret_access_key"
                    value={pendingConfig.metadata.secret_access_key}
                    onChange={handleSecretAccessKeyChange}
                    placeholder={getLocString('integrationsAthenaSecretAccessKeyPlaceholder', '••••••••')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="region">
                    {getLocString('integrationsAthenaRegionLabel', 'AWS Region')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="region"
                    value={pendingConfig.metadata.region}
                    onChange={handleRegionChange}
                    placeholder={getLocString('integrationsAthenaRegionPlaceholder', 'us-east-1')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="s3_output_path">
                    {getLocString('integrationsAthenaS3OutputPathLabel', 'S3 Output Path')}{' '}
                    <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                </label>
                <input
                    type="text"
                    id="s3_output_path"
                    value={pendingConfig.metadata.s3_output_path}
                    onChange={handleS3OutputPathChange}
                    placeholder={getLocString('integrationsAthenaS3OutputPathPlaceholder', 's3://my-bucket/path/')}
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="workgroup">{getLocString('integrationsAthenaWorkgroupLabel', 'Workgroup (optional)')}</label>
                <input
                    type="text"
                    id="workgroup"
                    value={pendingConfig.metadata.workgroup || ''}
                    onChange={handleWorkgroupChange}
                    placeholder={getLocString('integrationsAthenaWorkgroupPlaceholder', 'primary')}
                    autoComplete="off"
                />
            </div>

            <div className="form-actions">
                <button type="submit" className="primary">
                    {getLocString('integrationsSave', 'Save')}
                </button>
                <button type="button" className="secondary" onClick={onCancel}>
                    {getLocString('integrationsCancel', 'Cancel')}
                </button>
            </div>
        </form>
    );
};

