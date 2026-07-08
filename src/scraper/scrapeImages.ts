import type { Browser } from "playwright";
import { PAGE_TIMEOUT_MS, SCROLL_STEPS, SCROLL_WAIT_MS, VIEWPORT, USER_AGENT } from "../config.js";
import type { ImageCandidate } from "../types.js";
import { assetKeyFromUrl } from "../utils/url.js";

/**
 * Scrapes every candidate image from a manufacturer product page: <img> (src/srcset/lazy
 * data-* attrs), <picture><source>, CSS background-image, OpenGraph/twitter meta, JSON-LD
 * "image" fields, and anchor hrefs that point directly at an image file.
 *
 * Deliberately passive/DOM-based only - does not click into lightboxes or call gallery APIs.
 * If a manufacturer hides full-res images behind a click-triggered fetch, this won't see them
 * and that site would need a small dedicated adapter (not implemented here).
 */
export async function scrapeImages(browser: Browser, pageUrl: string): Promise<ImageCandidate[]> {
  const context = await browser.newContext({ viewport: VIEWPORT, userAgent: USER_AGENT, locale: "en-US" });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });

    // Trigger IntersectionObserver-based lazy loaders by scrolling through the whole page.
    await page.evaluate(
      async ({ steps, waitMs }) => {
        const scrollHeight = document.body.scrollHeight;
        for (let i = 0; i <= steps; i++) {
          window.scrollTo(0, (scrollHeight * i) / steps);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        window.scrollTo(0, 0);
      },
      { steps: SCROLL_STEPS, waitMs: SCROLL_WAIT_MS },
    );

    await page.waitForLoadState("networkidle", { timeout: PAGE_TIMEOUT_MS }).catch(() => undefined);

    const candidates = await page.evaluate(() => {
      type RawCandidate = {
        url: string;
        kind:
          | "img"
          | "srcset"
          | "picture-source"
          | "background-image"
          | "og-image"
          | "json-ld"
          | "data-src"
          | "anchor-href";
        declaredWidth?: number | undefined;
        declaredHeight?: number | undefined;
        alt?: string | undefined;
        context?: string | undefined;
      };

      const results: RawCandidate[] = [];
      const LAZY_ATTRS = [
        "data-src",
        "data-lazy-src",
        "data-original",
        "data-zoom-image",
        "data-large_image",
        "data-full",
        "data-hires",
      ];
      const IMAGE_EXT_RE = /\.(jpe?g|png|webp|avif|gif)(\?.*)?$/i;
      const pageContext = `${document.title} ${location.pathname}`.toLowerCase();

      function resolve(url: string): string | null {
        try {
          return new URL(url, document.baseURI).href;
        } catch {
          return null;
        }
      }

      function nearbyContext(el: Element): string {
        const parts: string[] = [pageContext];
        let node: Element | null = el;
        for (let depth = 0; node && depth < 4; depth++) {
          if (typeof node.className === "string" && node.className) parts.push(node.className);
          node = node.parentElement;
        }
        const alt = el.getAttribute("alt") ?? el.getAttribute("title");
        if (alt) parts.push(alt);
        return parts.join(" ").toLowerCase();
      }

      function parseSrcset(srcset: string): { url: string; width?: number | undefined }[] {
        const out: { url: string; width?: number | undefined }[] = [];
        for (const rawEntry of srcset.split(",")) {
          const entry = rawEntry.trim();
          if (!entry) continue;
          const [rawUrl, descriptor] = entry.split(/\s+/);
          const resolved = rawUrl ? resolve(rawUrl) : null;
          if (!resolved) continue;
          const widthMatch = descriptor?.match(/^(\d+)w$/);
          const width = widthMatch?.[1] ? Number(widthMatch[1]) : undefined;
          out.push({ url: resolved, width });
        }
        return out;
      }

      // <img> tags: loaded src, srcset variants, and common lazy-load data-* attrs.
      for (const img of Array.from(document.querySelectorAll("img"))) {
        const context = nearbyContext(img);
        const alt = img.alt || undefined;

        if (img.currentSrc && !img.currentSrc.startsWith("data:")) {
          results.push({
            url: img.currentSrc,
            kind: "img",
            declaredWidth: img.naturalWidth || undefined,
            declaredHeight: img.naturalHeight || undefined,
            alt,
            context,
          });
        }

        const srcset = img.getAttribute("srcset");
        if (srcset) {
          for (const { url, width } of parseSrcset(srcset)) {
            results.push({ url, kind: "srcset", declaredWidth: width, alt, context });
          }
        }

        for (const attr of LAZY_ATTRS) {
          const val = img.getAttribute(attr);
          const resolved = val ? resolve(val) : null;
          if (resolved) results.push({ url: resolved, kind: "data-src", alt, context });
        }
      }

      // <picture><source srcset>
      for (const source of Array.from(document.querySelectorAll("picture source"))) {
        const srcset = source.getAttribute("srcset");
        if (!srcset) continue;
        const context = nearbyContext(source);
        for (const { url, width } of parseSrcset(srcset)) {
          results.push({ url, kind: "picture-source", declaredWidth: width, context });
        }
      }

      // CSS background-image (computed style already resolves to absolute URLs).
      const allElements = document.querySelectorAll("*");
      const maxScan = Math.min(allElements.length, 5000);
      for (let i = 0; i < maxScan; i++) {
        const el = allElements[i];
        if (!el) continue;
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === "none") continue;
        for (const match of bg.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
          const raw = match[2];
          const resolved = raw ? resolve(raw) : null;
          if (resolved && !resolved.startsWith("data:")) {
            results.push({ url: resolved, kind: "background-image", context: nearbyContext(el) });
          }
        }
      }

      // OpenGraph / twitter meta images.
      for (const meta of Array.from(
        document.querySelectorAll(
          'meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]',
        ),
      )) {
        const content = meta.getAttribute("content");
        const resolved = content ? resolve(content) : null;
        if (resolved) results.push({ url: resolved, kind: "og-image", context: pageContext });
      }

      // JSON-LD "image" fields (string, array of strings, or {url: ...} objects).
      function collectJsonLdImages(node: unknown, out: string[]): void {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const item of node) collectJsonLdImages(item, out);
          return;
        }
        const obj = node as Record<string, unknown>;
        if (typeof obj.image === "string") out.push(obj.image);
        else if (Array.isArray(obj.image)) {
          for (const img of obj.image) {
            if (typeof img === "string") out.push(img);
            else if (img && typeof img === "object" && typeof (img as { url?: unknown }).url === "string") {
              out.push((img as { url: string }).url);
            }
          }
        } else if (obj.image && typeof obj.image === "object") {
          const url = (obj.image as { url?: unknown }).url;
          if (typeof url === "string") out.push(url);
        }
        for (const value of Object.values(obj)) {
          if (value && typeof value === "object") collectJsonLdImages(value, out);
        }
      }

      for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try {
          const parsed: unknown = JSON.parse(script.textContent ?? "");
          const urls: string[] = [];
          collectJsonLdImages(parsed, urls);
          for (const url of urls) {
            const resolved = resolve(url);
            if (resolved) results.push({ url: resolved, kind: "json-ld", context: pageContext });
          }
        } catch {
          // malformed JSON-LD - ignore
        }
      }

      // Anchors wrapping a thumbnail that link directly to a full-res image (common gallery pattern).
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = anchor.getAttribute("href");
        if (!href || !IMAGE_EXT_RE.test(href)) continue;
        const resolved = resolve(href);
        if (resolved) results.push({ url: resolved, kind: "anchor-href", context: nearbyContext(anchor) });
      }

      return results;
    });

    // Dedupe by URL, keeping the entry with the most declared metadata (prefer larger declaredWidth).
    const byUrl = new Map<string, ImageCandidate>();
    for (const candidate of candidates) {
      const existing = byUrl.get(candidate.url);
      if (!existing || (candidate.declaredWidth ?? 0) > (existing.declaredWidth ?? 0)) {
        byUrl.set(candidate.url, { ...existing, ...candidate });
      } else {
        byUrl.set(candidate.url, { ...candidate, ...existing });
      }
    }

    // Dedupe again by "same underlying asset, different resizing-CDN query params" (e.g. the
    // same photo requested at w=120 and w=840) - keeps just the largest-declared variant per
    // asset, so near-duplicate thumbnails of one picture don't crowd distinct images out of the
    // top-K candidates that actually get downloaded and CV-analyzed.
    const byAsset = new Map<string, ImageCandidate>();
    for (const candidate of byUrl.values()) {
      const key = assetKeyFromUrl(candidate.url);
      const existing = byAsset.get(key);
      if (!existing || (candidate.declaredWidth ?? 0) > (existing.declaredWidth ?? 0)) {
        byAsset.set(key, candidate);
      }
    }

    return Array.from(byAsset.values());
  } finally {
    await context.close();
  }
}
