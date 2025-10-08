// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { NotebookDocument, NotebookEditor, Uri, type Event } from 'vscode';
import { Resource } from '../platform/common/types';
import type { EnvironmentPath } from '@vscode/python-extension';

export interface IEmbedNotebookEditorProvider {
    findNotebookEditor(resource: Resource): NotebookEditor | undefined;
    findAssociatedNotebookDocument(uri: Uri): NotebookDocument | undefined;
}

export const INotebookEditorProvider = Symbol('INotebookEditorProvider');
export interface INotebookEditorProvider {
    activeNotebookEditor: NotebookEditor | undefined;
    findNotebookEditor(resource: Resource): NotebookEditor | undefined;
    findAssociatedNotebookDocument(uri: Uri): NotebookDocument | undefined;
    registerEmbedNotebookProvider(provider: IEmbedNotebookEditorProvider): void;
}

export const INotebookPythonEnvironmentService = Symbol('INotebookPythonEnvironmentService');
export interface INotebookPythonEnvironmentService {
    onDidChangeEnvironment: Event<Uri>;
    getPythonEnvironment(uri: Uri): EnvironmentPath | undefined;
}

export const IDeepnoteNotebookManager = Symbol('IDeepnoteNotebookManager');
export interface IDeepnoteNotebookManager {
    getCurrentNotebookId(projectId: string): string | undefined;
    getOriginalProject(projectId: string): unknown | undefined;
    getTheSelectedNotebookForAProject(projectId: string): string | undefined;
    selectNotebookForProject(projectId: string, notebookId: string): void;
    storeOriginalProject(projectId: string, project: unknown, notebookId: string): void;
    updateCurrentNotebookId(projectId: string, notebookId: string): void;
    hasInitNotebookRun(projectId: string): boolean;
    markInitNotebookAsRun(projectId: string): void;
}
