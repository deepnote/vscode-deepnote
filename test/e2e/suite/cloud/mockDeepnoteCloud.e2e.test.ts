import { expect } from 'chai';
import { strToU8, zipSync } from 'fflate';
import * as fs from 'fs';
import * as path from 'path';

import { startMockDeepnoteCloud, type MockDeepnoteCloud } from '../../helpers/mockDeepnoteCloud';

const PROJECT_ID = '6d2b9f4e-3a1c-4e7d-b5f8-0c9a2e4d6b1f';
const OTHER_PROJECT_ID = '1e5a7c3d-9b2f-4d8e-a6c0-3f7b1d9e5a2c';

function deepnoteFile({
    projectId = PROJECT_ID,
    name = 'Alpha',
    notebookIds = ['n1'],
    integrations
}: {
    projectId?: string;
    name?: string;
    notebookIds?: string[];
    integrations?: { id: string; name: string }[];
} = {}): string {
    const notebooks = notebookIds.map((id) => `{ id: ${id}, name: ${id}, blocks: [] }`);
    const integrationItems = integrations?.map(
        (integration) => `{ id: ${integration.id}, name: ${integration.name}, type: pgsql }`
    );

    return [
        "version: '1.0.0'",
        'metadata:',
        "  createdAt: '2025-01-01T00:00:00.000Z'",
        'project:',
        `  id: ${projectId}`,
        `  name: ${name}`,
        `  notebooks: [${notebooks.join(', ')}]`,
        ...(integrationItems ? [`  integrations: [${integrationItems.join(', ')}]`] : []),
        ''
    ].join('\n');
}

const MAIN = deepnoteFile();

function zip(files: Record<string, string>): Buffer<ArrayBuffer> {
    return Buffer.from(
        zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])))
    );
}

describe('Deepnote Cloud — the mock rejects the imports Deepnote Cloud rejects', function () {
    let cloud: MockDeepnoteCloud;
    let projectDir = '';

    async function postImport(body: Buffer<ArrayBuffer>): Promise<{ status: number; body: unknown }> {
        const response = await fetch(`${cloud.url}/v2/projects/${PROJECT_ID}/import`, {
            method: 'POST',
            headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/zip' },
            body
        });

        return { status: response.status, body: await response.json() };
    }

    function readProjectFiles(): Record<string, string> {
        return Object.fromEntries(
            fs.readdirSync(projectDir).map((name) => [name, fs.readFileSync(path.join(projectDir, name), 'utf8')])
        );
    }

    beforeEach(async function () {
        cloud = await startMockDeepnoteCloud();
        projectDir = path.join(cloud.rootDir, PROJECT_ID);
        fs.mkdirSync(projectDir);
        fs.writeFileSync(path.join(projectDir, 'main.deepnote'), MAIN);
    });

    afterEach(async function () {
        await cloud.stop();
    });

    const rejections: { title: string; body: Buffer<ArrayBuffer>; message: string }[] = [
        {
            title: 'a body that is not a ZIP',
            body: Buffer.from('not a zip'),
            message: 'The archive is not a readable ZIP'
        },
        {
            title: 'a valid document and one of another project',
            body: zip({ 'a.deepnote': MAIN, 'b.deepnote': deepnoteFile({ projectId: OTHER_PROJECT_ID }) }),
            message: 'A document belongs to another project'
        },
        {
            title: 'a valid document and one without notebooks',
            body: zip({ 'a.deepnote': MAIN, 'b.deepnote': deepnoteFile({ notebookIds: [] }) }),
            message: 'A document must contain exactly one notebook'
        },
        {
            title: 'a valid document and one with two notebooks',
            body: zip({ 'a.deepnote': MAIN, 'b.deepnote': deepnoteFile({ notebookIds: ['n1', 'n2'] }) }),
            message: 'A document must contain exactly one notebook'
        },
        {
            title: 'documents with different project names',
            body: zip({ 'a.deepnote': deepnoteFile({ name: 'Alpha' }), 'b.deepnote': deepnoteFile({ name: 'Beta' }) }),
            message: 'The documents disagree on the project name'
        },
        {
            title: 'documents with different integration ids',
            body: zip({
                'a.deepnote': deepnoteFile({ integrations: [{ id: 'i1', name: 'Warehouse' }] }),
                'b.deepnote': deepnoteFile({ integrations: [{ id: 'i2', name: 'Warehouse' }] })
            }),
            message: 'The documents disagree on the integrations'
        }
    ];

    for (const { title, body, message } of rejections) {
        it(`answers 422 and writes nothing for ${title}`, async function () {
            expect(await postImport(body)).to.deep.equal({ status: 422, body: { message } });
            expect(readProjectFiles()).to.deep.equal({ 'main.deepnote': MAIN });
        });
    }

    it('accepts documents when only one of them declares integrations', async function () {
        const withIntegrations = deepnoteFile({ integrations: [{ id: 'i1', name: 'Warehouse' }] });
        const withoutIntegrations = deepnoteFile();

        const { status } = await postImport(zip({ 'a.deepnote': withIntegrations, 'b.deepnote': withoutIntegrations }));

        expect(status).to.equal(200);
        expect(readProjectFiles()).to.deep.equal({
            'a.deepnote': withIntegrations,
            'b.deepnote': withoutIntegrations,
            'main.deepnote': MAIN
        });
    });

    it('accepts documents that list the same integrations in a different order', async function () {
        const warehouse = { id: 'i1', name: 'Warehouse' };
        const lake = { id: 'i2', name: 'Lake' };
        const a = deepnoteFile({ notebookIds: ['n1'], integrations: [warehouse, lake] });
        const b = deepnoteFile({ notebookIds: ['n2'], integrations: [lake, warehouse] });

        const { status } = await postImport(zip({ 'a.deepnote': a, 'b.deepnote': b }));

        expect(status).to.equal(200);
        expect(readProjectFiles()).to.deep.equal({ 'a.deepnote': a, 'b.deepnote': b, 'main.deepnote': MAIN });
    });

    it('accepts an empty archive and changes no file', async function () {
        const { status } = await postImport(zip({}));

        expect(status).to.equal(200);
        expect(readProjectFiles()).to.deep.equal({ 'main.deepnote': MAIN });
    });
});

