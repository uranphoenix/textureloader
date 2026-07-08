import fs from "fs-extra";
import { ASSETS_DIR, METADATA_PATH } from "../config.js";
import { slugify } from "../utils/slugify.js";
import type { MaterialMetadata, MaterialSpecs, SourceRow } from "../types.js";

function toNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}

/** Extra flooring-specific fields, included only when present in the source row - hardwood/LVP rows don't have carpet fields, so they shouldn't get bogus empty ones. */
function buildSpecs(row: SourceRow): MaterialSpecs | undefined {
  const specs: MaterialSpecs = {};
  if (row.Thikness) specs.thicknessIn = row.Thikness;

  const pile = toNumberOrUndefined(row["Pile thikness, inch"]);
  if (pile !== undefined) specs.pileThicknessIn = pile;

  if (row["Size, FT"] !== "" && row["Size, FT"] !== undefined) specs.sizeFt = row["Size, FT"];

  const pad = toNumberOrUndefined(row["Pad + (per SY)"]);
  if (pad !== undefined) specs.padPricePerSY = pad;

  const area900 = toNumberOrUndefined(row["10 SY = 900 SF"]);
  if (area900 !== undefined) specs.totalArea900SF = area900;

  const totalPlusPad = toNumberOrUndefined(row["Total Carpet+pad"]);
  if (totalPlusPad !== undefined) specs.totalCarpetPlusPad = totalPlusPad;

  return Object.keys(specs).length > 0 ? specs : undefined;
}

export function buildMetadataRecord(params: {
  row: SourceRow;
  resolution: number;
  tileability: number;
  flags?: string[] | undefined;
}): MaterialMetadata {
  const { row, resolution, tileability, flags } = params;
  const id = row.Code;
  const categorySlug = slugify(row.Category);

  const record: MaterialMetadata = {
    id,
    name: row["Description "].trim(),
    "item number": row["Item Number"],
    category: categorySlug,
    // Kept as-given from the source row even though it's inconsistent across rows
    // (e.g. "Carpet Shaw" vs "McCarran NORTHCUTT") - a source-data quality issue,
    // not something the importer should silently normalize.
    manufacturer: row["Ítem"],
    preview: `${id}_preview.webp`,
    texture: `${id}_texture.webp`,
    resolution,
    tileability,
    source: row.Link,
    created: new Date().toISOString(),
    tags: [categorySlug],
    pricesf: row["Price per SF"],
  };

  const specs = buildSpecs(row);
  if (specs) record.specs = specs;
  if (flags && flags.length > 0) record.flags = flags;
  return record;
}

/** Upserts by id so re-running the pipeline on the same source.json is idempotent. */
export async function upsertMetadata(record: MaterialMetadata): Promise<void> {
  await fs.ensureDir(ASSETS_DIR);
  let all: MaterialMetadata[] = [];
  if (await fs.pathExists(METADATA_PATH)) {
    all = await fs.readJson(METADATA_PATH);
  }
  const index = all.findIndex((r) => r.id === record.id);
  if (index === -1) all.push(record);
  else all[index] = record;
  await fs.writeJson(METADATA_PATH, all, { spaces: 2 });
}
