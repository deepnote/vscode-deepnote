import * as React from 'react';
import { IVsCodeApi } from '../react-common/postOffice';
import { getLocString, storeLocStrings } from '../react-common/locReactSide';
import { BigNumberComparisonSettings, WebviewMessage } from './types';

export interface IBigNumberComparisonSettingsPanelProps {
    baseTheme: string;
    vscodeApi: IVsCodeApi;
}

export const BigNumberComparisonSettingsPanel: React.FC<IBigNumberComparisonSettingsPanelProps> = ({
    baseTheme,
    vscodeApi
}) => {
    const [settings, setSettings] = React.useState<BigNumberComparisonSettings>({
        enabled: false,
        comparisonType: '',
        comparisonValue: '',
        comparisonTitle: '',
        comparisonFormat: ''
    });

    React.useEffect(() => {
        const handleMessage = (event: MessageEvent<WebviewMessage>) => {
            const message = event.data;

            switch (message.type) {
                case 'init':
                    setSettings(message.settings);
                    break;

                case 'locInit':
                    storeLocStrings(message.locStrings);
                    break;

                case 'save':
                case 'cancel':
                    // These messages are sent from webview to extension, not handled here
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const handleToggleEnabled = () => {
        setSettings((prev) => ({
            ...prev,
            enabled: !prev.enabled
        }));
    };

    const handleComparisonTypeChange = (comparisonType: 'percentage-change' | 'absolute-value') => {
        setSettings((prev) => ({
            ...prev,
            comparisonType
        }));
    };

    const handleComparisonValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setSettings((prev) => ({
            ...prev,
            comparisonValue: e.target.value
        }));
    };

    const handleComparisonTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setSettings((prev) => ({
            ...prev,
            comparisonTitle: e.target.value
        }));
    };

    const handleComparisonFormatChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setSettings((prev) => ({
            ...prev,
            comparisonFormat: e.target.value
        }));
    };

    const handleSave = () => {
        vscodeApi.postMessage({
            type: 'save',
            settings
        });
    };

    const handleCancel = () => {
        vscodeApi.postMessage({
            type: 'cancel'
        });
    };

    return (
        <div className={`big-number-comparison-settings-panel theme-${baseTheme}`}>
            <h1>{getLocString('bigNumberComparisonTitle', 'Big Number Comparison Settings')}</h1>

            <div className="settings-section">
                <div className="toggle-option">
                    <label htmlFor="enableComparison">{getLocString('enableComparison', 'Enable comparison')}</label>
                    <label className="toggle-switch">
                        <input
                            type="checkbox"
                            id="enableComparison"
                            checked={settings.enabled}
                            onChange={handleToggleEnabled}
                        />
                        <span className="toggle-slider"></span>
                    </label>
                </div>
            </div>

            {settings.enabled && (
                <>
                    <div className="form-section">
                        <label htmlFor="comparisonType">{getLocString('comparisonTypeLabel', 'Comparison type')}</label>
                        <div className="radio-group">
                            <label className="radio-option-inline">
                                <input
                                    type="radio"
                                    name="comparisonType"
                                    value="percentage-change"
                                    checked={settings.comparisonType === 'percentage-change'}
                                    onChange={() => handleComparisonTypeChange('percentage-change')}
                                />
                                <span>{getLocString('percentageChange', 'Percentage change')}</span>
                            </label>
                            <label className="radio-option-inline">
                                <input
                                    type="radio"
                                    name="comparisonType"
                                    value="absolute-value"
                                    checked={settings.comparisonType === 'absolute-value'}
                                    onChange={() => handleComparisonTypeChange('absolute-value')}
                                />
                                <span>{getLocString('absoluteValue', 'Absolute value')}</span>
                            </label>
                        </div>
                    </div>

                    <div className="form-section">
                        <label htmlFor="comparisonValue">
                            {getLocString('comparisonValueLabel', 'Comparison value')}
                        </label>
                        <input
                            type="text"
                            id="comparisonValue"
                            value={settings.comparisonValue}
                            onChange={handleComparisonValueChange}
                            placeholder={getLocString('comparisonValuePlaceholder', 'e.g., last_month_revenue')}
                        />
                    </div>

                    <div className="form-section">
                        <label htmlFor="comparisonTitle">
                            {getLocString('comparisonTitleLabel', 'Comparison title (optional)')}
                        </label>
                        <input
                            type="text"
                            id="comparisonTitle"
                            value={settings.comparisonTitle}
                            onChange={handleComparisonTitleChange}
                            placeholder={getLocString('comparisonTitlePlaceholder', 'e.g., vs last month')}
                        />
                    </div>

                    <div className="form-section">
                        <label htmlFor="comparisonFormat">
                            {getLocString('comparisonFormatLabel', 'Comparison format (optional)')}
                        </label>
                        <select
                            id="comparisonFormat"
                            value={settings.comparisonFormat}
                            onChange={handleComparisonFormatChange}
                        >
                            <option value="">Same as main value</option>
                            <option value="number">Number</option>
                            <option value="currency">Currency</option>
                            <option value="percent">Percent</option>
                        </select>
                        <div className="help-text">
                            {getLocString(
                                'comparisonFormatHelp',
                                'Leave empty to use the same format as the main value'
                            )}
                        </div>
                    </div>
                </>
            )}

            <div className="actions">
                <button type="button" className="btn-primary" onClick={handleSave}>
                    {getLocString('saveButton', 'Save')}
                </button>
                <button type="button" className="btn-secondary" onClick={handleCancel}>
                    {getLocString('cancelButton', 'Cancel')}
                </button>
            </div>
        </div>
    );
};

