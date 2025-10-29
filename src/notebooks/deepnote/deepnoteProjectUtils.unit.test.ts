import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { Uri, workspace } from 'vscode';

import { readDeepnoteProjectFile } from './deepnoteProjectUtils';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

suite('DeepnoteProjectUtils', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        resetVSCodeMocks();
    });

    teardown(() => {
        sandbox.restore();
        resetVSCodeMocks();
    });

    suite('readDeepnoteProjectFile', () => {
        test('should successfully parse valid YAML content', async () => {
            const mockFS = mock<typeof workspace.fs>();
            const testUri = Uri.file('/test/project.deepnote');

            const validYaml = `
version: 1
project:
  id: test-project-id
  name: Test Project
  notebooks:
    - id: test-notebook-id
      title: Test Notebook
      blocks: []
`;

            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(validYaml)));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const result = await readDeepnoteProjectFile(testUri);

            assert.isDefined(result.version);
            assert.strictEqual(result.project.id, 'test-project-id');
            assert.strictEqual(result.project.name, 'Test Project');
            assert.strictEqual(result.project.notebooks.length, 1);
            assert.strictEqual(result.project.notebooks[0].id, 'test-notebook-id');
        });

        test('should throw error for invalid YAML content', async () => {
            const mockFS = mock<typeof workspace.fs>();
            const testUri = Uri.file('/test/invalid.deepnote');

            const invalidYaml = `
version: 1
project:
  invalid: yaml: content: here
    - malformed
`;

            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(invalidYaml)));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            try {
                await readDeepnoteProjectFile(testUri);
                assert.fail('Should have thrown an error');
            } catch (error) {
                assert.ok(error instanceof Error);
            }
        });

        test('should correctly decode file content with UTF-8 characters', async () => {
            const mockFS = mock<typeof workspace.fs>();
            const testUri = Uri.file('/test/unicode.deepnote');

            const yamlWithUnicode = `
version: 1
project:
  id: test-id
  name: Test Project with emojis 🚀
  notebooks: []
`;

            when(mockFS.readFile(anything())).thenReturn(Promise.resolve(Buffer.from(yamlWithUnicode, 'utf-8')));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFS));

            const result = await readDeepnoteProjectFile(testUri);

            assert.strictEqual(result.project.name, 'Test Project with emojis 🚀');
        });
    });
});
