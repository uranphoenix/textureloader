import sharp from "sharp";
import type { Sharp } from "sharp";

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

async function toRaw(filePath: string): Promise<RawImage> {
  const { data, info } = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function offsetWrap(img: RawImage): RawImage {
  const { data, width, height, channels } = img;
  const out = Buffer.alloc(data.length);
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  for (let y = 0; y < height; y++) {
    const srcY = (y + halfH) % height;
    for (let x = 0; x < width; x++) {
      const srcX = (x + halfW) % width;
      const srcIdx = (srcY * width + srcX) * channels;
      const dstIdx = (y * width + x) * channels;
      for (let c = 0; c < channels; c++) {
        out[dstIdx + c] = data[srcIdx + c] ?? 0;
      }
    }
  }
  return { data: out, width, height, channels };
}

/** Feather-blends a band around the center seam line on the given axis, pulling each side toward the other. */
function blendAxis(img: RawImage, axis: "x" | "y", bandFraction: number): RawImage {
  const { data, width, height, channels } = img;
  const out = Buffer.from(data);
  const size = axis === "x" ? width : height;
  const center = Math.floor(size / 2);
  const bandWidth = Math.max(2, Math.round(size * bandFraction));
  const getIdx = (x: number, y: number): number => (y * width + x) * channels;

  for (let d = 0; d < bandWidth; d++) {
    const lo = center - 1 - d;
    const hi = center + d;
    if (lo < 0 || hi >= size) continue;
    const weight = (1 - d / bandWidth) * 0.5;

    const pairs: [number, number][] = [];
    if (axis === "x") {
      for (let y = 0; y < height; y++) pairs.push([getIdx(lo, y), getIdx(hi, y)]);
    } else {
      for (let x = 0; x < width; x++) pairs.push([getIdx(x, lo), getIdx(x, hi)]);
    }

    for (const [loIdx, hiIdx] of pairs) {
      for (let c = 0; c < channels; c++) {
        const loVal = data[loIdx + c] ?? 0;
        const hiVal = data[hiIdx + c] ?? 0;
        out[loIdx + c] = Math.round(loVal + (hiVal - loVal) * weight);
        out[hiIdx + c] = Math.round(hiVal + (loVal - hiVal) * weight);
      }
    }
  }

  return { data: out, width, height, channels };
}

const SEAM_BAND_FRACTION = 0.06;

/**
 * Classical seamless-tiling generation (Step 4): offsetting the image by half its size (wrapping
 * around) moves the original left/right and top/bottom edge discontinuities into a cross through
 * the center; feather-blending a band around that cross hides the seam. The seam location is
 * deterministic given the offset, so there's no separate "detect seam" step - it's implicit in
 * the geometry, not a CV search.
 */
export async function makeSeamless(filePath: string): Promise<Sharp> {
  const original = await toRaw(filePath);
  const offset = offsetWrap(original);
  const blendedX = blendAxis(offset, "x", SEAM_BAND_FRACTION);
  const blendedY = blendAxis(blendedX, "y", SEAM_BAND_FRACTION);

  return sharp(blendedY.data, {
    raw: { width: blendedY.width, height: blendedY.height, channels: blendedY.channels as 1 | 2 | 3 | 4 },
  });
}
