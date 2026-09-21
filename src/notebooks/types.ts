// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { NotebookDocument, NotebookEditor, Uri, type Event } from 'vscode';
import type { IKernel } from '../kernels/types';
import { Resource } from '../platform/common/types';
import type { EnvironmentPath } from '@vscode/python-extension';
import type { DeepnoteFile } from '@deepnote/blocks';
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

/**
 * An entry as recorded on disk: unlike `ProjectIntegration`, `type` is not narrowed to the known types, so it also
 * covers the internal `pandas-dataframe` integration and anything a newer Deepnote release writes.
 */
export type RawProjectIntegration = NonNullable<DeepnoteFile['project']['integrations']>[number];

export const IDeepnoteNotebookManager = Symbol('IDeepnoteNotebookManager');
export interface IDeepnoteNotebookManager {
    /**
     * Returns the cached project for an exact (projectId, notebookId) pair, or undefined.
     * Exact match only — never falls back to another sibling. The save path uses this.
     */
    getProjectForNotebook(projectId: string, notebookId: string): DeepnoteFile | undefined;
    storeOriginalProject(projectId: string, notebookId: string, project: DeepnoteFile): void;

    /**
     * Updates the integrations list in the cached project data (cache-only).
     * Iterates every cached notebook entry under the project and updates each.
     *
     * @param projectId - Project identifier
     * @param integrations - Array of integration metadata to store in the project
     * @returns `true` if at least one cached entry was found and updated, `false` otherwise
     */
    updateProjectIntegrations(projectId: string, integrations: RawProjectIntegration[]): boolean;
}

export const IDeepnoteInitNotebookRunner = Symbol('IDeepnoteInitNotebookRunner');
export interface IDeepnoteInitNotebookRunner {
    /**
     * Resolves once the init notebook run triggered by the latest start or restart of `kernel` has finished,
     * or immediately when none is in flight. The run is registered synchronously with the kernel's
     * start/restart events, so a listener of those same events can await it.
     */
    waitForInit(kernel: IKernel): Promise<void>;
}
