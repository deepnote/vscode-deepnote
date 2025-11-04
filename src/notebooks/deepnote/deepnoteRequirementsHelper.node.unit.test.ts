import { assert } from 'chai';
import * as sinon from 'sinon';
import { instance, mock, when } from 'ts-mockito';
import { CancellationToken, Uri, WorkspaceFolder } from 'vscode';
import * as fs from 'fs';

import { DeepnoteRequirementsHelper } from './deepnoteRequirementsHelper.node';
import type { DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';
import { ILogger } from '../../platform/logging/types';
import { IPersistentStateFactory } from '../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

suite('DeepnoteRequirementsHelper', () => {
    let helper: DeepnoteRequirementsHelper;
    let mockLogger: ILogger;
    let mockPersistentStateFactory: IPersistentStateFactory;
    let mockCancellationToken: CancellationToken;
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        resetVSCodeMocks();
        sandbox = sinon.createSandbox();

        // Create mocks
        mockLogger = mock<ILogger>();
        mockPersistentStateFactory = mock<IPersistentStateFactory>();
        mockCancellationToken = mock<CancellationToken>();

        // Setup default behavior for cancellation token
        when(mockCancellationToken.isCancellationRequested).thenReturn(false);

        // Create the helper with mocked dependencies
        helper = new DeepnoteRequirementsHelper(instance(mockLogger), instance(mockPersistentStateFactory));
    });

    teardown(() => {
        sandbox.restore();
        resetVSCodeMocks();
    });

    test('should create requirements.txt file with valid requirements', async () => {
        // Arrange
        const workspaceUri = Uri.file('/test/workspace');
        const mockWorkspaceFolder: WorkspaceFolder = {
            uri: workspaceUri,
            name: 'test-workspace',
            index: 0
        };

        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([mockWorkspaceFolder]);

        const project: DeepnoteProject = {
            metadata: {
                createdAt: '2024-01-01T00:00:00Z'
            },
            version: '1',
            project: {
                id: 'test-project-id',
                name: 'Test Project',
                notebooks: [],
                settings: {
                    requirements: ['numpy>=1.20.0', 'pandas==1.3.0', 'matplotlib']
                }
            }
        };

        // Mock fs.promises to check file doesn't exist
        const fsAccessStub = sandbox.stub(fs.promises, 'access');
        fsAccessStub.rejects(new Error('File not found'));

        // Mock fs.promises.writeFile to capture what's written
        let writtenContent = '';
        let writtenPath = '';
        const fsWriteFileStub = sandbox.stub(fs.promises, 'writeFile');
        fsWriteFileStub.callsFake(async (path, content) => {
            writtenPath = path.toString();
            writtenContent = content.toString();
        });

        // Act
        await helper.createRequirementsFile(project, instance(mockCancellationToken));

        // Assert
        assert.isTrue(fsWriteFileStub.calledOnce, 'writeFile should be called once');
        assert.include(writtenPath, 'requirements.txt', 'Should write to requirements.txt');
        assert.include(writtenContent, 'numpy>=1.20.0', 'Should include numpy requirement');
        assert.include(writtenContent, 'pandas==1.3.0', 'Should include pandas requirement');
        assert.include(writtenContent, 'matplotlib', 'Should include matplotlib requirement');

        // Verify content format (should have LF line endings)
        const expectedContent = 'numpy>=1.20.0\npandas==1.3.0\nmatplotlib\n';
        assert.strictEqual(writtenContent, expectedContent, 'Content should match expected format');
    });
});
