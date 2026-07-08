import { KEYWORDS, SCORE_WEIGHTS } from "../config.js";
import type { ImageCandidate, ScoreBreakdown, ScoredImageCandidate } from "../types.js";
import { filenameFromUrl } from "../utils/url.js";

function anyKeywordIn(text: string, keywords: readonly string[]): string | null {
  return keywords.find((keyword) => text.includes(keyword)) ?? null;
}

/**
 * Pure-metadata scoring (Step 2 of the pipeline) - no download required. Runs before any image
 * bytes are fetched, so it only has filename/declared-size/alt/DOM-context to work with.
 *
 * "Filename contains X" checks look at the filename only (precise). The "category contains
 * texture" bonus and the room-scene/furniture/perspective penalties look at the broader DOM
 * context too, since manufacturer pages rarely expose a literal "category" field - context class
 * names and alt text are the closest available proxy.
 */
export function scoreImage(candidate: ImageCandidate): ScoredImageCandidate {
  const breakdown: ScoreBreakdown = {};
  const filename = filenameFromUrl(candidate.url).toLowerCase();
  const broaderText = `${filename} ${candidate.alt ?? ""} ${candidate.context ?? ""}`.toLowerCase();

  const maxDeclared = Math.max(candidate.declaredWidth ?? 0, candidate.declaredHeight ?? 0);
  if (maxDeclared > SCORE_WEIGHTS.resolutionThresholdPx) {
    breakdown.resolution = SCORE_WEIGHTS.resolutionBonus;
  }

  if (candidate.declaredWidth && candidate.declaredHeight) {
    const ratio = candidate.declaredWidth / candidate.declaredHeight;
    if (Math.abs(ratio - 1) <= SCORE_WEIGHTS.aspectRatioTolerance) {
      breakdown.aspectRatio = SCORE_WEIGHTS.aspectRatioBonus;
    }
  }

  if (anyKeywordIn(broaderText, KEYWORDS.texture)) {
    breakdown.textureKeyword = SCORE_WEIGHTS.textureKeywordBonus;
  }
  if (anyKeywordIn(filename, KEYWORDS.tile)) {
    breakdown.tileKeyword = SCORE_WEIGHTS.tileKeywordBonus;
  }
  if (anyKeywordIn(filename, KEYWORDS.sample)) {
    breakdown.sampleKeyword = SCORE_WEIGHTS.sampleKeywordBonus;
  }

  const roomKeyword = anyKeywordIn(broaderText, KEYWORDS.roomScene);
  if (roomKeyword) breakdown[`roomScene:${roomKeyword}`] = SCORE_WEIGHTS.roomScenePenalty;

  const furnitureKeyword = anyKeywordIn(broaderText, KEYWORDS.furniture);
  if (furnitureKeyword) breakdown[`furniture:${furnitureKeyword}`] = SCORE_WEIGHTS.furniturePenalty;

  const perspectiveKeyword = anyKeywordIn(broaderText, KEYWORDS.perspectiveProxy);
  if (perspectiveKeyword) {
    breakdown[`perspectiveProxy:${perspectiveKeyword}`] = SCORE_WEIGHTS.perspectiveProxyPenalty;
  }

  const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return { ...candidate, score, scoreBreakdown: breakdown };
}

export function scoreImages(candidates: ImageCandidate[]): ScoredImageCandidate[] {
  return candidates.map(scoreImage).sort((a, b) => b.score - a.score);
}
