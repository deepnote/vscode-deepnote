// Stand-in for @shikijs/cli in the bundled Deepnote CLI (dist/deepnoteCli.cjs).
//
// The CLI only uses `codeToANSI` to colour Python and SQL in terminal output. The extension runs the
// bundled CLI with its output going to a log, where ANSI colour is noise, and the real package pulls
// in every TextMate grammar and theme shiki ships (about 10 MB minified). Returning the code as-is
// keeps the bundle at a few megabytes.
export async function codeToANSI(code) {
    return code;
}
