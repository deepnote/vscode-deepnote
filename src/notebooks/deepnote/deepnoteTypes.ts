export interface DeepnoteProject {
    metadata: {
        createdAt: string;
        modifiedAt: string;
    };
    project: {
        id: string;
        name: string;
        notebooks: DeepnoteNotebook[];
        settings: Record<string, unknown>;
    };
    version: string;
}

export interface DeepnoteNotebook {
    blocks: DeepnoteBlock[];
    executionMode: string;
    id: string;
    isModule: boolean;
    name: string;
    workingDirectory?: string;
}

export interface DeepnoteBlock {
    content: string;
    executionCount?: number;
    id: string;
    metadata?: Record<string, unknown>;
    outputReference?: string;
    outputs?: DeepnoteOutput[];
    sortingKey: string;
    type: 'code' | 'markdown';
}

export interface DeepnoteOutput {
    data?: Record<string, any>;
    execution_count?: number;
    metadata?: Record<string, any>;
    name?: string;
    output_type: string;
    text?: string;
}
