// Stub for @shikijs/cli in the bundled Deepnote CLI: the real package pulls in every shiki grammar and
// theme (about 10 MB minified) to colour output that the extension only ever sends to a log.
export async function codeToANSI(code) {
    return code;
}
