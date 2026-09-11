/**
 * embed-knowledge.ts
 *
 * Chunks knowledge/site-knowledge.md into per-product/per-page/per-article
 * pieces, embeds each with Workers AI (@cf/baai/bge-base-en-v1.5), and
 * (re)builds the "pgc-knowledge" Vectorize index from scratch so the chat
 * path can retrieve just the handful of chunks relevant to a customer's
 * question instead of sending the whole ~68KB file on every request (see
 * src/knowledge.ts).
 *
 * Dev-only Node script (run with `npm run embed:knowledge`), never bundled
 * into the Worker. Run this after `npm run build:knowledge` any time
 * site-knowledge.md changes -- the index has no memory of a previous run,
 * it's fully rebuilt each time so renamed/removed products don't leave
 * stale/orphaned vectors behind.
 *
 * Needs `CLOUDFLARE_API_TOKEN` in the environment (same token `wrangler`
 * itself uses -- run `wrangler whoami` to check) and the wrangler CLI on
 * PATH (uses `wrangler vectorize` under the hood for index management and
 * the upsert itself).
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_KNOWLEDGE_PATH = path.join(__dirname, "..", "knowledge", "site-knowledge.md");

// Note: named "-v2" because the original "pgc-knowledge" name got stuck
// permanently returning zero query matches after a couple of delete/create
// cycles during development (despite successful upserts) -- see
// ensureIndexExists's comment. Never delete+recreate an index by name once
// it's live; if it ever needs nuking, pick a new name.
const INDEX_NAME = "pgc-knowledge-v2";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const EMBED_BATCH_SIZE = 20;
const MAX_CHUNK_CHARS = 1100;

const ACCOUNT_ID = "0feb844d7ff36330cdd00ed24797fe85"; // same as wrangler.jsonc's CF_ACCOUNT_ID
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

// ---------------------------------------------------------------------------
// Markdown -> chunks
// ---------------------------------------------------------------------------

interface KnowledgeChunk {
  id: string;
  /** Text actually embedded *and* injected into the prompt when retrieved. */
  text: string;
  section: string;
  title: string;
  url?: string;
}

interface RawSection {
  h2: string;
  h3: string;
  body: string;
}

/** Splits the doc into (h2, h3, body) triples at `##`/`###` header lines. */
function splitIntoSections(markdown: string): RawSection[] {
  const sections: RawSection[] = [];
  let currentH2 = "";
  let currentH3 = "";
  let bodyLines: string[] = [];

  const flush = () => {
    const body = bodyLines.join("\n").trim();
    if (currentH3 && body) sections.push({ h2: currentH2, h3: currentH3, body });
    bodyLines = [];
  };

  for (const line of markdown.split("\n")) {
    const h2 = /^##\s+(.+)$/.exec(line);
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h2) {
      flush();
      currentH2 = h2[1]!.trim();
      currentH3 = "";
    } else if (h3) {
      flush();
      currentH3 = h3[1]!.trim();
    } else {
      bodyLines.push(line);
    }
  }
  flush();

  // "## Manifest" is crawl metadata (generated timestamp, counts) -- never
  // relevant to a customer question, so it never needs to be retrievable.
  return sections.filter((s) => s.h2 !== "Manifest");
}

/** Splits an oversized section body into ~MAX_CHUNK_CHARS pieces on paragraph boundaries. */
function chunkBody(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return [body];
  const paragraphs = body.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Vectorize vector ids are capped at 64 bytes, and several product titles
 * (e.g. "Mt. Apo Homegrown - Lot #009 3-day Anaerobic Natural") slugify to
 * well over that alone. Truncate the readable slug and disambiguate with a
 * short content hash instead of relying on the full title fitting.
 */
function chunkId(h2: string, h3: string, pieceIndex: number, piece: string): string {
  const slug = `${slugify(h2)}__${slugify(h3)}`.slice(0, 48);
  const hash = createHash("sha1").update(`${h2}__${h3}__${pieceIndex}__${piece}`).digest("hex").slice(0, 10);
  return `${slug}__${hash}`;
}

function buildChunks(markdown: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  for (const section of splitIntoSections(markdown)) {
    const url = /^- URL: (\S+)/m.exec(section.body)?.[1];
    const pieces = chunkBody(section.body);
    pieces.forEach((piece, i) => {
      chunks.push({
        id: chunkId(section.h2, section.h3, i, piece),
        // Keep the heading attached so a chunk reads sensibly in isolation
        // once it's pulled out of the full document and dropped into a
        // system prompt on its own.
        text: `### ${section.h3}\n${piece}`,
        section: section.h2,
        title: section.h3,
        url,
      });
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Embedding (Workers AI REST API -- this script runs outside the Worker, so
// no `env.AI` binding is available; same REST call the Worker's binding
// would make under the hood)
// ---------------------------------------------------------------------------

interface EmbeddingResponse {
  result?: { data?: number[][] };
  success: boolean;
  errors?: { message: string }[];
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ text: texts }),
    },
  );
  const data = (await res.json()) as EmbeddingResponse;
  if (!res.ok || !data.success || !data.result?.data) {
    throw new Error(`Embedding request failed: ${JSON.stringify(data.errors ?? data).slice(0, 300)}`);
  }
  return data.result.data;
}

async function embedAll(chunks: KnowledgeChunk[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    console.log(`  Embedding ${i + 1}-${i + batch.length} of ${chunks.length}...`);
    vectors.push(...(await embedBatch(batch.map((c) => c.text))));
  }
  return vectors;
}

// ---------------------------------------------------------------------------
// Vectorize (via wrangler CLI -- simplest way to both manage the index and
// upsert from a plain Node script without hand-rolling the REST API)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wranglerOnce(args: string[]): string {
  // `shell: true` so this resolves `npx`/`npx.cmd` correctly on Windows too.
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
    shell: true,
  });
}

