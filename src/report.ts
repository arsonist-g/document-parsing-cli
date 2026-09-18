/** 纯文本表格渲染（管理类命令的报告输出用）。 */

export function renderTable<T extends object>(rows: T[], columns: string[]): string {
  const cell = (row: T, col: string): string => {
    const value = (row as Record<string, unknown>)[col];
    return value === undefined || value === null ? "" : String(value);
  };
  if (rows.length === 0) return "(空)";
  const widths = columns.map((col) => Math.max(col.length, ...rows.map((row) => cell(row, col).length)));
  const line = (cells: string[]): string =>
    cells.map((value, i) => value.padEnd(widths[i] ?? value.length)).join("  ").trimEnd();
  const out = [line(columns), line(widths.map((w) => "-".repeat(w)))];
  for (const row of rows) out.push(line(columns.map((col) => cell(row, col))));
  return out.join("\n");
}
