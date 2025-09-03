// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { NotebookEditor } from './components/NotebookEditor';
import { CustomNotebookData } from '../../extension-side/customNotebook/types';

// Get initial notebook data from the window
const initialData = (window as any).initialNotebookData as CustomNotebookData;

const App: React.FC = () => {
    return <NotebookEditor initialData={initialData} />;
};

// Render the app
ReactDOM.render(<App />, document.getElementById('root'));