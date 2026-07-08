import sharp from "sharp";
import type { TextureAnalysis } from "../types.js";

/**
 * Classical (non-ML) texture analysis via sharp pixel buffers - Step 3 of the pipeline.
 *
 * Tileability combines edge-continuity across the wrap boundary with lighting uniformity, then
 * gets penalized if the perspective heuristic fires. Perspective and dominant-direction detection
 * are both approximated from a Sobel gradient-direction histogram, not a true line/vanishing-point
 * solve - good enough to separate "flat product swatch" from "room photo with converging lines",
 * but not a rigorous perspective estimator.
 */

const EDGE_ANALYSIS_SIZE = 256;
const GRADIENT_ANALYSIS_SIZE = 128;
const LIGHTING_GRID = 4;

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function loadRawRGB(filePath: string, size: number): Promise<RawImage> {
  const { data, info } = await sharp(filePath)
    .resize(size, size, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

async function loadRawGray(filePath: string, size: number): Promise<RawImage> {
  const { data, info } = await sharp(filePath)
    .resize(size, size, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function computeEntropy(gray: Buffer): number {
  const histogram = new Array(256).fill(0);
  for (const value of gray) histogram[value] = (histogram[value] ?? 0) + 1;
  const total = gray.length;
  let entropy = 0;
  for (const count of histogram) {
    if (count === 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Mean abs pixel difference between opposite edges (left/right, top/bottom), mapped to a 0-100 score. */
function computeEdgeContinuity(rgb: RawImage): number {
  const { data, width, height, channels } = rgb;
  let diffSum = 0;
  let count = 0;

  for (let y = 0; y < height; y++) {
    for (let c = 0; c < channels; c++) {
      const left = data[(y * width + 0) * channels + c] ?? 0;
      const right = data[(y * width + (width - 1)) * channels + c] ?? 0;
      diffSum += Math.abs(left - right);
      count++;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let c = 0; c < channels; c++) {
      const top = data[(0 * width + x) * channels + c] ?? 0;
      const bottom = data[((height - 1) * width + x) * channels + c] ?? 0;
      diffSum += Math.abs(top - bottom);
      count++;
    }
  }

  const meanDiff = diffSum / count; // 0-255
  return clamp(100 * (1 - meanDiff / 128), 0, 100);
}

interface RegionStats {
  mean: [number, number, number];
  stdDev: number;
}

function computeRegionStats(rgb: RawImage, x0: number, x1: number, y0: number, y1: number): RegionStats {
  const { data, width, channels } = rgb;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * width + x) * channels;
      sumR += data[idx] ?? 0;
      sumG += data[idx + 1] ?? 0;
      sumB += data[idx + 2] ?? 0;
      count++;
    }
  }
  const mean: [number, number, number] = [sumR / count, sumG / count, sumB / count];

  let varSum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * width + x) * channels;
      const dr = (data[idx] ?? 0) - mean[0];
      const dg = (data[idx + 1] ?? 0) - mean[1];
      const db = (data[idx + 2] ?? 0) - mean[2];
      varSum += dr * dr + dg * dg + db * db;
    }
  }
  const stdDev = Math.sqrt(varSum / (count * 3));
  return { mean, stdDev };
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

const CUTOUT_CORNER_FRACTION = 0.08;
const CUTOUT_MAX_CORNER_STDDEV = 14; // corners must be visually flat/uniform (a real texture's corners have grain/weave detail)
const CUTOUT_MAX_INTER_CORNER_DISTANCE = 20; // all 4 corners must agree with each other (a consistent background pad)
const CUTOUT_MIN_CORNER_CENTER_DISTANCE = 30; // and that background must differ from the subject in the center

/**
 * Detects "swatch card" product photography - an irregular-edged sample cutout centered on a
 * flat background (usually white) with a drop shadow, as opposed to a full-bleed material photo.
 * This matters because such images can score deceptively high on tileability: white-background-
 * to-white-background edges look "continuous" to the edge-continuity check even though the actual
 * material isn't tileable this way at all. Checks whether all four corners are flat and mutually
 * consistent (a uniform background frame) and distinct in color from the center (the subject).
 */
function detectCutoutSwatch(rgb: RawImage): boolean {
  const { width, height } = rgb;
  const cw = Math.max(4, Math.round(width * CUTOUT_CORNER_FRACTION));
  const ch = Math.max(4, Math.round(height * CUTOUT_CORNER_FRACTION));
  const corners = [
    computeRegionStats(rgb, 0, cw, 0, ch),
    computeRegionStats(rgb, width - cw, width, 0, ch),
    computeRegionStats(rgb, 0, cw, height - ch, height),
    computeRegionStats(rgb, width - cw, width, height - ch, height),
  ];

  const avgCornerStdDev = corners.reduce((a, c) => a + c.stdDev, 0) / corners.length;
  if (avgCornerStdDev > CUTOUT_MAX_CORNER_STDDEV) return false;

  let maxInterCornerDist = 0;
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const a = corners[i];
      const b = corners[j];
      if (!a || !b) continue;
      maxInterCornerDist = Math.max(maxInterCornerDist, colorDistance(a.mean, b.mean));
    }
  }
  if (maxInterCornerDist > CUTOUT_MAX_INTER_CORNER_DISTANCE) return false;

  const centerX0 = Math.round(width * 0.3);
  const centerY0 = Math.round(height * 0.3);
  const center = computeRegionStats(rgb, centerX0, width - centerX0, centerY0, height - centerY0);

  const avgCornerMean: [number, number, number] = [0, 0, 0];
  for (const c of corners) {
    avgCornerMean[0] += c.mean[0] / corners.length;
    avgCornerMean[1] += c.mean[1] / corners.length;
    avgCornerMean[2] += c.mean[2] / corners.length;
  }

  return colorDistance(avgCornerMean, center.mean) > CUTOUT_MIN_CORNER_CENTER_DISTANCE;
}

