import sharp from "sharp";
import fs from "fs-extra";
import path from "node:path";
import {
  PREVIEW_SIZE,
  PREVIEW_CORNER_RADIUS,
  PREVIEW_BACKGROUND,
  PREVIEW_CROP_OFFSET_FRACTION,
} from "../config.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Builds a rounded-corner preview: a single off-center cropped cutout of the optimized texture at
 * native resolution, not a resized-down thumbnail or a repeating tile grid - shows real material
 * grain instead of a blurry whole-image downsize. Deliberately off-center (see
 * PREVIEW_CROP_OFFSET_FRACTION) rather than dead-center, to avoid the seamless step's blend band.
 * Three.js sphere preview is explicitly deferred to a later version.
 */
export async function generatePreview(textureFilePath: string, outputPath: string): Promise<void> {
  await fs.ensureDir(path.dirname(outputPath));

  const metadata = await sharp(textureFilePath).metadata();
  const sourceWidth = metadata.width ?? PREVIEW_SIZE;
  const sourceHeight = metadata.height ?? PREVIEW_SIZE;
  const cropSize = Math.min(PREVIEW_SIZE, sourceWidth, sourceHeight);
  const left = clamp(
    Math.round(sourceWidth * PREVIEW_CROP_OFFSET_FRACTION - cropSize / 2),
    0,
    sourceWidth - cropSize,
  );
  const top = clamp(
    Math.round(sourceHeight * PREVIEW_CROP_OFFSET_FRACTION - cropSize / 2),
    0,
    sourceHeight - cropSize,
  );

  const cropBuffer = await sharp(textureFilePath)
    .extract({ left, top, width: cropSize, height: cropSize })
    .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: "cover" }) // no-op once cropSize already equals PREVIEW_SIZE
    .png()
    .toBuffer();

  const roundedMask = Buffer.from(
    `<svg width="${PREVIEW_SIZE}" height="${PREVIEW_SIZE}"><rect x="0" y="0" width="${PREVIEW_SIZE}" height="${PREVIEW_SIZE}" rx="${PREVIEW_CORNER_RADIUS}" ry="${PREVIEW_CORNER_RADIUS}" fill="#fff"/></svg>`,
  );

  // Materialize the masked (transparent-corner) image to a real buffer before flattening in a
  // separate pipeline - chaining composite(dest-in) straight into flatten() in one sharp pipeline
  // silently no-ops (the alpha channel survives), which left non-zero RGB under alpha=0 corner
  // pixels and showed up as fringing once lossy webp re-encoded that "invisible" color data.
  const maskedBuffer = await sharp(cropBuffer)
    .composite([{ input: roundedMask, blend: "dest-in" }])
    .png()
    .toBuffer();

  await sharp(maskedBuffer).flatten({ background: PREVIEW_BACKGROUND }).webp({ quality: 90 }).toFile(outputPath);
}
