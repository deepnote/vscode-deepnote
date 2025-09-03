import * as assert from 'assert';

import { DeepnoteNotebookSelector } from './deepnoteNotebookSelector';
import type { DeepnoteNotebook } from './deepnoteTypes';

suite('DeepnoteNotebookSelector', () => {
    let selector: DeepnoteNotebookSelector;

    const mockNotebooks: DeepnoteNotebook[] = [
        {
            blocks: [{ content: 'print("hello")', id: '1', sortingKey: '001', type: 'code' }],
            executionMode: 'python',
            id: 'notebook-1',
            isModule: false,
            name: 'My Notebook',
            workingDirectory: '/home/user'
        },
        {
            blocks: [
                { content: '# Header', id: '2', sortingKey: '001', type: 'markdown' },
                { content: 'print("world")', id: '3', sortingKey: '002', type: 'code' }
            ],
            executionMode: 'python',
            id: 'notebook-2',
            isModule: true,
            name: 'Another Notebook'
        }
    ];

    setup(() => {
        selector = new DeepnoteNotebookSelector();
    });

    suite('getDescription', () => {
        test('should return current notebook description for matching notebook', () => {
            const description = (selector as any).getDescription(mockNotebooks[0], 'notebook-1');
            
            // Now using direct strings, the mock should return the English text
            assert.strictEqual(description, '1 cells (current)');
        });

        test('should return regular notebook description for non-matching notebook', () => {
            const description = (selector as any).getDescription(mockNotebooks[1], 'notebook-1');
            
            assert.strictEqual(description, '2 cells');
        });

        test('should handle notebook with no blocks', () => {
            const emptyNotebook: DeepnoteNotebook = {
                blocks: [],
                executionMode: 'python',
                id: 'empty',
                isModule: false,
                name: 'Empty Notebook'
            };

            const description = (selector as any).getDescription(emptyNotebook);
            
            assert.strictEqual(description, '0 cells');
        });

        test('should return correct cell count', () => {
            const description = (selector as any).getDescription(mockNotebooks[1]);
            
            assert.strictEqual(description, '2 cells');
        });
    });

    suite('getDetail', () => {
        test('should return detail with working directory', () => {
            const detail = (selector as any).getDetail(mockNotebooks[0]);
            
            assert.strictEqual(detail, 'ID: notebook-1 | Working Directory: /home/user');
        });

        test('should return detail without working directory', () => {
            const detail = (selector as any).getDetail(mockNotebooks[1]);
            
            assert.strictEqual(detail, 'ID: notebook-2');
        });

        test('should handle notebook with empty working directory', () => {
            const notebook: DeepnoteNotebook = {
                ...mockNotebooks[0],
                workingDirectory: ''
            };

            const detail = (selector as any).getDetail(notebook);
            
            assert.strictEqual(detail, 'ID: notebook-1');
        });

        test('should include notebook ID in all cases', () => {
            const detail1 = (selector as any).getDetail(mockNotebooks[0]);
            const detail2 = (selector as any).getDetail(mockNotebooks[1]);
            
            assert.strictEqual(detail1, 'ID: notebook-1 | Working Directory: /home/user');
            assert.strictEqual(detail2, 'ID: notebook-2');
        });
    });

    suite('activeItem selection logic', () => {
        test('should find and return the active item when currentNotebookId matches', () => {
            const items = mockNotebooks.map((notebook) => ({
                label: notebook.name,
                description: (selector as any).getDescription(notebook, 'notebook-1'),
                detail: (selector as any).getDetail(notebook),
                notebook
            }));

            const currentId = 'notebook-1';
            const activeItem = currentId ? items.find(item => item.notebook.id === currentId) : undefined;
            
            assert.ok(activeItem);
            assert.strictEqual(activeItem.notebook.id, 'notebook-1');
            assert.strictEqual(activeItem.label, 'My Notebook');
        });

        test('should return undefined when currentNotebookId does not match any notebook', () => {
            const items = mockNotebooks.map((notebook) => ({
                label: notebook.name,
                description: (selector as any).getDescription(notebook, 'nonexistent-id'),
                detail: (selector as any).getDetail(notebook),
                notebook
            }));

            const currentId = 'nonexistent-id';
            const activeItem = currentId ? items.find(item => item.notebook.id === currentId) : undefined;
            
            assert.strictEqual(activeItem, undefined);
        });

        test('should return undefined when currentNotebookId is not provided', () => {
            const items = mockNotebooks.map((notebook) => ({
                label: notebook.name,
                description: (selector as any).getDescription(notebook),
                detail: (selector as any).getDetail(notebook),
                notebook
            }));

            const currentId = undefined;
            const activeItem = currentId ? items.find(item => item.notebook.id === currentId) : undefined;
            
            assert.strictEqual(activeItem, undefined);
        });
    });
});