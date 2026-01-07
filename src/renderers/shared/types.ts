export type OpenImageInPlotViewer = {
    type: 'openImageInPlotViewer';
    outputId: string;
    mimeType: string;
};

export type IsDeepnoteExtensionInstalled = {
    type: 'isDeepnoteExtensionInstalled';
    response?: boolean;
};

export type SaveImageAs = {
    type: 'saveImageAs';
    outputId: string;
    mimeType: string;
};