function computeGridMeans(gray: RawImage, grid: number): number[] {
  const { data, width, height } = gray;
  const cellW = Math.floor(width / grid);
  const cellH = Math.floor(height / grid);
  const means: number[] = [];
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      let sum = 0;
      let n = 0;
      for (let y = gy * cellH; y < (gy + 1) * cellH; y++) {
        for (let x = gx * cellW; x < (gx + 1) * cellW; x++) {
          sum += data[y * width + x] ?? 0;
          n++;
        }
      }
      means.push(n > 0 ? sum / n : 0);
    }
  }
  return means;
}

function computeLightingUniformity(gridMeans: number[]): number {
  const overallMean = gridMeans.reduce((a, b) => a + b, 0) / gridMeans.length;
  const variance = gridMeans.reduce((a, m) => a + (m - overallMean) ** 2, 0) / gridMeans.length;
  const stdDev = Math.sqrt(variance);
  return clamp(100 * (1 - stdDev / 96), 0, 100);
}

function detectShadow(gridMeans: number[]): boolean {
  const overallMean = gridMeans.reduce((a, b) => a + b, 0) / gridMeans.length;
  const darkest = Math.min(...gridMeans);
  return overallMean - darkest > 60;
}

interface SobelResult {
  gx: Float32Array;
  gy: Float32Array;
  mag: Float32Array;
}

function sobel(gray: RawImage): SobelResult {
  const { data, width, height } = gray;
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);
  const mag = new Float32Array(width * height);
  const KX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const KY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

  const at = (x: number, y: number): number => {
    const cx = clamp(x, 0, width - 1);
    const cy = clamp(y, 0, height - 1);
    return data[cy * width + cx] ?? 0;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx = 0;
      let sy = 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = at(x + dx, y + dy);
          sx += v * (KX[k] ?? 0);
          sy += v * (KY[k] ?? 0);
          k++;
        }
      }
      const idx = y * width + x;
      gx[idx] = sx;
      gy[idx] = sy;
      mag[idx] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return { gx, gy, mag };
}

