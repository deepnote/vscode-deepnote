import * as React from 'react';
import * as ReactDOM from 'react-dom';

import { IVsCodeApi } from '../react-common/postOffice';
import { detectBaseTheme } from '../react-common/themeDetector';
import { BigNumberComparisonSettingsPanel } from './BigNumberComparisonSettingsPanel';

import '../common/index.css';
import './bigNumberComparisonSettings.css';

// This special function talks to vscode from a web panel
declare function acquireVsCodeApi(): IVsCodeApi;

const baseTheme = detectBaseTheme();
const vscodeApi = acquireVsCodeApi();

ReactDOM.render(
    <BigNumberComparisonSettingsPanel baseTheme={baseTheme} vscodeApi={vscodeApi} />,
    document.getElementById('root') as HTMLElement
);

