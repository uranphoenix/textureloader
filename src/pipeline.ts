import type { Browser } from "playwright";
import path from "node:path";
import { scrapeImages } from "./scraper/scrapeImages.js";
import { scoreImages } from "./scraper/scoreImages.js";
import { downloadCandidate } from "./image/download.js";
import { analyzeTexture } from "./image/analyze.js";
import { makeSeamless } from "./image/seamless.js";
import { optimizeTexture } from "./image/optimize.js";
import { generatePreview } from "./image/preview.js";
import { buildMetadataRecord, upsertMetadata } from "./metadata/buildRecord.js";
import { logRow, logRowError, printAnalysisSummary } from "./utils/log.js";
import {
  METADATA_SCORE_WEIGHT,
  TILEABILITY_WEIGHT,
  CUTOUT_SWATCH_SCORE_PENALTY,
  TILEABILITY_KEEP_THRESHOLD,
  TOP_K_CANDIDATES,
  TEXTURES_DIR,
  MIN_USABLE_RESOLUTION,
} from "./config.js";
import type { AnalyzedCandidate, MaterialMetadata, SourceRow } from "./types.js";

/** Runs the full scrape -> score -> download -> analyze -> seamless/optimize -> preview -> metadata pipeline for one source row. */
export async function processRow(
  browser: Browser,
  row: SourceRow,
  metadataPath: string,
  categoryOverride?: string,
): Promise<MaterialMetadata> {
  const id = row.Code;
  const label =
    (typeof row["Description "] === "string" && row["Description "]) ||
    (typeof row["Material"] === "string" && row["Material"]) ||
    id;
  logRow(id, `Scraping ${row.Link}`);
  const candidates = await scrapeImages(browser, row.Link);
  if (candidates.length === 0) throw new Error("No images found on page");

  const scored = scoreImages(candidates);
  const topCandidates = scored.slice(0, TOP_K_CANDIDATES);
  logRow(id, `Downloading top ${topCandidates.length} of ${scored.length} scored candidates`);

  const analyzed: AnalyzedCandidate[] = [];
  for (let i = 0; i < topCandidates.length; i++) {
    const candidate = topCandidates[i];
    if (!candidate) continue;
    const downloaded = await downloadCandidate(candidate, id, i);
    if (!downloaded) continue;
    if (Math.min(downloaded.width, downloaded.height) < MIN_USABLE_RESOLUTION) continue;
    try {
      const analysis = await analyzeTexture(downloaded.filePath);
      // A cutout swatch's naive tileability score can be inflated by its uniform background, so
      // it shouldn't be able to outrank a genuine full-bleed candidate on that score alone.
      const cutoutPenalty = analysis.cutoutSwatchDetected ? CUTOUT_SWATCH_SCORE_PENALTY : 0;
      const finalScore =
        candidate.score * METADATA_SCORE_WEIGHT + analysis.tileability * TILEABILITY_WEIGHT - cutoutPenalty;
      analyzed.push({ ...downloaded, analysis, finalScore });
    } catch (error) {
      logRowError(id, error);
    }
  }

  if (analyzed.length === 0) throw new Error("No downloadable/analyzable image candidates found");

  analyzed.sort((a, b) => b.finalScore - a.finalScore);
  const winner = analyzed[0];
  if (!winner) throw new Error("unreachable: analyzed is non-empty");

  printAnalysisSummary({
    label: `${id} - ${label}`,
    width: winner.width,
    height: winner.height,
    analysis: winner.analysis,
  });

  // Always seam-blend, regardless of the winner's pre-blend tileability score: the naive
  // edge-continuity metric can score an image highly (matching pixel colors at the border) even
  // when it doesn't actually tile cleanly content-wise, so skipping the blend on a "high score"
  // was letting genuinely bad seams through unfixed. Blending a pair of already-similar edges is
  // a no-op in practice, so this is safe for already-good images too.
  const seamlessPipeline = await makeSeamless(winner.filePath);

  const texturePath = path.join(TEXTURES_DIR, `${id}_texture.webp`);
  const previewPath = path.join(TEXTURES_DIR, `${id}_preview.webp`);

  const { width: finalWidth } = await optimizeTexture(seamlessPipeline, texturePath);
  await generatePreview(texturePath, previewPath);

  // Re-measure on the final (seam-blended) texture so metadata reflects what actually shipped,
  // not just the winning candidate's pre-blend score.
  const finalTileability = (await analyzeTexture(texturePath)).tileability;
  logRow(id, `Final tileability after seamless blending: ${finalTileability}%`);

  const flags: string[] = [];
  if (winner.analysis.cutoutSwatchDetected) flags.push("cutout-swatch");
  if (finalTileability < TILEABILITY_KEEP_THRESHOLD) flags.push("low-tileability");

  const record = buildMetadataRecord({
    row,
    resolution: finalWidth,
    tileability: finalTileability,
    categoryOverride,
    flags: flags.length > 0 ? flags : undefined,
  });
  await upsertMetadata(record, metadataPath);
  logRow(id, `Done -> ${texturePath}`);
  return record;
}
