import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(currentDir, "..");
export const ASSETS_DIR = path.join(ROOT_DIR, "assets");
export const TEXTURES_DIR = path.join(ASSETS_DIR, "textures");
export const METADATA_PATH = path.join(ASSETS_DIR, "metadata.json");
export const SOURCE_PATH = path.join(ROOT_DIR, "src", "metadata", "source.json");
export const DOWNLOAD_TMP_DIR = path.join(os.tmpdir(), "texture-import");

/** How many top-scoring candidates get downloaded + CV-analyzed before picking a winner. */
export const TOP_K_CANDIDATES = 6;

/**
 * Minimum (shorter-side) pixel dimension for a downloaded candidate to be eligible at all.
 * The naive edge-continuity tileability metric is biased toward small/blurry images (downsampling
 * destroys the fine detail that would otherwise reveal a seam), so without a hard floor here a
 * 120x120 thumbnail can out-score a genuine 840x840 texture on tileability alone even though it's
 * unusable as a texture regardless of how "tileable" it scores.
 */
export const MIN_USABLE_RESOLUTION = 400;

/** Tileability (0-100) at/above which the original image is kept as-is instead of seam-blended. */
export const TILEABILITY_KEEP_THRESHOLD = 90;

/** Final texture is center-cropped to square and capped at this dimension. */
export const TEXTURE_MAX_DIMENSION = 2048;

export const PREVIEW_SIZE = 256;
export const PREVIEW_CORNER_RADIUS = 12;
/**
 * Fractional (0-1) position of the preview crop's center, along each axis, instead of the
 * texture's true center. The seamless step always puts its blend band exactly through the
 * center (both a full-width horizontal band and a full-height vertical band, mirrored across
 * each), so a dead-center preview crop reliably lands on that 4-way mirror symmetry - which reads
 * as a sphere/radial distortion, especially on low-frequency textures like carpet. Offsetting
 * clears both bands.
 */
export const PREVIEW_CROP_OFFSET_FRACTION = 0.25;
/** Rounded-corner cutout is flattened onto this solid color rather than left transparent - avoids lossy-webp RGB bleed under alpha=0 pixels. */
export const PREVIEW_BACKGROUND = { r: 255, g: 255, b: 255 };

/** How many rows to process in parallel (separate Playwright browser contexts). */
export const CONCURRENCY = 2;

export const PAGE_TIMEOUT_MS = 30_000;
export const SCROLL_STEPS = 8;
export const SCROLL_WAIT_MS = 250;
export const VIEWPORT = { width: 1600, height: 1200 };

/**
 * Playwright's default UA gets a bare 403 from several manufacturer sites (bot-detection on the
 * generic headless fingerprint). A realistic desktop Chrome UA is enough to get past it here.
 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** Weighting of Step-2 metadata score vs Step-3 CV tileability when picking the final winner. */
export const METADATA_SCORE_WEIGHT = 0.4;
export const TILEABILITY_WEIGHT = 0.6;
/** Subtracted from finalScore when cutoutSwatchDetected - a naive tileability score can be fooled by a uniform background, so a genuine full-bleed candidate should win even if its raw tileability is lower. */
export const CUTOUT_SWATCH_SCORE_PENALTY = 50;

export const SCORE_WEIGHTS = {
  resolutionThresholdPx: 1500,
  resolutionBonus: 30,
  aspectRatioTolerance: 0.15, // within 15% of a 1:1 ratio
  aspectRatioBonus: 15,
  textureKeywordBonus: 50,
  tileKeywordBonus: 30,
  sampleKeywordBonus: 20,
  roomScenePenalty: -40,
  furniturePenalty: -100,
  perspectiveProxyPenalty: -70,
} as const;

export const KEYWORDS = {
  texture: ["texture"],
  tile: ["tile"],
  // "swatch" deliberately excluded - in practice it labels cutout product-card thumbnails
  // (irregular sample on a white background), not full-bleed material photos, and caused
  // exactly that kind of image to outrank the real texture for a real product page.
  sample: ["sample"],
  roomScene: [
    "room",
    "kitchen",
    "bedroom",
    "bathroom",
    "living",
    "lifestyle",
    "interior",
    "hall",
    "dining",
  ],
  // Heuristic keyword proxy for "contains furniture" - no real object detection in v1.
  furniture: ["furniture", "sofa", "couch", "chair", "table", "decor", "cabinet"],
  // Heuristic keyword proxy for "perspective detected" at the pre-download scoring stage.
  perspectiveProxy: ["installed", "roomscene", "room-scene", "perspective", "angle"],
} as const;
