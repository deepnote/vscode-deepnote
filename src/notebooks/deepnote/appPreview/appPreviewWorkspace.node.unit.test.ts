import { deepnoteBlockSchema, serializeDeepnoteFile, type DeepnoteBlock } from '@deepnote/blocks';
import { assert } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import { anything, when } from 'ts-mockito';
import { Uri } from 'vscode';

import * as path from '../../../platform/vscode-path/path';
import { stubWorkspaceFsOnDisk } from '../../../test/mocks/vscodeFs';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import {
    createDeepnoteFile,
    createDeepnoteNotebook,
    createDeepnoteProject,
    serializeProjectFile
} from '../deepnoteTestHelpers';
import { findNotebookById, resolvePreviewProject, toNotebookInputs } from './appPreviewWorkspace.node';

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

suite('findNotebookById', () => {
    let tmp: string;

    function writeProject(relativePath: string, projectId: string, notebooks: { id: string; name: string }[]): void {
        const file = path.join(tmp, relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
            file,
            serializeDeepnoteFile(
                createDeepnoteFile({
                    project: createDeepnoteProject({
                        id: projectId,
                        notebooks: notebooks.map((notebook) => createDeepnoteNotebook(notebook))
                    })
                })
            )
        );
    }

    /** Makes `workspace.findFiles` list these files, in this order. */
    function workspaceFiles(...relativePaths: string[]): void {
        when(mockedVSCodeNamespaces.workspace.findFiles('**/*.deepnote')).thenCall(async () =>
            relativePaths.map((relativePath) => Uri.file(path.join(tmp, relativePath)))
        );
    }

    async function find(notebookId: string): Promise<{ file: string; projectId: string; name: string } | undefined> {
        const found = await findNotebookById(notebookId);

        return (
            found && {
                file: path.relative(tmp, found.fileUri.fsPath),
                projectId: found.file.project.id,
                name: found.notebook.name
            }
        );
    }

    setup(() => {
        resetVSCodeMocks();
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-app-preview-notebooks-'));
        stubWorkspaceFsOnDisk();
    });

    teardown(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('finds a notebook in a nested folder and in a multi-notebook file', async () => {
        writeProject('team/sales/sales.deepnote', 'p-sales', [{ id: 'nb-sales', name: 'Sales' }]);
        writeProject('legacy.deepnote', 'p-legacy', [
            { id: 'nb-first', name: 'First' },
            { id: 'nb-second', name: 'Second' }
        ]);
        workspaceFiles('team/sales/sales.deepnote', 'legacy.deepnote');

        assert.deepStrictEqual(await find('nb-sales'), {
            file: path.join('team', 'sales', 'sales.deepnote'),
            projectId: 'p-sales',
            name: 'Sales'
        });
        assert.deepStrictEqual(await find('nb-second'), {
            file: 'legacy.deepnote',
            projectId: 'p-legacy',
            name: 'Second'
        });
    });

    test('returns undefined for an ID that no file has', async () => {
        writeProject('main.deepnote', 'p-main', [{ id: 'nb-main', name: 'Main' }]);
        workspaceFiles('main.deepnote');

        assert.isUndefined(await find('nb-missing'));
    });

    test('skips snapshots', async () => {
        writeProject('snapshots/main_p-main_latest.snapshot.deepnote', 'p-main', [
            { id: 'nb-snapshot', name: 'Snapshot' }
        ]);
        writeProject('main.deepnote', 'p-main', [{ id: 'nb-main', name: 'Main' }]);
        workspaceFiles('snapshots/main_p-main_latest.snapshot.deepnote', 'main.deepnote');

        assert.isUndefined(await find('nb-snapshot'));
    });

    test('skips a file that fails to parse and reads on', async () => {
        fs.writeFileSync(path.join(tmp, 'broken.deepnote'), 'project: [unclosed');
        writeProject('main.deepnote', 'p-main', [{ id: 'nb-main', name: 'Main' }]);
        workspaceFiles('broken.deepnote', 'main.deepnote');

        assert.deepStrictEqual(await find('nb-main'), { file: 'main.deepnote', projectId: 'p-main', name: 'Main' });
    });

    test('reads the file again on every call, so an edit on disk shows in the next lookup', async () => {
        writeProject('main.deepnote', 'p-main', [{ id: 'nb-main', name: 'Before' }]);
        workspaceFiles('main.deepnote');
        assert.strictEqual((await find('nb-main'))?.name, 'Before');

        writeProject('main.deepnote', 'p-main', [{ id: 'nb-main', name: 'After' }]);

        assert.strictEqual((await find('nb-main'))?.name, 'After');
    });
});

suite('toNotebookInputs', () => {
    function block(
        id: string,
        type: string,
        sortingKey: string,
        metadata: Record<string, unknown> = {}
    ): DeepnoteBlock {
        return deepnoteBlockSchema.parse({ id, type, blockGroup: 'g', sortingKey, metadata });
    }

    function inputsOf(...blocks: DeepnoteBlock[]) {
        return toNotebookInputs(createDeepnoteNotebook({ blocks }));
    }

    test('maps each input type with its value, label and type-specific fields', () => {
        assert.deepStrictEqual(
            inputsOf(
                block('text', 'input-text', 'a0', {
                    deepnote_variable_name: 'region',
                    deepnote_variable_value: 'Europe',
                    deepnote_input_label: 'Region'
                }),
                block('textarea', 'input-textarea', 'a1', {
                    deepnote_variable_name: 'notes',
                    deepnote_variable_value: 'line 1\nline 2'
                }),
                block('checkbox', 'input-checkbox', 'a2', {
                    deepnote_variable_name: 'include_returns',
                    deepnote_variable_value: true,
                    deepnote_input_label: 'Returns'
                }),
                block('select', 'input-select', 'a3', {
                    deepnote_variable_name: 'products',
                    deepnote_variable_value: ['Chairs', 'Lamps'],
                    deepnote_variable_options: ['Chairs', 'Desks', 'Lamps'],
                    deepnote_allow_multiple_values: true
                }),
                block('slider', 'input-slider', 'a4', {
                    deepnote_variable_name: 'threshold',
                    deepnote_variable_value: '40',
                    deepnote_slider_min_value: 10,
                    deepnote_slider_max_value: 90,
                    deepnote_slider_step: 5
                }),
                block('date', 'input-date', 'a5', {
                    deepnote_variable_name: 'start',
                    deepnote_variable_value: '2025-01-01'
                }),
                block('range', 'input-date-range', 'a6', {
                    deepnote_variable_name: 'period',
                    deepnote_variable_value: ['2025-01-01', '2025-03-31']
                }),
                block('file', 'input-file', 'a7', {
                    deepnote_variable_name: 'upload',
                    deepnote_variable_value: 'data.csv'
                })
            ),
            [
                { blockId: 'text', name: 'region', type: 'input-text', value: 'Europe', label: 'Region' },
                { blockId: 'textarea', name: 'notes', type: 'input-textarea', value: 'line 1\nline 2' },
                {
                    blockId: 'checkbox',
                    name: 'include_returns',
                    type: 'input-checkbox',
                    value: true,
                    label: 'Returns'
                },
                {
                    blockId: 'select',
                    name: 'products',
                    type: 'input-select',
                    value: ['Chairs', 'Lamps'],
                    options: ['Chairs', 'Desks', 'Lamps'],
                    multiple: true
                },
                { blockId: 'slider', name: 'threshold', type: 'input-slider', value: '40', min: 10, max: 90, step: 5 },
                { blockId: 'date', name: 'start', type: 'input-date', value: '2025-01-01' },
                { blockId: 'range', name: 'period', type: 'input-date-range', value: ['2025-01-01', '2025-03-31'] },
                { blockId: 'file', name: 'upload', type: 'input-file', value: 'data.csv' }
            ]
        );
    });

    test('gives a slider without a range 0 to 100 by 1, and a select without options none and a single value', () => {
        assert.deepStrictEqual(
            inputsOf(
                block('slider', 'input-slider', 'a0', {
                    deepnote_variable_name: 'level',
                    deepnote_variable_value: '3'
                }),
                block('select', 'input-select', 'a1', { deepnote_variable_name: 'choice' })
            ),
            [
                { blockId: 'slider', name: 'level', type: 'input-slider', value: '3', min: 0, max: 100, step: 1 },
                { blockId: 'select', name: 'choice', type: 'input-select', value: '', options: [], multiple: false }
            ]
        );
    });

    test('labels a checkbox with its checkbox label when it has no input label, and leaves an empty label out', () => {
        assert.deepStrictEqual(
            inputsOf(
                block('checkbox', 'input-checkbox', 'a0', {
                    deepnote_variable_name: 'agree',
                    deepnote_input_label: '',
                    deepnote_input_checkbox_label: 'I agree'
                }),
                block('text', 'input-text', 'a1', { deepnote_variable_name: 'city', deepnote_input_label: '' })
            ),
            [
                { blockId: 'checkbox', name: 'agree', type: 'input-checkbox', value: false, label: 'I agree' },
                { blockId: 'text', name: 'city', type: 'input-text', value: '' }
            ]
        );
    });

    test('leaves out input blocks without a variable name and blocks that are not inputs', () => {
        assert.deepStrictEqual(
            inputsOf(
                block('code', 'code', 'a0'),
                block('unnamed', 'input-text', 'a1', { deepnote_variable_name: '' }),
                block('named', 'input-text', 'a2', { deepnote_variable_name: 'city' })
            ),
            [{ blockId: 'named', name: 'city', type: 'input-text', value: '' }]
        );
    });

    test('lists the inputs in sortingKey order, comparing keys by code unit', () => {
        const names = inputsOf(
            block('third', 'input-text', 'a1', { deepnote_variable_name: 'third' }),
            block('second', 'input-text', 'a0', { deepnote_variable_name: 'second' }),
            block('first', 'input-text', 'Z', { deepnote_variable_name: 'first' })
        )?.map((input) => input.name);

        assert.deepStrictEqual(names, ['first', 'second', 'third']);
    });

    test('returns undefined for a notebook without inputs', () => {
        assert.isUndefined(inputsOf(block('code', 'code', 'a0')));
    });
});
