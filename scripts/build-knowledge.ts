/**
 * build-knowledge.ts
 *
 * Crawls puregroundscoffee.com (sitemap.xml + Shopify JSON endpoints + page/
 * blog/collection HTML) and writes a single, human-reviewable knowledge doc
 * to knowledge/site-knowledge.md. This is a dev-only Node script (run with
 * `npm run build:knowledge`) -- it is never bundled into the Worker.
 *
 * Re-run this whenever the store's products/pages/blog content changes, then
 * hand-review the diff before committing (see Build-Plan-Chatbot.md).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const SITE = "https://puregroundscoffee.com";
const USER_AGENT =
  "PureGroundsCoffeeChatbot-KnowledgeBuilder/1.0 (+https://chatbot.puregroundscoffee.com; contact: hello@puregroundscoffee.com)";
const REQUEST_DELAY_MS = 250;
const FETCH_TIMEOUT_MS = 15_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "knowledge", "site-knowledge.md");

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    await sleep(REQUEST_DELAY_MS);
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.warn(`  [skip] ${res.status} ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`  [skip] ${url} -- ${(err as Error).message}`);
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const text = await fetchText(url);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    console.warn(`  [skip] invalid JSON at ${url}`);
    return null;
  }
}

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/g)].map((m) => m[1]!.trim());
}

// ---------------------------------------------------------------------------
// HTML -> text extraction
//
// Dawn (the Shopify theme this store uses) renders rich text/prose inside
// `.rte` blocks (About Us, policies, blog articles, collection descriptions).
// We prefer that; if a page has none, fall back to <main>.
// ---------------------------------------------------------------------------

// Selectors for Dawn theme chrome/noise that never belongs in prose content:
// nav, forms, price widgets, sold-count badges, screen-reader-only spans, etc.
const NOISE_SELECTORS =
  "script, style, noscript, svg, header, footer, nav, form, " +
  ".cart-drawer, #cart-drawer, .cart-notification, .price, .visually-hidden, " +
  ".badge, .quick-add, .slider-counter, .sold-count, [aria-hidden='true'], " +
  ".product-grid, .card__badge, .rating";

// A "size" variant-picker label (e.g. "5kg, 10kg, 20kg Bundles") that leaks
// into the page's .rte content next to each embedded bundle product card.
// It carries no information once the actual per-variant prices are already
// captured from the product JSON, so drop repeats of it entirely.
const NOISE_LINE_PATTERNS = [/^(\d+(\.\d+)?(kg|g),?\s*)+bundles?$/i];

function collapseWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line && !NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n\n");
}

/**
 * @param allowMainFallback Falling back to <main> is useful for pages/blog
 *   articles that don't wrap prose in `.rte`, but on collection pages with no
 *   description it just dumps the noisy product grid -- so collections pass
 *   `false` and simply return empty text when there's no `.rte` block.
 */
function htmlToText(html: string, allowMainFallback = true): { title: string; text: string } {
  const $ = cheerio.load(html);
  $(NOISE_SELECTORS).remove();

  const title = $("h1").first().text().trim() || $("title").text().replace(/\s*[|\u2013-].*$/, "").trim();

  let $content = $(".rte");
  if ($content.length === 0 && allowMainFallback) $content = $("main");
  if ($content.length === 0 && allowMainFallback) $content = $("body");

  const text = collapseWhitespace($content.map((_, el) => $(el).text()).get().join("\n\n"));

  return { title, text };
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

interface ShopifyVariant {
  id: number;
  title: string;
  price: string;
  sku?: string;
}

/**
 * The `{handle}.json` product endpoint (used below for descriptions/prices)
 * does NOT include stock availability. `/collections/all/products.json`
 * does include a real `available` flag per variant, so we fetch that
 * separately and merge it in by variant id.
 */
async function fetchAvailabilityMap(): Promise<Map<number, boolean>> {
  const map = new Map<number, boolean>();
  const data = await fetchJson<{ products: { variants: { id: number; available: boolean }[] }[] }>(
    `${SITE}/collections/all/products.json?limit=250`,
  );
  for (const product of data?.products ?? []) {
    for (const variant of product.variants) {
      map.set(variant.id, variant.available);
    }
  }
  return map;
}

interface ShopifyProduct {
  title: string;
  handle: string;
  body_html: string;
  product_type: string;
  // Shopify's storefront {handle}.json returns tags as a comma-separated
  // string; other Shopify JSON endpoints sometimes return an array. Handle both.
  tags: string | string[];
  variants: ShopifyVariant[];
}

function normalizeTags(tags: string | string[] | undefined): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((t) => t.trim()).filter(Boolean);
  return tags.split(",").map((t) => t.trim()).filter(Boolean);
}

