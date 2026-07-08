import fs from "fs-extra";
import path from "node:path";
import { imageSize } from "image-size";
import mime from "mime-types";
import { DOWNLOAD_TMP_DIR, USER_AGENT } from "../config.js";
import { extensionFromUrl } from "../utils/url.js";
import type { ScoredImageCandidate, DownloadedImage } from "../types.js";

/** Downloads one candidate's original bytes and verifies it's actually an image. Returns null (not throws) on any failure so the pipeline can just skip a bad candidate and try the next one. */
export async function downloadCandidate(
  candidate: ScoredImageCandidate,
  rowId: string,
  index: number,
): Promise<DownloadedImage | null> {
  let response: Response;
  try {
    response = await fetch(candidate.url, {
      headers: { "User-Agent": USER_AGENT },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const contentType = response.headers.get("content-type") ?? (mime.lookup(candidate.url) || "");
  if (!contentType.startsWith("image/")) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  const dims = imageSize(buffer);
  if (!dims.width || !dims.height) return null;

  await fs.ensureDir(DOWNLOAD_TMP_DIR);
  const ext = extensionFromUrl(candidate.url) || mime.extension(contentType) || "jpg";
  const filePath = path.join(DOWNLOAD_TMP_DIR, `${rowId}-${index}.${ext}`);
  await fs.writeFile(filePath, buffer);

  return {
    ...candidate,
    filePath,
    bytes: buffer.byteLength,
    width: dims.width,
    height: dims.height,
    contentType,
  };
}
