export function stripOutputs(notebookJson: string): string {
  const nb = JSON.parse(notebookJson) as {
    cells: Array<{ outputs?: unknown[]; execution_count?: unknown }>;
  };
  for (const cell of nb.cells) {
    cell.outputs = [];
    cell.execution_count = null;
  }
  return JSON.stringify(nb, null, 1);
}