async function buildProductsSection(productUrls: string[]): Promise<string> {
  const availabilityMap = await fetchAvailabilityMap();
  const blocks: string[] = [];
  for (const url of productUrls) {
    const jsonUrl = `${url}.json`;
    const data = await fetchJson<{ product: ShopifyProduct }>(jsonUrl);
    if (!data?.product) continue;
    const p = data.product;
    const tags = normalizeTags(p.tags);
    const { text: description } = htmlToText(`<div class="rte">${p.body_html || ""}</div>`);
    const prices = p.variants.map((v) => Number(v.price)).filter((n) => !Number.isNaN(n));
    const priceLine =
      prices.length > 0
        ? prices.length > 1 && Math.min(...prices) !== Math.max(...prices)
          ? `PHP ${Math.min(...prices).toFixed(2)} - PHP ${Math.max(...prices).toFixed(2)}`
          : `PHP ${prices[0]!.toFixed(2)}`
        : "price unavailable";
    // Fall back to "unknown" (rather than assuming in/out of stock) if this
    // variant id wasn't found in /collections/all/products.json.
    const isAvailable = (v: ShopifyVariant) => availabilityMap.get(v.id);
    const anyKnownAvailable = p.variants.some((v) => isAvailable(v) === true);
    const allKnownUnavailable = p.variants.every((v) => isAvailable(v) === false);
    const availability = anyKnownAvailable ? "In stock" : allKnownUnavailable ? "Out of stock" : "Unknown -- verify on site";
    const variantLines = p.variants
      .map((v) => {
        const avail = isAvailable(v);
        const suffix = avail === false ? " (out of stock)" : avail === undefined ? " (stock unknown)" : "";
        return `  - ${v.title}: PHP ${Number(v.price).toFixed(2)}${suffix}`;
      })
      .join("\n");

    blocks.push(
      [
        `### ${p.title}`,
        `- URL: ${url}`,
        `- Type: ${p.product_type || "n/a"}`,
        tags.length ? `- Tags: ${tags.join(", ")}` : null,
        `- Price: ${priceLine}`,
        `- Availability: ${availability}`,
        p.variants.length > 1 ? `- Variants:\n${variantLines}` : null,
        description ? `- Description: ${description}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    console.log(`  [ok] product: ${p.title}`);
  }
  return blocks.join("\n\n");
}

// This doc goes into the system prompt on every single chat request, so very
// long boilerplate (e.g. a full Terms of Service) is pure wasted cost/latency
// for content customers almost never ask about verbatim. Cap it and point
// back to the source URL for the rest, rather than dropping it entirely.
// Business-relevant pages (About, Business Bundles, pricing) get a much
// higher cap since that content directly answers real customer questions;
// legal boilerplate (policies) gets the tight default.
const MAX_SECTION_CHARS_DEFAULT = 4000;
const MAX_SECTION_CHARS_PAGE = 9000;

function capLength(text: string, url: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...\n\n[Truncated for brevity -- full text at ${url}]`;
}

async function buildHtmlPagesSection(
  urls: string[],
  label: string,
  allowMainFallback = true,
  maxChars = MAX_SECTION_CHARS_DEFAULT,
): Promise<string> {
  const blocks: string[] = [];
  for (const url of urls) {
    const html = await fetchText(url);
    if (!html) continue;
    const { title, text } = htmlToText(html, allowMainFallback);
    if (!text) {
      console.log(`  [skip] ${label}: ${title || url} -- no descriptive text found`);
      continue;
    }
    blocks.push(`### ${title || url}\n- URL: ${url}\n\n${capLength(text, url, maxChars)}`);
    console.log(`  [ok] ${label}: ${title || url}`);
  }
  return blocks.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Fetching sitemap index from ${SITE}/sitemap.xml ...`);
  const indexXml = await fetchText(`${SITE}/sitemap.xml`);
  if (!indexXml) throw new Error("Could not fetch sitemap.xml -- aborting.");
  const subSitemaps = extractLocs(indexXml);

  const productsSitemap = subSitemaps.find((u) => u.includes("sitemap_products"));
  const pagesSitemap = subSitemaps.find((u) => u.includes("sitemap_pages"));
  const collectionsSitemap = subSitemaps.find((u) => u.includes("sitemap_collections"));
  const blogsSitemap = subSitemaps.find((u) => u.includes("sitemap_blogs"));

  const [productsXml, pagesXml, collectionsXml, blogsXml] = await Promise.all([
    productsSitemap ? fetchText(productsSitemap) : null,
    pagesSitemap ? fetchText(pagesSitemap) : null,
    collectionsSitemap ? fetchText(collectionsSitemap) : null,
    blogsSitemap ? fetchText(blogsSitemap) : null,
  ]);

  const productUrls = productsXml ? extractLocs(productsXml).filter((u) => u.includes("/products/")) : [];
  const pageUrls = pagesXml ? extractLocs(pagesXml).filter((u) => u.includes("/pages/")) : [];
  const collectionUrls = collectionsXml
    ? extractLocs(collectionsXml).filter((u) => u.includes("/collections/"))
    : [];
  // The blog sitemap mixes the blog index and individual article URLs --
  // articles have an extra path segment after the blog handle.
  const blogUrls = blogsXml
    ? extractLocs(blogsXml).filter((u) => /\/blogs\/[^/]+\/[^/]+$/.test(u))
    : [];

  console.log(
    `Found ${productUrls.length} products, ${pageUrls.length} pages, ${collectionUrls.length} collections, ${blogUrls.length} blog articles.`,
  );

  console.log("\nFetching products...");
  const productsSection = await buildProductsSection(productUrls);

  console.log("\nFetching collections...");
  const collectionsSection = await buildHtmlPagesSection(collectionUrls, "collection", false);

  console.log("\nFetching pages (About Us, Business Bundles, Contact, etc.)...");
  const pagesSection = await buildHtmlPagesSection(pageUrls, "page", true, MAX_SECTION_CHARS_PAGE);

  console.log("\nFetching policies...");
  const policyUrls = [
    `${SITE}/policies/privacy-policy`,
    `${SITE}/policies/terms-of-service`,
    `${SITE}/policies/refund-policy`,
  ];
  const policiesSection = await buildHtmlPagesSection(policyUrls, "policy");

  console.log("\nFetching Coffee Guides blog articles (tone/voice source)...");
  const blogSection = await buildHtmlPagesSection(blogUrls, "blog");

  const generatedAt = new Date().toISOString();
  const manifest = [
    `- Generated: ${generatedAt}`,
    `- Source: ${SITE}`,
    `- Products crawled: ${productUrls.length}`,
    `- Collections crawled: ${collectionUrls.length}`,
    `- Pages crawled: ${pageUrls.length}`,
    `- Policies crawled: ${policyUrls.length}`,
    `- Blog articles crawled: ${blogUrls.length}`,
    "",
    "Re-run `npm run build:knowledge` to refresh this file, then hand-review",
    "the diff before committing (see Build-Plan-Chatbot.md, checklist item 3).",
  ].join("\n");

  const doc = `# Pure Grounds Coffee Co. -- Site Knowledge

> Auto-generated by \`scripts/build-knowledge.ts\`. Do not hand-edit facts here
> without also updating the source page on puregroundscoffee.com, or your
> edits will be overwritten on the next crawl. Tone/voice guidance lives in
> \`knowledge/brand-voice.md\`, not here.

## Manifest

${manifest}

## Company / About / Contact / Business Bundles

${pagesSection}

## Store Policies

${policiesSection}

## Collections

${collectionsSection}

## Products

${productsSection}

## Coffee Guides (blog) -- product/brewing knowledge

${blogSection}
`;

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, doc, "utf-8");
  console.log(`\nWrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