/** Dominant gradient orientation (0-180deg, folded) within a pixel rectangle, magnitude-weighted. */
function dominantDirectionInRegion(
  sobelResult: SobelResult,
  width: number,
  region: { x0: number; x1: number; y0: number; y1: number },
): { angleDeg: number | null; edgeDensity: number } {
  const { gx, gy, mag } = sobelResult;
  const bins = new Array(18).fill(0); // 10-degree bins over 0-180
  let edgeCount = 0;
  let pixelCount = 0;
  const magValues: number[] = [];

  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const idx = y * width + x;
      magValues.push(mag[idx] ?? 0);
    }
  }
  const meanMag = magValues.reduce((a, b) => a + b, 0) / Math.max(1, magValues.length);
  const threshold = meanMag * 1.5;

  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const idx = y * width + x;
      const m = mag[idx] ?? 0;
      pixelCount++;
      if (m < threshold) continue;
      edgeCount++;
      let angle = Math.atan2(gy[idx] ?? 0, gx[idx] ?? 0) * (180 / Math.PI);
      angle = ((angle % 180) + 180) % 180;
      const bin = Math.min(17, Math.floor(angle / 10));
      bins[bin] += m;
    }
  }

  const edgeDensity = pixelCount > 0 ? edgeCount / pixelCount : 0;
  const totalWeight = bins.reduce((a: number, b: number) => a + b, 0);
  if (totalWeight === 0) return { angleDeg: null, edgeDensity };

  let maxBin = 0;
  let maxVal = 0;
  bins.forEach((v: number, i: number) => {
    if (v > maxVal) {
      maxVal = v;
      maxBin = i;
    }
  });
  const avgWeight = totalWeight / bins.length;
  if (maxVal < avgWeight * 1.8) return { angleDeg: null, edgeDensity };
  return { angleDeg: maxBin * 10 + 5, edgeDensity };
}

function circularAngleDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 180;
  return Math.min(diff, 180 - diff);
}

/** Heuristic: a flat tileable swatch has a fairly consistent gradient direction across quadrants; a room photo with converging lines/vanishing points does not. */
function detectPerspective(sobelResult: SobelResult, width: number, height: number): boolean {
  const midX = Math.floor(width / 2);
  const midY = Math.floor(height / 2);
  const quadrants = [
    { x0: 0, x1: midX, y0: 0, y1: midY },
    { x0: midX, x1: width, y0: 0, y1: midY },
    { x0: 0, x1: midX, y0: midY, y1: height },
    { x0: midX, x1: width, y0: midY, y1: height },
  ];

  const results = quadrants.map((region) => dominantDirectionInRegion(sobelResult, width, region));
  const angles = results.map((r) => r.angleDeg).filter((a): a is number => a !== null);
  const avgEdgeDensity = results.reduce((a, r) => a + r.edgeDensity, 0) / results.length;

  if (angles.length < 2) return false; // not enough directional structure to judge

  let maxDist = 0;
  for (let i = 0; i < angles.length; i++) {
    for (let j = i + 1; j < angles.length; j++) {
      maxDist = Math.max(maxDist, circularAngleDistance(angles[i] as number, angles[j] as number));
    }
  }
  return maxDist > 40 && avgEdgeDensity > 0.04;
}

export async function analyzeTexture(filePath: string): Promise<TextureAnalysis> {
  const [rgb, gray] = await Promise.all([
    loadRawRGB(filePath, EDGE_ANALYSIS_SIZE),
    loadRawGray(filePath, GRADIENT_ANALYSIS_SIZE),
  ]);

  const entropy = computeEntropy(gray.data);
  const edgeContinuity = computeEdgeContinuity(rgb);
  const gridMeans = computeGridMeans(gray, LIGHTING_GRID);
  const lightingUniformity = computeLightingUniformity(gridMeans);
  const shadowDetected = detectShadow(gridMeans);

  const sobelResult = sobel(gray);
  const { angleDeg } = dominantDirectionInRegion(sobelResult, gray.width, {
    x0: 0,
    x1: gray.width,
    y0: 0,
    y1: gray.height,
  });
  const perspectiveDetected = detectPerspective(sobelResult, gray.width, gray.height);
  const cutoutSwatchDetected = detectCutoutSwatch(rgb);

  let tileability = 0.7 * edgeContinuity + 0.3 * lightingUniformity;
  if (perspectiveDetected) tileability *= 0.4;
  tileability = Math.round(clamp(tileability, 0, 100));

  return {
    tileability,
    entropy: Number(entropy.toFixed(2)),
    lightingUniformity: Math.round(lightingUniformity),
    dominantDirectionDeg: angleDeg,
    perspectiveDetected,
    shadowDetected,
    cutoutSwatchDetected,
  };
}
