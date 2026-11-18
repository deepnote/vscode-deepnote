// Loaded right after the bundled copy of Deepnote's client, which has no `dataframe()` yet, so that apps can page
// through their stored dataframes in the preview.

import { addDataframe, type DeepnoteGlobal } from './deepnoteDataframe';

addDataframe((window as unknown as { Deepnote: DeepnoteGlobal }).Deepnote, window.fetch.bind(window));
