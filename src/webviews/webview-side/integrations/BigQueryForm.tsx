// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from 'react';
import { BigQueryIntegrationConfig } from './types';
import { l10n } from 'vscode';

export interface IBigQueryFormProps {
    integrationId: string;
    existingConfig: BigQueryIntegrationConfig | null;
    onSave: (config: BigQueryIntegrationConfig) => void;
    onCancel: () => void;
}

export const BigQueryForm: React.FC<IBigQueryFormProps> = ({ integrationId, existingConfig, onSave, onCancel }) => {
    const [name, setName] = React.useState(existingConfig?.name || '');
    const [projectId, setProjectId] = React.useState(existingConfig?.projectId || '');
    const [credentials, setCredentials] = React.useState(existingConfig?.credentials || '');

    // Update form fields when existingConfig changes
    React.useEffect(() => {
        if (existingConfig) {
            setName(existingConfig.name || '');
            setProjectId(existingConfig.projectId || '');
            setCredentials(existingConfig.credentials || '');
        }
    }, [existingConfig]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const config: BigQueryIntegrationConfig = {
            id: integrationId,
            name: name || integrationId,
            type: 'bigquery',
            projectId,
            credentials
        };

        onSave(config);
    };

    return (
        <form onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="name">{l10n.t('Name (optional)')}</label>
                <input
                    type="text"
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My BigQuery Project"
                    autoComplete="off"
                />
            </div>

            <div className="form-group">
                <label htmlFor="projectId">
                    {l10n.t('Project ID')} <span className="required">*</span>
                </label>
                <input
                    type="text"
                    id="projectId"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    placeholder="my-project-id"
                    autoComplete="off"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="credentials">
                    {l10n.t('Service Account Credentials (JSON)')} <span className="required">*</span>
                </label>
                <textarea
                    id="credentials"
                    value={credentials}
                    onChange={(e) => setCredentials(e.target.value)}
                    placeholder='{"type": "service_account", ...}'
                    rows={10}
                    autoComplete="off"
                    spellCheck={false}
                    required
                />
            </div>

            <div className="form-actions">
                <button type="submit" className="primary">
                    {l10n.t('Save')}
                </button>
                <button type="button" className="secondary" onClick={onCancel}>
                    {l10n.t('Cancel')}
                </button>
            </div>
        </form>
    );
};
