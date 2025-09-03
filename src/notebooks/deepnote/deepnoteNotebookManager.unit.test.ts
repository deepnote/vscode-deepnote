import * as assert from 'assert';

import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import type { DeepnoteProject } from './deepnoteTypes';

suite('DeepnoteNotebookManager', () => {
    let manager: DeepnoteNotebookManager;

    const mockProject: DeepnoteProject = {
        metadata: {
            createdAt: '2023-01-01T00:00:00Z',
            modifiedAt: '2023-01-02T00:00:00Z'
        },
        project: {
            id: 'project-123',
            name: 'Test Project',
            notebooks: [],
            settings: {}
        },
        version: '1.0'
    };

    setup(() => {
        manager = new DeepnoteNotebookManager();
    });

    suite('getCurrentNotebookId', () => {
        test('should return undefined for unknown project', () => {
            const result = manager.getCurrentNotebookId('unknown-project');
            
            assert.strictEqual(result, undefined);
        });

        test('should return notebook ID after storing project', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            
            const result = manager.getCurrentNotebookId('project-123');
            
            assert.strictEqual(result, 'notebook-456');
        });

        test('should return updated notebook ID', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            manager.updateCurrentNotebookId('project-123', 'notebook-789');
            
            const result = manager.getCurrentNotebookId('project-123');
            
            assert.strictEqual(result, 'notebook-789');
        });
    });

    suite('getOriginalProject', () => {
        test('should return undefined for unknown project', () => {
            const result = manager.getOriginalProject('unknown-project');
            
            assert.strictEqual(result, undefined);
        });

        test('should return original project after storing', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            
            const result = manager.getOriginalProject('project-123');
            
            assert.deepStrictEqual(result, mockProject);
        });
    });

    suite('getSelectedNotebookForUri', () => {
        test('should return undefined for unknown URI', () => {
            const result = manager.getSelectedNotebookForUri('file:///unknown.deepnote');
            
            assert.strictEqual(result, undefined);
        });

        test('should return notebook ID after setting', () => {
            manager.setSelectedNotebookForUri('file:///test.deepnote', 'notebook-456');
            
            const result = manager.getSelectedNotebookForUri('file:///test.deepnote');
            
            assert.strictEqual(result, 'notebook-456');
        });
    });

    suite('setSelectedNotebookForUri', () => {
        test('should store notebook selection and mark for skip prompt', () => {
            manager.setSelectedNotebookForUri('file:///test.deepnote', 'notebook-456');
            
            const selectedNotebook = manager.getSelectedNotebookForUri('file:///test.deepnote');
            const shouldSkip = manager.shouldSkipPrompt('file:///test.deepnote');
            
            assert.strictEqual(selectedNotebook, 'notebook-456');
            assert.strictEqual(shouldSkip, true);
        });

        test('should overwrite existing selection', () => {
            manager.setSelectedNotebookForUri('file:///test.deepnote', 'notebook-456');
            manager.setSelectedNotebookForUri('file:///test.deepnote', 'notebook-789');
            
            const result = manager.getSelectedNotebookForUri('file:///test.deepnote');
            
            assert.strictEqual(result, 'notebook-789');
        });
    });

    suite('shouldSkipPrompt', () => {
        test('should return false for unknown URI', () => {
            const result = manager.shouldSkipPrompt('file:///unknown.deepnote');
            
            assert.strictEqual(result, false);
        });

        test('should return true and remove skip flag on first call', () => {
            manager.setSelectedNotebookForUri('file:///test.deepnote', 'notebook-456');
            
            const firstCall = manager.shouldSkipPrompt('file:///test.deepnote');
            const secondCall = manager.shouldSkipPrompt('file:///test.deepnote');
            
            assert.strictEqual(firstCall, true);
            assert.strictEqual(secondCall, false);
        });

        test('should handle multiple URIs independently', () => {
            manager.setSelectedNotebookForUri('file:///test1.deepnote', 'notebook-1');
            manager.setSelectedNotebookForUri('file:///test2.deepnote', 'notebook-2');
            
            const shouldSkip1 = manager.shouldSkipPrompt('file:///test1.deepnote');
            const shouldSkip2 = manager.shouldSkipPrompt('file:///test2.deepnote');
            
            assert.strictEqual(shouldSkip1, true);
            assert.strictEqual(shouldSkip2, true);
        });
    });

    suite('storeOriginalProject', () => {
        test('should store both project and current notebook ID', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            
            const storedProject = manager.getOriginalProject('project-123');
            const currentNotebookId = manager.getCurrentNotebookId('project-123');
            
            assert.deepStrictEqual(storedProject, mockProject);
            assert.strictEqual(currentNotebookId, 'notebook-456');
        });

        test('should overwrite existing project data', () => {
            const updatedProject: DeepnoteProject = {
                ...mockProject,
                project: {
                    ...mockProject.project,
                    name: 'Updated Project'
                }
            };

            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            manager.storeOriginalProject('project-123', updatedProject, 'notebook-789');
            
            const storedProject = manager.getOriginalProject('project-123');
            const currentNotebookId = manager.getCurrentNotebookId('project-123');
            
            assert.deepStrictEqual(storedProject, updatedProject);
            assert.strictEqual(currentNotebookId, 'notebook-789');
        });
    });

    suite('updateCurrentNotebookId', () => {
        test('should update notebook ID for existing project', () => {
            manager.storeOriginalProject('project-123', mockProject, 'notebook-456');
            manager.updateCurrentNotebookId('project-123', 'notebook-789');
            
            const result = manager.getCurrentNotebookId('project-123');
            
            assert.strictEqual(result, 'notebook-789');
        });

        test('should set notebook ID for new project', () => {
            manager.updateCurrentNotebookId('new-project', 'notebook-123');
            
            const result = manager.getCurrentNotebookId('new-project');
            
            assert.strictEqual(result, 'notebook-123');
        });

        test('should handle multiple projects independently', () => {
            manager.updateCurrentNotebookId('project-1', 'notebook-1');
            manager.updateCurrentNotebookId('project-2', 'notebook-2');
            
            const result1 = manager.getCurrentNotebookId('project-1');
            const result2 = manager.getCurrentNotebookId('project-2');
            
            assert.strictEqual(result1, 'notebook-1');
            assert.strictEqual(result2, 'notebook-2');
        });
    });

    suite('integration scenarios', () => {
        test('should handle complete workflow for multiple files', () => {
            const uri1 = 'file:///project1.deepnote';
            const uri2 = 'file:///project2.deepnote';
            
            manager.storeOriginalProject('project-1', mockProject, 'notebook-1');
            manager.setSelectedNotebookForUri(uri1, 'notebook-1');
            
            manager.storeOriginalProject('project-2', mockProject, 'notebook-2');
            manager.setSelectedNotebookForUri(uri2, 'notebook-2');
            
            assert.strictEqual(manager.getCurrentNotebookId('project-1'), 'notebook-1');
            assert.strictEqual(manager.getCurrentNotebookId('project-2'), 'notebook-2');
            assert.strictEqual(manager.getSelectedNotebookForUri(uri1), 'notebook-1');
            assert.strictEqual(manager.getSelectedNotebookForUri(uri2), 'notebook-2');
            assert.strictEqual(manager.shouldSkipPrompt(uri1), true);
            assert.strictEqual(manager.shouldSkipPrompt(uri2), true);
            assert.strictEqual(manager.shouldSkipPrompt(uri1), false);
            assert.strictEqual(manager.shouldSkipPrompt(uri2), false);
        });

        test('should handle notebook switching within same project', () => {
            const uri = 'file:///project.deepnote';
            
            manager.storeOriginalProject('project-123', mockProject, 'notebook-1');
            manager.setSelectedNotebookForUri(uri, 'notebook-1');
            
            manager.updateCurrentNotebookId('project-123', 'notebook-2');
            manager.setSelectedNotebookForUri(uri, 'notebook-2');
            
            assert.strictEqual(manager.getCurrentNotebookId('project-123'), 'notebook-2');
            assert.strictEqual(manager.getSelectedNotebookForUri(uri), 'notebook-2');
            assert.strictEqual(manager.shouldSkipPrompt(uri), true);
        });
    });
});