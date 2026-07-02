/** Counts notebooks in serialized `.deepnote` YAML; each notebook entry starts with `- blocks:`. */
export function notebookCount(yaml: string): number {
    return (yaml.match(/^\s*- blocks:/gm) ?? []).length;
}
