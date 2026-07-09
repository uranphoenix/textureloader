import fs from "fs-extra";
import type { SourceRow } from "../types.js";

export async function loadSourceRows(sourcePath: string): Promise<SourceRow[]> {
  const rows: SourceRow[] = await fs.readJson(sourcePath);
  return rows.filter((row) => Boolean(row.Link) && Boolean(row.Code));
}
