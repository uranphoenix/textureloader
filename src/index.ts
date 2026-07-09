import { chromium } from "playwright";
import fs from "fs-extra";
import path from "node:path";
import { loadSourceRows } from "./metadata/loadSource.js";
import { processRow } from "./pipeline.js";
import { logRowError } from "./utils/log.js";
import { createLimiter } from "./utils/concurrency.js";
import { CONCURRENCY, METADATA_PATH, SOURCE_PATH, ASSETS_DIR, TEXTURES_DIR } from "./config.js";
import type { MaterialMetadata } from "./types.js";

interface CliOptions {
  only: Set<string> | undefined;
  force: boolean;
  limit: number | undefined;
  /** Bare filename (e.g. "source_cabinetry.json") resolved relative to src/metadata/, or a path. Defaults to the flooring source.json. */
  source: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { only: undefined, force: false, limit: undefined, source: undefined };
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
    } else if (arg === "--source") {
      const value = argv[++i];
      if (value) options.source = value;
    }
  }
  return options;
}

/** "source_cabinetry.json" -> "cabinetry" (used as the category override, since that field means different things - or is blank - across source files). */
function deriveCategory(sourceFilename: string): string {
  const base = path.basename(sourceFilename, ".json");
  return base.startsWith("source_") ? base.slice("source_".length) : base;
}

/** "source_cabinetry.json" -> "metadata_cabinetry.json" - one output metadata file per source file. */
function deriveMetadataFilename(sourceFilename: string): string {
  const base = path.basename(sourceFilename);
  return base.replace(/^source/, "metadata");
}

async function loadExistingIds(metadataPath: string): Promise<Set<string>> {
  if (!(await fs.pathExists(metadataPath))) return new Set();
  const all: MaterialMetadata[] = await fs.readJson(metadataPath);
  return new Set(all.map((r) => r.id));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await fs.ensureDir(TEXTURES_DIR);

  const sourcePath = options.source
    ? path.isAbsolute(options.source)
      ? options.source
      : path.join(path.dirname(SOURCE_PATH), options.source)
    : SOURCE_PATH;
  const categoryOverride = options.source ? deriveCategory(options.source) : undefined;
  const metadataPath = options.source
    ? path.join(ASSETS_DIR, deriveMetadataFilename(options.source))
    : METADATA_PATH;

  let rows = await loadSourceRows(sourcePath);

  const only = options.only;
  if (only) rows = rows.filter((row) => only.has(row.Code));

  if (!options.force) {
    const existing = await loadExistingIds(metadataPath);
    rows = rows.filter((row) => !existing.has(row.Code));
  }

  if (options.limit !== undefined) rows = rows.slice(0, options.limit);

  if (rows.length === 0) {
    console.log("Nothing to do (no matching rows, or all already imported - use --force to re-run).");
    return;
  }

  console.log(
    `Processing ${rows.length} row(s) from ${path.basename(sourcePath)} with concurrency ${CONCURRENCY}...`,
  );
  const browser = await chromium.launch();
  const limit = createLimiter(CONCURRENCY);

  let succeeded = 0;
  let failed = 0;
  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        try {
          await processRow(browser, row, metadataPath, categoryOverride);
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
