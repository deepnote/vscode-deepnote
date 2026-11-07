/**
 * A minimal Deepnote Cloud: the Public API v2 routes that "Deepnote: Set API Token", `syncWorkspace` and
 * `publishApp` call, backed by a directory with one subdirectory per project, named by its id and holding its
 * `.deepnote` files. The project's working files, such as a published app under `_deepnote_static/`, live below
 * its `files/` subdirectory. Editing those files is how a test, or a person, changes a project "in Deepnote".
 * Static-file sharing settings are kept in memory. Any Bearer token is accepted.
 */

import { deserializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { isSafeRelativeFilePath, sha256 } from '@deepnote/cloud-sync';
import express, { type Response } from 'express';
import { unzipSync, zipSync } from 'fflate';
import { once } from 'events';
import * as fs from 'fs';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

import type { components, operations } from './deepnoteCloudApi.generated';

type Schemas = components['schemas'];
type UpdateProjectBody = operations['updateProject']['requestBody']['content']['application/json'];

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTEBOOK_FILE = /^[^/\\]+\.deepnote$/;
const MAX_ARCHIVE_SIZE = '100mb';
const MAX_FILE_SIZE = '100mb';
const FILES_DIR = 'files';

export const MOCK_WORKSPACE_NAME = 'Mock Workspace';

export interface MockDeepnoteCloud {
    /** Holds one directory per project, named by its id. */
    readonly rootDir: string;
    /** The value for the `deepnote.apiUrl` setting. */
    readonly url: string;
    stop(): Promise<void>;
}

interface NotebookFile {
    content: Buffer;
    filename: string;
}

async function readNotebookFiles(projectDir: string): Promise<NotebookFile[]> {
    const filenames = (await fs.promises.readdir(projectDir)).filter((name) => NOTEBOOK_FILE.test(name)).sort();

    return Promise.all(
        filenames.map(async (filename) => ({
            content: await fs.promises.readFile(path.join(projectDir, filename)),
            filename
        }))
    );
}

/**
 * `@deepnote/cloud-sync`'s unexported `canonicalProjectHash`, so an import answers with the hash the next
 * export has.
 */
function contentHash(files: NotebookFile[]): string {
    return sha256(
        files
            .map(({ content, filename }) => `${filename}\n${sha256(content)}`)
            .sort()
            .join('\n')
    );
}

/** The import rules that the `importProject` description in `deepnoteCloudApi.generated` states. */
function findImportViolation(projectId: string, projects: DeepnoteFile['project'][]): string | undefined {
    if (projects.some(({ id }) => id !== projectId)) {
        return 'A document belongs to another project';
    }
    if (projects.some(({ notebooks }) => notebooks.length !== 1)) {
        return 'A document must contain exactly one notebook';
    }
    if (new Set(projects.map(({ name }) => name)).size > 1) {
        return 'The documents disagree on the project name';
    }

    // A document without `integrations` leaves the project's integrations as they are, so it cannot disagree.
    const integrationIdSets = projects.flatMap(({ integrations }) =>
        integrations ? [JSON.stringify([...new Set(integrations.map(({ id }) => id))].sort())] : []
    );
    if (new Set(integrationIdSets).size > 1) {
        return 'The documents disagree on the integrations';
    }

    return undefined;
}

/** `publishApp` detects cloud edits by comparing each entry's `size` and `updatedAt`. */
async function listProjectFiles(filesDir: string): Promise<Schemas['FileEntryFile'][]> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(filesDir, { recursive: true, withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }

    return Promise.all(
        entries
            .filter((entry) => entry.isFile())
            .map(async (entry): Promise<Schemas['FileEntryFile']> => {
                const absolute = path.join(entry.parentPath, entry.name);
                const { size, mtime } = await fs.promises.stat(absolute);

                return {
                    name: entry.name,
                    path: path.relative(filesDir, absolute).split(path.sep).join('/'),
                    type: 'file',
                    size,
                    updatedAt: mtime.toISOString()
                };
            })
    );
}

/** Like Deepnote, stores an upload to a taken path at a new unique path instead of overwriting it. */
function freeFilePath(filesDir: string, filePath: string): string {
    const extension = path.posix.extname(filePath);
    const stem = filePath.slice(0, filePath.length - extension.length);
    let candidate = filePath;
    for (let n = 1; fs.existsSync(path.join(filesDir, ...candidate.split('/'))); n++) {
        candidate = `${stem} (${n})${extension}`;
    }

    return candidate;
}

function sendError(res: Response, status: number, message: string): void {
    const body: Schemas['ErrorResponse'] = { message };
    res.status(status).json(body);
}

/** Starts the mock on a free port. Without `rootDir` it uses, and on `stop` removes, a new temp dir. */
export async function startMockDeepnoteCloud(rootDir?: string): Promise<MockDeepnoteCloud> {
    const root = rootDir ? path.resolve(rootDir) : await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepnote-cloud-'));
    await fs.promises.mkdir(root, { recursive: true });

    const projectDir = (projectId: string) => path.join(root, projectId);
    const filesDir = (projectId: string) => path.join(projectDir(projectId), FILES_DIR);
    const isKnownProject = (projectId: unknown): projectId is string =>
        typeof projectId === 'string' && PROJECT_ID.test(projectId) && fs.existsSync(projectDir(projectId));
    const projectName = async (projectId: string) => {
        const [first] = await readNotebookFiles(projectDir(projectId));

        return first ? deserializeDeepnoteFile(first.content.toString('utf8')).project.name : projectId;
    };

    let url = '';
    const staticFiles = new Map<string, Schemas['StaticFilesSettings']>();
    const staticFilesOf = (projectId: string): Schemas['StaticFilesSettings'] =>
        staticFiles.get(projectId) ?? {
            sharingEnabled: false,
            apiAccessEnabled: false,
            published: false,
            url: `${url}/apps/${projectId}/`
        };

    const app = express();

    app.use((req, res, next) =>
        req.headers.authorization?.startsWith('Bearer ') ? next() : sendError(res, 401, 'Missing API token')
    );

    app.param('projectId', (_req, res, next, projectId: string) =>
        isKnownProject(projectId) ? next() : sendError(res, 404, 'Project not found')
    );

    app.get('/v2/me', (_req, res) => {
        const body: Schemas['Me'] = {
            apiKey: {
                id: '3a9e5c1d-7f2b-4d6e-8c0a-1b4f6d8e2a5c',
                name: 'Mock API key',
                type: 'public-api',
                createdAt: '2026-01-01T00:00:00.000Z',
                lastUsedAt: null,
                expiresAt: null
            },
            user: { id: '0b3c6f1e-2d4a-4e8b-9c7d-5a1f3e2b8c4d', email: null, name: null },
            workspace: {
                id: '7e2d9a4c-1b5f-4c3e-8a6d-9f0b2c4e6a8d',
                name: MOCK_WORKSPACE_NAME,
                slug: 'mock-workspace'
            },
            accessLevel: 'admin'
        };

        res.json(body);
    });

    app.get('/v2/projects', async (_req, res) => {
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        const ids = entries
            .filter((entry) => entry.isDirectory() && PROJECT_ID.test(entry.name))
            .map(({ name }) => name);
        const projects = await Promise.all(
            ids.map(async (id): Promise<Schemas['ListProjectsItem']> => {
                const { birthtime, mtime } = await fs.promises.stat(projectDir(id));

                return {
                    id,
                    name: await projectName(id),
                    projectType: 'standard',
                    createdAt: birthtime.toISOString(),
                    updatedAt: mtime.toISOString(),
                    folder: null,
                    // Sync reads only the id, name and folder.
                    notebooks: []
                };
            })
        );
        const body: Schemas['ListProjectsResponse'] = {
            projects,
            pagination: { pageSize: projects.length, nextPageToken: null, hasMore: false }
        };

        res.json(body);
    });

    app.get('/v2/projects/:projectId', async (req, res) => {
        const { projectId } = req.params;
        const { birthtime, mtime } = await fs.promises.stat(projectDir(projectId));
        const body: Schemas['GetProjectResponse'] = {
            project: {
                id: projectId,
                name: await projectName(projectId),
                projectType: 'standard',
                createdAt: birthtime.toISOString(),
                updatedAt: mtime.toISOString(),
                folder: null,
                // publishApp reads only the files and the static-file settings.
                notebooks: [],
                integrations: [],
                files: await listProjectFiles(filesDir(projectId)),
                staticFiles: staticFilesOf(projectId),
                streamlitAppApiAccessEnabled: false,
                environment: null
            }
        };

        res.json(body);
    });

    app.patch('/v2/projects/:projectId', express.json(), async (req, res) => {
        const { projectId } = req.params;
        const update = (req.body as UpdateProjectBody | undefined)?.staticFiles;
        if (update?.sharingEnabled === undefined && update?.apiAccessEnabled === undefined) {
            return sendError(res, 400, 'At least one setting is required');
        }

        const current = staticFilesOf(projectId);
        const sharingEnabled = update.sharingEnabled ?? current.sharingEnabled;
        if (update.apiAccessEnabled === true && !sharingEnabled) {
            return sendError(res, 400, 'API access can be enabled only when sharing is enabled');
        }

        const settings: Schemas['StaticFilesSettings'] = {
            ...current,
            sharingEnabled,
            apiAccessEnabled: sharingEnabled && (update.apiAccessEnabled ?? current.apiAccessEnabled)
        };
        staticFiles.set(projectId, settings);

        const { birthtime, mtime } = await fs.promises.stat(projectDir(projectId));
        const body: Schemas['UpdateProjectResponse'] = {
            project: {
                id: projectId,
                name: await projectName(projectId),
                projectType: 'standard',
                createdAt: birthtime.toISOString(),
                updatedAt: mtime.toISOString(),
                staticFiles: settings,
                streamlitAppApiAccessEnabled: false,
                environment: null,
                folder: null
            }
        };

        res.json(body);
    });

    app.post('/v2/files', express.raw({ type: 'multipart/form-data', limit: MAX_FILE_SIZE }), async (req, res) => {
        let form: FormData;
        try {
            form = await new Request('http://mock.invalid/', {
                method: 'POST',
                headers: { 'content-type': req.headers['content-type'] ?? '' },
                body: new Uint8Array(req.body as Buffer)
            }).formData();
        } catch {
            return sendError(res, 400, 'The body is not a readable multipart form');
        }

        const projectId = form.get('projectId');
        const filePath = form.get('path');
        const file = form.get('file');
        if (typeof filePath !== 'string' || !(file instanceof Blob) || typeof projectId !== 'string') {
            return sendError(res, 400, 'projectId, path and file are required');
        }
        if (!isSafeRelativeFilePath(filePath)) {
            return sendError(res, 400, `Unsafe file path: ${filePath}`);
        }
        if (!isKnownProject(projectId)) {
            return sendError(res, 404, 'Project not found');
        }

        const storedPath = freeFilePath(filesDir(projectId), filePath);
        const absolute = path.join(filesDir(projectId), ...storedPath.split('/'));
        await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
        await fs.promises.writeFile(absolute, Buffer.from(await file.arrayBuffer()));
        const { size, mtime } = await fs.promises.stat(absolute);
        const body: Schemas['CreateFileResponse'] = {
            file: { projectId, path: storedPath, size, updatedAt: mtime.toISOString() }
        };

        res.status(201).json(body);
    });

    app.delete('/v2/files', async (req, res) => {
        const { projectId, path: filePath } = req.query;
        if (typeof filePath !== 'string' || !isSafeRelativeFilePath(filePath) || typeof projectId !== 'string') {
            return sendError(res, 400, 'projectId and a safe path are required');
        }
        if (!isKnownProject(projectId)) {
            return sendError(res, 404, 'Project not found');
        }

        try {
            await fs.promises.unlink(path.join(filesDir(projectId), ...filePath.split('/')));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return sendError(res, 404, 'File not found');
            }
            throw error;
        }

        res.status(204).end();
    });

    app.get('/v2/projects/:projectId/export', async (req, res) => {
        const files = await readNotebookFiles(projectDir(req.params.projectId));

        res.type('application/zip').send(
            Buffer.from(zipSync(Object.fromEntries(files.map(({ content, filename }) => [filename, content]))))
        );
    });

    // Ignores the lost-update checks (`baseModifiedAt`, `baseContentHash`, `force`): sync catches a change
    // on both sides before it imports, so only a cloud edit landing mid-sync would need them.
    app.post(
        '/v2/projects/:projectId/import',
        express.raw({ type: 'application/zip', limit: MAX_ARCHIVE_SIZE }),
        async (req, res) => {
            const dir = projectDir(req.params.projectId);
            let archive: Record<string, Uint8Array>;
            try {
                archive = unzipSync(new Uint8Array(req.body as Buffer));
            } catch {
                return sendError(res, 422, 'The archive is not a readable ZIP');
            }

            const entries = Object.entries(archive);
            if (!entries.every(([filename]) => NOTEBOOK_FILE.test(filename))) {
                return sendError(res, 422, 'The archive may contain only .deepnote files');
            }

            let documents: { content: Uint8Array; filename: string; project: DeepnoteFile['project'] }[];
            try {
                documents = entries.map(([filename, content]) => ({
                    content,
                    filename,
                    project: deserializeDeepnoteFile(Buffer.from(content).toString('utf8')).project
                }));
            } catch (error) {
                return sendError(res, 422, error instanceof Error ? error.message : String(error));
            }

            const violation = findImportViolation(
                req.params.projectId,
                documents.map(({ project }) => project)
            );
            if (violation) {
                return sendError(res, 422, violation);
            }

            const notebooks: Schemas['ImportProjectResponse']['notebooks'] = [];
            for (const document of documents) {
                const action = fs.existsSync(path.join(dir, document.filename))
                    ? ('overwritten' as const)
                    : ('created' as const);
                await fs.promises.writeFile(path.join(dir, document.filename), document.content);
                notebooks.push(...document.project.notebooks.map(({ id, name }) => ({ id, name, action })));
            }

            const body: Schemas['ImportProjectResponse'] = {
                project: {
                    id: req.params.projectId,
                    modifiedAt: new Date().toISOString(),
                    contentHash: contentHash(await readNotebookFiles(dir))
                },
                notebooks
            };

            res.json(body);
        }
    );

    app.use((error: unknown, _req: express.Request, res: Response, _next: express.NextFunction) =>
        sendError(res, 500, error instanceof Error ? error.message : String(error))
    );

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;

    return {
        rootDir: root,
        url,
        stop: async () => {
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
            if (!rootDir) {
                await fs.promises.rm(root, { recursive: true, force: true });
            }
        }
    };
}

if (require.main === module) {
    void startMockDeepnoteCloud(process.argv[2]).then(({ rootDir, url }) => {
        console.log(`Serving the Deepnote projects in ${rootDir}`);
        console.log(`Set deepnote.apiUrl to ${url}`);
    });
}
