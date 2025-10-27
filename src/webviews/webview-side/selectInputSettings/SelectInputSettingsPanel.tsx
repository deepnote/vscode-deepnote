// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from 'react';
import { IVsCodeApi } from '../react-common/postOffice';
import { getLocString, storeLocStrings } from '../react-common/locReactSide';
import { SelectInputSettings, WebviewMessage } from './types';

export interface ISelectInputSettingsPanelProps {
    baseTheme: string;
    vscodeApi: IVsCodeApi;
}

export const SelectInputSettingsPanel: React.FC<ISelectInputSettingsPanelProps> = ({ baseTheme, vscodeApi }) => {
    const [settings, setSettings] = React.useState<SelectInputSettings>({
        allowMultipleValues: false,
        allowEmptyValue: false,
        selectType: 'from-options',
        options: [],
        selectedVariable: ''
    });

    const [newOption, setNewOption] = React.useState('');

    React.useEffect(() => {
        const handleMessage = (event: MessageEvent<WebviewMessage>) => {
            const message = event.data;

            switch (message.type) {
                case 'init':
                    if (message.settings) {
                        setSettings(message.settings);
                    }
                    break;

                case 'locInit':
                    if (message.locStrings) {
                        storeLocStrings(message.locStrings);
                    }
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const handleToggle = (field: 'allowMultipleValues' | 'allowEmptyValue') => {
        setSettings((prev) => ({
            ...prev,
            [field]: !prev[field]
        }));
    };

    const handleSelectTypeChange = (selectType: 'from-options' | 'from-variable') => {
        setSettings((prev) => ({
            ...prev,
            selectType
        }));
    };

    const handleAddOption = () => {
        const trimmedValue = newOption.trim();

        // Check if the trimmed value is non-empty
        if (!trimmedValue) {
            return;
        }

        // Normalize for comparison (case-insensitive)
        const normalizedValue = trimmedValue.toLowerCase();

        // Check if the normalized value is already present in options
        const isDuplicate = settings.options.some((option) => option.toLowerCase() === normalizedValue);

        if (isDuplicate) {
            return;
        }

        // Add the trimmed value and clear input
        setSettings((prev) => ({
            ...prev,
            options: [...prev.options, trimmedValue]
        }));
        setNewOption('');
    };

    const handleRemoveOption = (index: number) => {
        setSettings((prev) => ({
            ...prev,
            options: prev.options.filter((_, i) => i !== index)
        }));
    };

    const handleVariableChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setSettings((prev) => ({
            ...prev,
            selectedVariable: e.target.value
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
        <div className={`select-input-settings-panel theme-${baseTheme}`}>
            <h1>{getLocString('selectInputSettingsTitle', 'Settings')}</h1>

            <div className="settings-section">
                <div className="toggle-option">
                    <label htmlFor="allowMultiple">
                        {getLocString('allowMultipleValues', 'Allow to select multiple values')}
                    </label>
                    <label className="toggle-switch">
                        <input
                            type="checkbox"
                            id="allowMultiple"
                            checked={settings.allowMultipleValues}
                            onChange={() => handleToggle('allowMultipleValues')}
                        />
                        <span className="toggle-slider"></span>
                    </label>
                </div>

                <div className="toggle-option">
                    <label htmlFor="allowEmpty">{getLocString('allowEmptyValue', 'Allow empty value')}</label>
                    <label className="toggle-switch">
                        <input
                            type="checkbox"
                            id="allowEmpty"
                            checked={settings.allowEmptyValue}
                            onChange={() => handleToggle('allowEmptyValue')}
                        />
                        <span className="toggle-slider"></span>
                    </label>
                </div>
            </div>

            <h2>{getLocString('valueSourceTitle', 'Value')}</h2>

            <div className="value-source-section">
                <label className={`radio-option ${settings.selectType === 'from-options' ? 'selected' : ''}`}>
                    <input
                        type="radio"
                        id="fromOptions"
                        name="selectType"
                        checked={settings.selectType === 'from-options'}
                        onChange={() => handleSelectTypeChange('from-options')}
                    />
                    <div className="radio-content">
                        <div className="radio-title">{getLocString('fromOptions', 'From options')}</div>
                        <div className="radio-description">
                            {getLocString('fromOptionsDescription', 'A set of defined options.')}
                        </div>

                        {settings.selectType === 'from-options' && (
                            <div className="options-list">
                                {settings.options.map((option, index) => (
                                    <span key={index} className="option-tag">
                                        {option}
                                        <button
                                            type="button"
                                            onClick={() => handleRemoveOption(index)}
                                            aria-label="Remove option"
                                        >
                                            ×
                                        </button>
                                    </span>
                                ))}

                                <div className="add-option-form">
                                    <label htmlFor="addOptionInput" className="visually-hidden">
                                        Option name
                                    </label>
                                    <input
                                        type="text"
                                        id="addOptionInput"
                                        value={newOption}
                                        onChange={(e) => setNewOption(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                handleAddOption();
                                            }
                                        }}
                                        placeholder={getLocString('addOptionPlaceholder', 'Add option...')}
                                        aria-label="Option name"
                                    />
                                    <button type="button" onClick={handleAddOption}>
                                        {getLocString('addButton', 'Add')}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </label>

                <label className={`radio-option ${settings.selectType === 'from-variable' ? 'selected' : ''}`}>
                    <input
                        type="radio"
                        id="fromVariable"
                        name="selectType"
                        checked={settings.selectType === 'from-variable'}
                        onChange={() => handleSelectTypeChange('from-variable')}
                    />
                    <div className="radio-content">
                        <div className="radio-title">{getLocString('fromVariable', 'From variable')}</div>
                        <div className="radio-description">
                            {getLocString(
                                'fromVariableDescription',
                                'A list or Series that contains only strings, numbers or booleans.'
                            )}
                        </div>

                        {settings.selectType === 'from-variable' && (
                            <>
                                <label htmlFor="variableNameInput" className="visually-hidden">
                                    Variable name
                                </label>
                                <input
                                    type="text"
                                    id="variableNameInput"
                                    className="variable-input"
                                    value={settings.selectedVariable}
                                    onChange={handleVariableChange}
                                    placeholder={getLocString('variablePlaceholder', 'Variable name...')}
                                    aria-label="Variable name"
                                />
                            </>
                        )}
                    </div>
                </label>
            </div>

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