/**
 * The Vectorize control plane has real propagation lag: an index that was
 * just created (or whose vectors were just upserted) can transiently 404 /
 * report itself as "deleted" / return stale (zero) query results for tens
 * of seconds afterward. Retry transient-looking failures with backoff
 * rather than treating them as real errors.
 */
async function wrangler(args: string[], attempts = 6): Promise<string> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return wranglerOnce(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transient = /index deleted|index name .* \[code: 3005\]|not found/i.test(message);
      if (!transient || attempt === attempts) throw err;
      const delayMs = attempt * 5000;
      console.log(`  (transient Vectorize error, retrying in ${delayMs / 1000}s...)`);
      await sleep(delayMs);
    }
  }
  throw new Error("unreachable");
}

/**
 * Ensures the index exists, without ever deleting/recreating it once it
 * does -- deleting and immediately recreating an index of the same name
 * was observed to leave it permanently returning zero query matches
 * (despite `insert`/`upsert` reporting success and `list-vectors` showing
 * the vectors present), seemingly a backend race between the delete and
 * the following create. Stale vectors from renamed/removed products are
 * cleaned up separately in `removeStaleVectors` instead of nuking the
 * whole index every run.
 */
async function ensureIndexExists(): Promise<void> {
  try {
    await wrangler(["vectorize", "info", INDEX_NAME], 1);
    return; // already exists
  } catch {
    // Doesn't exist yet -- fall through and create it.
  }
  console.log(`Creating Vectorize index "${INDEX_NAME}"...`);
  await wrangler(["vectorize", "create", INDEX_NAME, "--preset", EMBEDDING_MODEL]);
  // Give the control plane a moment before the first query/upsert against it.
  await sleep(10_000);
}

interface ListVectorsResult {
  vectors?: { id: string }[];
}

async function listExistingIds(): Promise<string[]> {
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const args = ["vectorize", "list-vectors", INDEX_NAME, "--count", "1000", "--json"];
    if (cursor) args.push("--cursor", cursor);
    const parsed = JSON.parse(await wrangler(args)) as ListVectorsResult & { cursor?: string };
    ids.push(...(parsed.vectors ?? []).map((v) => v.id));
    cursor = parsed.cursor || undefined;
  } while (cursor);
  return ids;
}

/** Deletes any vector id from a previous run that isn't among this run's chunks (renamed/removed content). */
async function removeStaleVectors(currentIds: Set<string>): Promise<void> {
  const existingIds = await listExistingIds();
  const staleIds = existingIds.filter((id) => !currentIds.has(id));
  if (staleIds.length === 0) return;
  console.log(`Removing ${staleIds.length} stale vector(s) from a previous run...`);
  await wrangler(["vectorize", "delete-vectors", INDEX_NAME, "--ids", ...staleIds]);
}

async function upsert(chunks: KnowledgeChunk[], vectors: number[][]): Promise<void> {
  const ndjson = chunks
    .map((chunk, i) =>
      JSON.stringify({
        id: chunk.id,
        values: vectors[i],
        metadata: { section: chunk.section, title: chunk.title, url: chunk.url ?? "", text: chunk.text },
      }),
    )
    .join("\n");

  const dir = await mkdtemp(path.join(tmpdir(), "pgc-vectorize-"));
  const file = path.join(dir, "chunks.ndjson");
  try {
    await writeFile(file, ndjson, "utf-8");
    console.log(`Upserting ${chunks.length} vectors into "${INDEX_NAME}"...`);
    console.log(await wrangler(["vectorize", "upsert", INDEX_NAME, "--file", file]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!API_TOKEN) {
    throw new Error("CLOUDFLARE_API_TOKEN is not set in the environment -- run `wrangler whoami` to check auth.");
  }

  const markdown = await readFile(SITE_KNOWLEDGE_PATH, "utf-8");
  const chunks = buildChunks(markdown);
  console.log(`Parsed ${chunks.length} chunks from ${path.relative(process.cwd(), SITE_KNOWLEDGE_PATH)}.`);

  console.log("Embedding chunks...");
  const vectors = await embedAll(chunks);

  await ensureIndexExists();
  await removeStaleVectors(new Set(chunks.map((c) => c.id)));
  await upsert(chunks, vectors);

  console.log(`\nDone. "${INDEX_NAME}" now has ${chunks.length} vectors. Give it a few seconds to finish propagating before relying on it.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
