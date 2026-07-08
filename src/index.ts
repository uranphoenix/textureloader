import { chromium } from "playwright";
import fs from "fs-extra";
import { loadSourceRows } from "./metadata/loadSource.js";
import { processRow } from "./pipeline.js";
import { logRowError } from "./utils/log.js";
import { createLimiter } from "./utils/concurrency.js";
import { CONCURRENCY, METADATA_PATH, TEXTURES_DIR } from "./config.js";
import type { MaterialMetadata } from "./types.js";

interface CliOptions {
  only: Set<string> | undefined;
  force: boolean;
  limit: number | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { only: undefined, force: false, limit: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only") {
      const value = argv[++i];
      if (value) options.only = new Set(value.split(",").map((s) => s.trim()));
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--limit") {
      const value = argv[++i];
      if (value) options.limit = Number(value);
    }
  }
  return options;
}

async function loadExistingIds(): Promise<Set<string>> {
  if (!(await fs.pathExists(METADATA_PATH))) return new Set();
  const all: MaterialMetadata[] = await fs.readJson(METADATA_PATH);
  return new Set(all.map((r) => r.id));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await fs.ensureDir(TEXTURES_DIR);

  let rows = await loadSourceRows();

  const only = options.only;
  if (only) rows = rows.filter((row) => only.has(row.Code));

  if (!options.force) {
    const existing = await loadExistingIds();
    rows = rows.filter((row) => !existing.has(row.Code));
  }

  if (options.limit !== undefined) rows = rows.slice(0, options.limit);

  if (rows.length === 0) {
    console.log("Nothing to do (no matching rows, or all already imported - use --force to re-run).");
    return;
  }

  console.log(`Processing ${rows.length} row(s) with concurrency ${CONCURRENCY}...`);
  const browser = await chromium.launch();
  const limit = createLimiter(CONCURRENCY);

  let succeeded = 0;
  let failed = 0;
  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        try {
          await processRow(browser, row);
          succeeded++;
        } catch (error) {
          failed++;
          logRowError(row.Code, error);
        }
      }),
    ),
  );

  await browser.close();
  console.log(`\nDone. ${succeeded} succeeded, ${failed} failed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
