// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { NotebookDocument, NotebookEditor, Uri, type Event } from 'vscode';
import { Resource } from '../platform/common/types';
import type { EnvironmentPath } from '@vscode/python-extension';
import { DeepnoteProject } from './deepnote/deepnoteTypes';

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

/**
 * Represents a Deepnote project integration with basic metadata.
 */
export interface ProjectIntegration {
    id: string;
    name: string;
    type: string;
}

export const IDeepnoteNotebookManager = Symbol('IDeepnoteNotebookManager');
export interface IDeepnoteNotebookManager {
    getCurrentNotebookId(projectId: string): string | undefined;
    getOriginalProject(projectId: string): DeepnoteProject | undefined;
    getTheSelectedNotebookForAProject(projectId: string): string | undefined;
    selectNotebookForProject(projectId: string, notebookId: string): void;
    storeOriginalProject(projectId: string, project: DeepnoteProject, notebookId: string): void;
    updateCurrentNotebookId(projectId: string, notebookId: string): void;

    /**
     * Updates the integrations list in the project data.
     * This modifies the stored project to reflect changes in configured integrations.
     *
     * @param projectId - Project identifier
     * @param integrations - Array of integration metadata to store in the project
     * @returns `true` if the project was found and updated successfully, `false` if the project does not exist
     */
    updateProjectIntegrations(projectId: string, integrations: ProjectIntegration[]): boolean;

    hasInitNotebookBeenRun(projectId: string): boolean;
    markInitNotebookAsRun(projectId: string): void;
}
