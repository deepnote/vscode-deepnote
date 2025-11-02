import * as React from 'react';
import { getLocString } from '../react-common/locReactSide';

export interface ICaCertificateFieldsProps {
    sslEnabled?: boolean;
    caCertificateName?: string;
    caCertificateText?: string;
    onSslEnabledChange?: (enabled: boolean) => void;
    onCaCertificateNameChange: (name: string) => void;
    onCaCertificateTextChange?: (text: string) => void;
    /** Whether to show the SSL enabled checkbox (default: true) */
    showSslEnabled?: boolean;
    /** Whether to show the certificate text field (default: true) */
    showCertificateText?: boolean;
}

export const CaCertificateFields: React.FC<ICaCertificateFieldsProps> = ({
    sslEnabled,
    caCertificateName,
    caCertificateText,
    onSslEnabledChange,
    onCaCertificateNameChange,
    onCaCertificateTextChange,
    showSslEnabled = true,
    showCertificateText = true
}) => {
    return (
        <>
            {showSslEnabled && onSslEnabledChange && (
                <div className="form-group">
                    <label>
                        <input
                            type="checkbox"
                            checked={sslEnabled || false}
                            onChange={(e) => onSslEnabledChange(e.target.checked)}
                        />{' '}
                        {getLocString('integrationsSslEnabled', 'Enable SSL')}
                    </label>
                </div>
            )}

            {(!showSslEnabled || sslEnabled) && (
                <>
                    <div className="form-group">
                        <label htmlFor="caCertificateName">
                            {getLocString('integrationsCaCertificateName', 'CA Certificate Name')}
                        </label>
                        <input
                            type="text"
                            id="caCertificateName"
                            value={caCertificateName || ''}
                            onChange={(e) => onCaCertificateNameChange(e.target.value)}
                            placeholder={getLocString('integrationsCaCertificateNamePlaceholder', 'my-ca-certificate')}
                            autoComplete="off"
                        />
                    </div>

                    {showCertificateText && onCaCertificateTextChange && (
                        <div className="form-group">
                            <label htmlFor="caCertificateText">
                                {getLocString('integrationsCaCertificateText', 'CA Certificate (PEM)')}
                            </label>
                            <textarea
                                id="caCertificateText"
                                value={caCertificateText || ''}
                                onChange={(e) => onCaCertificateTextChange(e.target.value)}
                                placeholder={getLocString(
                                    'integrationsCaCertificateTextPlaceholder',
                                    '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'
                                )}
                                rows={6}
                                autoComplete="off"
                            />
                        </div>
                    )}
                </>
            )}
        </>
    );
};
