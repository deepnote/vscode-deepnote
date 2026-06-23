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
     * Returns any cached project entry for the project id (project-level read-only callers).
     * Because sibling files share a `project.id`, this may return any one sibling's cached
     * project — never use it on a save path.
     */
    getAnyProjectEntry(projectId: string): DeepnoteProject | undefined;
    getCurrentNotebookId(projectId: string): string | undefined;
    /**
     * Returns the cached project for an exact (projectId, notebookId) pair, or undefined.
     * Exact match only — never falls back to another sibling. The save path uses this.
     */
    getOriginalProject(projectId: string, notebookId: string): DeepnoteProject | undefined;
    getTheSelectedNotebookForAProject(projectId: string): string | undefined;
    selectNotebookForProject(projectId: string, notebookId: string): void;
    storeOriginalProject(projectId: string, notebookId: string, project: DeepnoteProject): void;
    updateCurrentNotebookId(projectId: string, notebookId: string): void;
    /**
     * Updates the cached project for an exact (projectId, notebookId) pair, without changing
     * the project's current-notebook bookkeeping.
     */
    updateOriginalProject(projectId: string, notebookId: string, project: DeepnoteProject): void;

    /**
     * Updates the integrations list in the cached project data (cache-only).
     * Iterates every cached notebook entry under the project and updates each.
     *
     * @param projectId - Project identifier
     * @param integrations - Array of integration metadata to store in the project
     * @returns `true` if at least one cached entry was found and updated, `false` otherwise
     */
    updateProjectIntegrations(projectId: string, integrations: ProjectIntegration[]): boolean;

    hasInitNotebookBeenRun(projectId: string): boolean;
    markInitNotebookAsRun(projectId: string): void;
}
