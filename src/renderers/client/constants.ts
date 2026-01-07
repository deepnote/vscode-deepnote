export const DeepnoteNotebookRenderer = 'deepnote-notebook-renderer';

export { OpenImageInPlotViewer, IsDeepnoteExtensionInstalled, SaveImageAs } from '../shared/types';
export declare const ClipboardItem: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prototype: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-unused-vars
    new (options: any): any;
};
export const noop = () => {
    // noop
};

export function isDarkTheme() {
    try {
        return (document.body.dataset.vscodeThemeKind || '').toLowerCase().includes('dark');
    } catch {
        return false;
    }
}
