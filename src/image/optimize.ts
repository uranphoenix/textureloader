import fs from "fs-extra";
import path from "node:path";
import type { Sharp } from "sharp";
import { TEXTURE_MAX_DIMENSION } from "../config.js";

/** Center-crops to square and resizes/encodes to webp, capped at TEXTURE_MAX_DIMENSION. */
export async function optimizeTexture(
  pipeline: Sharp,
  outputPath: string,
): Promise<{ width: number; height: number }> {
  await fs.ensureDir(path.dirname(outputPath));
  const metadata = await pipeline.clone().metadata();
  const shortSide = Math.min(metadata.width ?? TEXTURE_MAX_DIMENSION, metadata.height ?? TEXTURE_MAX_DIMENSION);
  const targetSide = Math.min(shortSide, TEXTURE_MAX_DIMENSION);

  const info = await pipeline
    .clone()
    .resize({ width: targetSide, height: targetSide, fit: "cover", position: "centre" })
    .webp({ quality: 90 })
    .toFile(outputPath);

  return { width: info.width, height: info.height };
}
