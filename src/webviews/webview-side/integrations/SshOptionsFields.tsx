import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';

export interface ISshOptionsFieldsProps {
    sshEnabled?: boolean;
    sshHost?: string;
    sshPort?: string;
    sshUser?: string;
    onSshEnabledChange: (enabled: boolean) => void;
    onSshHostChange: (host: string) => void;
    onSshPortChange: (port: string) => void;
    onSshUserChange: (user: string) => void;
}

export const SshOptionsFields: React.FC<ISshOptionsFieldsProps> = ({
    sshEnabled,
    sshHost,
    sshPort,
    sshUser,
    onSshEnabledChange,
    onSshHostChange,
    onSshPortChange,
    onSshUserChange
}) => {
    return (
        <>
            <div className="form-group">
                <label>
                    <input
                        type="checkbox"
                        checked={sshEnabled || false}
                        onChange={(e) => onSshEnabledChange(e.target.checked)}
                    />{' '}
                    {getLocString('integrationsSshEnabled', 'Enable SSH Tunnel')}
                </label>
            </div>

            {sshEnabled && (
                <>
                    <div className="form-group">
                        <label htmlFor="sshHost">
                            {getLocString('integrationsSshHost', 'SSH Host')}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <input
                            type="text"
                            id="sshHost"
                            value={sshHost || ''}
                            onChange={(e) => onSshHostChange(e.target.value)}
                            placeholder={getLocString('integrationsSshHostPlaceholder', 'ssh.example.com')}
                            autoComplete="off"
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="sshPort">{getLocString('integrationsSshPort', 'SSH Port')}</label>
                        <input
                            type="text"
                            id="sshPort"
                            value={sshPort || ''}
                            onChange={(e) => onSshPortChange(e.target.value)}
                            placeholder="22"
                            autoComplete="off"
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="sshUser">
                            {getLocString('integrationsSshUser', 'SSH User')}{' '}
                            <span className="required">{getLocString('integrationsRequiredField', '*')}</span>
                        </label>
                        <input
                            type="text"
                            id="sshUser"
                            value={sshUser || ''}
                            onChange={(e) => onSshUserChange(e.target.value)}
                            placeholder={getLocString('integrationsSshUserPlaceholder', 'ubuntu')}
                            autoComplete="off"
                            required
                        />
                    </div>
                </>
            )}
        </>
    );
};
