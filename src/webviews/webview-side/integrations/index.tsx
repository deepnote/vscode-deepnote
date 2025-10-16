// eslint-disable-next-line import/order
import '../common/index.css';

import * as React from 'react';
import * as ReactDOM from 'react-dom';

import { IVsCodeApi } from '../react-common/postOffice';
import { detectBaseTheme } from '../react-common/themeDetector';
import { IntegrationPanel } from './IntegrationPanel';

// This special function talks to vscode from a web panel
export declare function acquireVsCodeApi(): IVsCodeApi;

const baseTheme = detectBaseTheme();
const vscodeApi = acquireVsCodeApi();

/* eslint-disable  */
ReactDOM.render(
    <IntegrationPanel baseTheme={baseTheme} vscodeApi={vscodeApi} />,
    document.getElementById('root') as HTMLElement
);