describe('Deepnote Cloud — the mock serves the files and settings that publishing uses', function () {
    let cloud: MockDeepnoteCloud;

    async function request(method: string, route: string, body?: FormData | object): Promise<Response> {
        return fetch(`${cloud.url}${route}`, {
            method,
            headers: {
                Authorization: 'Bearer test-token',
                ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {})
            },
            body: body instanceof FormData ? body : body && JSON.stringify(body)
        });
    }

    function upload(filePath: string, content: string): Promise<Response> {
        const form = new FormData();
        form.set('projectId', PROJECT_ID);
        form.set('path', filePath);
        form.set('file', new Blob([content]), path.posix.basename(filePath));

        return request('POST', '/v2/files', form);
    }

    beforeEach(async function () {
        cloud = await startMockDeepnoteCloud();
        const projectDir = path.join(cloud.rootDir, PROJECT_ID);
        fs.mkdirSync(projectDir);
        fs.writeFileSync(path.join(projectDir, 'main.deepnote'), MAIN);
    });

    afterEach(async function () {
        await cloud.stop();
    });

    it('stores an upload to a taken path at a new path, and lists both', async function () {
        expect((await upload('_deepnote_static/app.js', 'one')).status).to.equal(201);

        const second = await upload('_deepnote_static/app.js', 'second');

        expect(second.status).to.equal(201);
        expect(((await second.json()) as { file: { path: string } }).file.path).to.equal('_deepnote_static/app (1).js');
        const { project } = (await (await request('GET', `/v2/projects/${PROJECT_ID}`)).json()) as {
            project: { files: { path: string; size: number }[] };
        };
        expect(project.files.map(({ path: filePath, size }) => ({ path: filePath, size }))).to.have.deep.members([
            { path: '_deepnote_static/app.js', size: 3 },
            { path: '_deepnote_static/app (1).js', size: 6 }
        ]);
    });

    it('answers 404 for a delete of a missing file', async function () {
        const response = await request(
            'DELETE',
            `/v2/files?projectId=${PROJECT_ID}&path=${encodeURIComponent('_deepnote_static/missing.js')}`
        );

        expect(response.status).to.equal(404);
        expect(await response.json()).to.deep.equal({ message: 'File not found' });
    });

    it('refuses to enable API access while sharing is disabled', async function () {
        const response = await request('PATCH', `/v2/projects/${PROJECT_ID}`, {
            staticFiles: { apiAccessEnabled: true }
        });

        expect(response.status).to.equal(400);
        expect(await response.json()).to.deep.equal({
            message: 'API access can be enabled only when sharing is enabled'
        });
    });
});
