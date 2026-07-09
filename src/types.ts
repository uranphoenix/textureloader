/**
 * Different source_*.json files use quite different column sets (flooring has "Pile thikness,
 * inch"/"Item Number"; cabinetry has "Material"/"Texture"/"Finish"/"Color"; countertops has a
 * flat "Price/per kitchen + bathrooms" instead of per-SF pricing; tiles reuses "Category" to mean
 * a color group, not a material type). Only Code and Link are guaranteed present across all of
 * them - everything else is looked up defensively where used.
 */
export type SourceRow = {
  Code: string;
  Link: string;
} & Record<string, unknown>;

export type ImageSourceKind =
  | "img"
  | "srcset"
  | "picture-source"
  | "background-image"
  | "og-image"
  | "json-ld"
  | "data-src"
  | "anchor-href";

export interface ImageCandidate {
  url: string;
  kind: ImageSourceKind;
  declaredWidth?: number | undefined;
  declaredHeight?: number | undefined;
  alt?: string | undefined;
  /** Lowercased, space-joined class names / nearby text used for keyword scoring. */
  context?: string | undefined;
}

export interface ScoreBreakdown {
  [reason: string]: number;
}

export interface ScoredImageCandidate extends ImageCandidate {
  score: number;
  scoreBreakdown: ScoreBreakdown;
}

export interface DownloadedImage extends ScoredImageCandidate {
  filePath: string;
  bytes: number;
  width: number;
  height: number;
  contentType: string;
}

export interface TextureAnalysis {
  /** 0-100, higher = more seamlessly tileable */
  tileability: number;
  /** Shannon entropy of grayscale histogram, roughly 0-8 */
  entropy: number;
  /** 0-100, higher = more uniform lighting across the image */
  lightingUniformity: number;
  /** Dominant gradient orientation in degrees [0,180), null if no clear direction */
  dominantDirectionDeg: number | null;
  /** Heuristic only - approximated from gradient/vanishing-line analysis, not a true perspective solve */
  perspectiveDetected: boolean;
  /** Heuristic only - localized dark/low-saturation region detection */
  shadowDetected: boolean;
  /** Heuristic only - flags "swatch card" product photography (cutout sample on a flat background with a drop shadow) rather than a full-bleed material photo. Such images can score deceptively high on tileability. */
  cutoutSwatchDetected: boolean;
}

export interface AnalyzedCandidate extends DownloadedImage {
  analysis: TextureAnalysis;
  finalScore: number;
}

export interface MaterialSpecs {
  thicknessIn?: string;
  pileThicknessIn?: number;
  sizeFt?: string | number;
  padPricePerSY?: number;
  totalArea900SF?: number;
  totalCarpetPlusPad?: number;
  /** Passthrough for any other source-file-specific field (Finish, Color, Texture, Country, per-box pricing, etc.) not already lifted to a named property above. */
  [key: string]: string | number | undefined;
}

export interface MaterialMetadata {
  id: string;
  name: string;
  "item number": string | number;
  category: string;
  manufacturer: string;
  preview: string;
  texture: string;
  resolution: number;
  tileability: number;
  source: string;
  created: string;
  tags: string[];
  pricesf: number | "";
  specs?: MaterialSpecs;
  /** Machine-readable review flags, e.g. "cutout-swatch" - present only when something needs a human look. */
  flags?: string[];
}
