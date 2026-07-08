import type { TextureAnalysis } from "../types.js";

function starRating(tileability: number, capped: boolean): string {
  let stars = tileability >= 90 ? 5 : tileability >= 75 ? 4 : tileability >= 60 ? 3 : tileability >= 40 ? 2 : 1;
  // A flagged cutout swatch's tileability score is unreliable (a white background reads as
  // "continuous"), so don't let it show as a confident 4-5 star recommendation.
  if (capped) stars = Math.min(stars, 3);
  return "★".repeat(stars) + "☆".repeat(5 - stars);
}

export function printAnalysisSummary(params: {
  label: string;
  width: number;
  height: number;
  analysis: TextureAnalysis;
}): void {
  const { label, width, height, analysis } = params;
  console.log(`\n${label}`);
  console.log(`  Resolution: ${width}x${height}`);
  console.log(`  Tileability: ${analysis.tileability.toFixed(0)}%`);
  console.log(`  Perspective: ${analysis.perspectiveDetected ? "detected" : "none"}`);
  console.log(`  Lighting: ${analysis.lightingUniformity >= 70 ? "uniform" : "uneven"}`);
  console.log(`  Recommendation: ${starRating(analysis.tileability, analysis.cutoutSwatchDetected)}`);
  if (analysis.cutoutSwatchDetected) {
    console.log(`  ⚠ Cutout swatch detected - likely a product-card cutout, not a full-bleed material photo. Needs manual review.`);
  }
}

export function logRow(id: string, message: string): void {
  console.log(`[${id}] ${message}`);
}

export function logRowError(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${id}] ERROR: ${message}`);
}
