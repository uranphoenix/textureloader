import fs from "fs-extra";
import path from "node:path";
import { ASSETS_DIR } from "../config.js";
import { slugify } from "../utils/slugify.js";
import { createLimiter } from "../utils/concurrency.js";
import type { MaterialMetadata, MaterialSpecs, SourceRow } from "../types.js";

// Serializes the metadata file's read-modify-write cycle - with CONCURRENCY > 1, two rows
// finishing close together could otherwise interleave their read/write and corrupt the file
// (one process reading mid-write) or silently lose one of the two updates.
const metadataWriteLimiter = createLimiter(1);

function toNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

// Fields already lifted to a named top-level MaterialMetadata property - excluded from the
// generic specs passthrough below so they don't appear twice.
const LIFTED_FIELDS = new Set([
  "Category",
  "Code",
  "Link",
  "Description ",
  "Description",
  "Material",
  "Ítem",
  "Manufacturer",
  "Price per SF",
  "Item Number",
  "Thikness",
  "Picture",
  "Pile thikness, inch",
  "Size, FT",
  "Pad + (per SY)",
  "10 SY = 900 SF",
  "Total Carpet+pad",
]);

/** Flooring-specific named fields, included only when present - hardwood/LVP rows don't have carpet fields, so they shouldn't get bogus empty ones. */
function buildNamedFloorSpecs(row: SourceRow): MaterialSpecs {
  const specs: MaterialSpecs = {};
  const thikness = row.Thikness;
  if (typeof thikness === "string" && thikness) specs.thicknessIn = thikness;

  const pile = toNumberOrUndefined(row["Pile thikness, inch"]);
  if (pile !== undefined) specs.pileThicknessIn = pile;

  const sizeFt = row["Size, FT"];
  if (sizeFt !== "" && sizeFt !== undefined && sizeFt !== null) {
    specs.sizeFt = sizeFt as string | number;
  }

  const pad = toNumberOrUndefined(row["Pad + (per SY)"]);
  if (pad !== undefined) specs.padPricePerSY = pad;

  const area900 = toNumberOrUndefined(row["10 SY = 900 SF"]);
  if (area900 !== undefined) specs.totalArea900SF = area900;

  const totalPlusPad = toNumberOrUndefined(row["Total Carpet+pad"]);
  if (totalPlusPad !== undefined) specs.totalCarpetPlusPad = totalPlusPad;

  return specs;
}

/** Every other source-file-specific field (Finish, Color, Texture, Country, per-box pricing, ...) not already lifted to a named property - keeps all schema-specific data without bespoke mapping per source file. */
function buildPassthroughSpecs(row: SourceRow): MaterialSpecs {
  const specs: MaterialSpecs = {};
  for (const [key, value] of Object.entries(row)) {
    if (LIFTED_FIELDS.has(key)) continue;
    if (value === "" || value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number") specs[key] = value;
  }
  return specs;
}

export function buildMetadataRecord(params: {
  row: SourceRow;
  resolution: number;
  tileability: number;
  /** Overrides the row's own "Category" field - needed because that field means different things (or is blank) across source files, e.g. tiles uses it for a color group, not a material type. */
  categoryOverride?: string | undefined;
  flags?: string[] | undefined;
}): MaterialMetadata {
  const { row, resolution, tileability, categoryOverride, flags } = params;
  const id = row.Code;
  const categorySlug = categoryOverride ? slugify(categoryOverride) : slugify(String(row.Category ?? ""));

  const name = firstString(row["Description "], row["Description"], row["Material"]) ?? id;
  // Kept as-given from the source row even though it's inconsistent across rows/files
  // (e.g. "Carpet Shaw" vs "McCarran NORTHCUTT" vs a cabinetry row with no such field at all) -
  // a source-data quality issue, not something the importer should silently normalize.
  const manufacturer = firstString(row["Ítem"], row["Manufacturer"], row["Material"]) ?? "";
  const pricesfRaw = row["Price per SF"];
  const pricesf = typeof pricesfRaw === "number" ? pricesfRaw : "";
  const itemNumberRaw = row["Item Number"];
  const itemNumber =
    typeof itemNumberRaw === "number" || typeof itemNumberRaw === "string" ? itemNumberRaw : "";

  const record: MaterialMetadata = {
    id,
    name,
    "item number": itemNumber,
    category: categorySlug,
    manufacturer,
    preview: `${id}_preview.webp`,
    texture: `${id}_texture.webp`,
    resolution,
    tileability,
    source: row.Link,
    created: new Date().toISOString(),
    tags: [categorySlug],
    pricesf,
  };

  const specs = { ...buildNamedFloorSpecs(row), ...buildPassthroughSpecs(row) };
  if (Object.keys(specs).length > 0) record.specs = specs;
  if (flags && flags.length > 0) record.flags = flags;
  return record;
}

/** Upserts by id so re-running the pipeline on the same source file is idempotent. */
export async function upsertMetadata(record: MaterialMetadata, metadataPath: string): Promise<void> {
  await metadataWriteLimiter(async () => {
    await fs.ensureDir(ASSETS_DIR);
    await fs.ensureDir(path.dirname(metadataPath));
    let all: MaterialMetadata[] = [];
    if (await fs.pathExists(metadataPath)) {
      all = await fs.readJson(metadataPath);
    }
    const index = all.findIndex((r) => r.id === record.id);
    if (index === -1) all.push(record);
    else all[index] = record;
    await fs.writeJson(metadataPath, all, { spaces: 2 });
  });
}
