// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { NotebookDocument, NotebookEditor, Uri, type Event } from 'vscode';
import { Resource } from '../platform/common/types';
import type { EnvironmentPath } from '@vscode/python-extension';
import { DeepnoteProject } from '../platform/deepnote/deepnoteTypes';
import { ConfigurableDatabaseIntegrationType } from '../platform/notebooks/deepnote/integrationTypes';

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
    type: ConfigurableDatabaseIntegrationType;
}

export const IDeepnoteNotebookManager = Symbol('IDeepnoteNotebookManager');
export interface IDeepnoteNotebookManager {
    /**
     * Returns the cached project for an exact (projectId, notebookId) pair, or undefined.
     * Exact match only — never falls back to another sibling. The save path uses this.
     */
    getProjectForNotebook(projectId: string, notebookId: string): DeepnoteProject | undefined;
    storeOriginalProject(projectId: string, notebookId: string, project: DeepnoteProject): void;

    /**
     * Updates the integrations list in the cached project data (cache-only).
     * Iterates every cached notebook entry under the project and updates each.
     *
     * @param projectId - Project identifier
     * @param integrations - Array of integration metadata to store in the project
     * @returns `true` if at least one cached entry was found and updated, `false` otherwise
     */
    updateProjectIntegrations(projectId: string, integrations: ProjectIntegration[]): boolean;
}
