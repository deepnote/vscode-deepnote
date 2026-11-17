import { assert } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import { anything, when } from 'ts-mockito';
import { Uri } from 'vscode';

import * as path from '../../../platform/vscode-path/path';
import { stubWorkspaceFsOnDisk } from '../../../test/mocks/vscodeFs';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { serializeProjectFile } from '../deepnoteTestHelpers';
import { resolvePreviewProject } from './appPreviewWorkspace.node';

suite('resolvePreviewProject', () => {
    let tmp: string;

    function write(relativePath: string, contents: string): void {
        const file = path.join(tmp, relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    }

    function folder(relativePath: string): Uri {
        const uri = Uri.file(path.join(tmp, relativePath));
        fs.mkdirSync(uri.fsPath, { recursive: true });

        return uri;
    }

    async function resolve(relativePath: string): Promise<{ id: string; folder: string } | undefined> {
        const project = await resolvePreviewProject(folder(relativePath));

        return project && { id: project.id, folder: path.relative(tmp, project.folder.fsPath) };
    }

    setup(() => {
        resetVSCodeMocks();
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-app-preview-workspace-'));

        stubWorkspaceFsOnDisk();
        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenReturn({
            uri: Uri.file(path.join(tmp, 'ws')),
            name: 'ws',
            index: 0
        });
    });

    teardown(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('finds the project of a synced app under <project>/.files/_deepnote_static', async () => {
        write('ws/Team/Sales/sales.deepnote', serializeProjectFile('p-sales'));

        assert.deepStrictEqual(await resolve('ws/Team/Sales/.files/_deepnote_static'), {
            id: 'p-sales',
            folder: path.join('ws', 'Team', 'Sales')
        });
    });

    test('finds the project of an app folder beside the .deepnote file at the workspace root', async () => {
        write('ws/analysis.deepnote', serializeProjectFile('p-local'));

        assert.deepStrictEqual(await resolve('ws/app'), { id: 'p-local', folder: 'ws' });
    });

    test('finds the project when the app folder itself holds the .deepnote file', async () => {
        write('ws/app/app.deepnote', serializeProjectFile('p-app'));
        write('ws/other.deepnote', serializeProjectFile('p-parent'));

        assert.deepStrictEqual(await resolve('ws/app'), { id: 'p-app', folder: path.join('ws', 'app') });
    });

    test('returns undefined when the nearest folder holds files of two projects', async () => {
        write('ws/project/a.deepnote', serializeProjectFile('p-a'));
        write('ws/project/b.deepnote', serializeProjectFile('p-b'));
        write('ws/root.deepnote', serializeProjectFile('p-root'));

        assert.isUndefined(await resolve('ws/project/app'));
    });

    test('shares one ID across the files of a multi-file project', async () => {
        write('ws/project/a.deepnote', serializeProjectFile('p-shared'));
        write('ws/project/b.deepnote', serializeProjectFile('p-shared'));

        assert.deepStrictEqual(await resolve('ws/project/app'), {
            id: 'p-shared',
            folder: path.join('ws', 'project')
        });
    });

    test('returns undefined when no folder up to the workspace root holds a .deepnote file', async () => {
        write('outside.deepnote', serializeProjectFile('p-outside'));

        assert.isUndefined(await resolve('ws/project/app'));
    });

    test('ignores snapshot files', async () => {
        write('ws/project/main.deepnote', serializeProjectFile('p-main'));
        write('ws/project/main_p-old_latest.snapshot.deepnote', serializeProjectFile('p-old'));

        assert.deepStrictEqual(await resolve('ws/project/app'), {
            id: 'p-main',
            folder: path.join('ws', 'project')
        });
    });

    test('ignores .deepnote files that fail to parse', async () => {
        write('ws/project/app/broken.deepnote', 'project: [unclosed');
        write('ws/project/main.deepnote', serializeProjectFile('p-main'));

        assert.deepStrictEqual(await resolve('ws/project/app'), {
            id: 'p-main',
            folder: path.join('ws', 'project')
        });
    });
});
