export function resolveUrl(base: string, maybeRelative: string): string | null {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

export function filenameFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    return decodeURIComponent(pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}

export function extensionFromUrl(url: string): string {
  const filename = filenameFromUrl(url);
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * Identifies "the same underlying image" served at different sizes via resizing-CDN query
 * params (Widen, Cloudinary, imgix, Shopify, etc. all follow this pattern) - i.e. same origin
 * + path, different query string. Used to collapse redundant size variants of one asset down to
 * a single candidate before scoring, so a handful of thumbnails of the same picture don't crowd
 * out genuinely different images from the top-K.
 */
export function assetKeyFromUrl(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return url;
  }
}
