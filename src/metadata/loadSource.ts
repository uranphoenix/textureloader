import fs from "fs-extra";
import { SOURCE_PATH } from "../config.js";
import type { SourceRow } from "../types.js";

export async function loadSourceRows(): Promise<SourceRow[]> {
  const rows: SourceRow[] = await fs.readJson(SOURCE_PATH);
  return rows.filter((row) => Boolean(row.Link) && Boolean(row.Code));
}
