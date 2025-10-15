// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from 'react';
import { BigQueryIntegrationConfig } from './types';

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
                <label htmlFor="name">Name (optional)</label>
                <input
                    type="text"
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My BigQuery Project"
                />
            </div>

            <div className="form-group">
                <label htmlFor="projectId">
                    Project ID <span className="required">*</span>
                </label>
                <input
                    type="text"
                    id="projectId"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    placeholder="my-project-id"
                    required
                />
            </div>

            <div className="form-group">
                <label htmlFor="credentials">
                    Service Account Credentials (JSON) <span className="required">*</span>
                </label>
                <textarea
                    id="credentials"
                    value={credentials}
                    onChange={(e) => setCredentials(e.target.value)}
                    placeholder='{"type": "service_account", ...}'
                    rows={10}
                    required
                />
            </div>

            <div className="form-actions">
                <button type="submit" className="primary">
                    Save
                </button>
                <button type="button" className="secondary" onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </form>
    );
};

