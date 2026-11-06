/**
 * A minimal Deepnote Cloud: the Public API v2 routes that "Deepnote: Set API Token" and `syncWorkspace` call,
 * backed by a directory with one subdirectory per project, named by its id and holding its `.deepnote` files.
 * Editing those files is how a test, or a person, changes a project "in Deepnote". Any Bearer token is accepted.
 */

import { deserializeDeepnoteFile } from '@deepnote/blocks';
import { sha256 } from '@deepnote/cloud-sync';
import express, { type Response } from 'express';
import { unzipSync, zipSync } from 'fflate';
import { once } from 'events';
import * as fs from 'fs';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

import type { components } from './deepnoteCloudApi.generated';

type Schemas = components['schemas'];

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTEBOOK_FILE = /^[^/\\]+\.deepnote$/;
const MAX_ARCHIVE_SIZE = '100mb';

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

function sendError(res: Response, status: number, message: string): void {
    const body: Schemas['ErrorResponse'] = { message };
    res.status(status).json(body);
}

/** Starts the mock on a free port. Without `rootDir` it uses, and on `stop` removes, a new temp dir. */
export async function startMockDeepnoteCloud(rootDir?: string): Promise<MockDeepnoteCloud> {
    const root = rootDir ? path.resolve(rootDir) : await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepnote-cloud-'));
    await fs.promises.mkdir(root, { recursive: true });

    const projectDir = (projectId: string) => path.join(root, projectId);
    const app = express();

    app.use((req, res, next) =>
        req.headers.authorization?.startsWith('Bearer ') ? next() : sendError(res, 401, 'Missing API token')
    );

    app.param('projectId', (_req, res, next, projectId: string) =>
        PROJECT_ID.test(projectId) && fs.existsSync(projectDir(projectId))
            ? next()
            : sendError(res, 404, 'Project not found')
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
                const [first] = await readNotebookFiles(projectDir(id));
                const { birthtime, mtime } = await fs.promises.stat(projectDir(id));

                return {
                    id,
                    name: first ? deserializeDeepnoteFile(first.content.toString('utf8')).project.name : id,
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
            const entries = Object.entries(unzipSync(new Uint8Array(req.body as Buffer)));
            if (!entries.every(([filename]) => NOTEBOOK_FILE.test(filename))) {
                return sendError(res, 422, 'The archive may contain only .deepnote files');
            }

            let documents: { content: Uint8Array; filename: string; notebooks: { id: string; name: string }[] }[];
            try {
                documents = entries.map(([filename, content]) => ({
                    content,
                    filename,
                    notebooks: deserializeDeepnoteFile(Buffer.from(content).toString('utf8')).project.notebooks
                }));
            } catch (error) {
                return sendError(res, 422, error instanceof Error ? error.message : String(error));
            }

            const notebooks: Schemas['ImportProjectResponse']['notebooks'] = [];
            for (const document of documents) {
                const action = fs.existsSync(path.join(dir, document.filename))
                    ? ('overwritten' as const)
                    : ('created' as const);
                await fs.promises.writeFile(path.join(dir, document.filename), document.content);
                notebooks.push(...document.notebooks.map(({ id, name }) => ({ id, name, action })));
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

    return {
        rootDir: root,
        url: `http://127.0.0.1:${port}`,
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
