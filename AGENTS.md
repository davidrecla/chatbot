# pgc-chatbot -- Agent/Developer Notes

Pure Grounds Coffee Co. chatbot. Cloudflare Worker (TypeScript) serving a
static chat UI + `/api/chat`, powered by Claude directly in Phase 1 and via
Cloudflare AI Gateway in Phase 2. See `Build-Plan-Chatbot.md` for the full
build plan, status checklist, and environment notes -- **read that file
first** in any new session on this repo.

## Commands

```bash
npm install              # install deps
npm run build:knowledge  # re-crawl puregroundscoffee.com -> knowledge/site-knowledge.md
                          # (hand-review the diff before committing)
npm run dev               # wrangler dev (local); needs .dev.vars, see below
npm run typecheck         # tsc --noEmit
npm run deploy            # wrangler deploy
npm run cf-typegen        # regenerate worker-configuration.d.ts from wrangler.jsonc
                          # (not currently used -- Env is hand-written in src/types.ts)
```

## Local secrets

`wrangler dev` reads secrets from `.dev.vars` (gitignored). Copy
`.dev.vars.example` to `.dev.vars` and fill in a real Anthropic Console API
key (console.anthropic.com -- NOT a claude.ai chat subscription, which has no
API access). Deployed secrets are set separately with `wrangler secret put`.

## Environment quirks on this machine (see Build-Plan-Chatbot.md for detail)

- Project lives at `C:\Users\drecla\Dev Projects\chatbot` -- NOT on the
  Google-Drive-synced `G:\` path, which made `npm install` unusably slow.
- This machine has a TLS-intercepting proxy/AV. Any ad-hoc Node script that
  makes HTTPS requests (like `scripts/build-knowledge.ts`) needs
  `NODE_OPTIONS=--use-system-ca` or it fails with `SELF_SIGNED_CERT_IN_CHAIN`.
  Already wired into `npm run build:knowledge` via `cross-env`.

## Architecture at a glance

- `src/index.ts` -- routing, `/api/chat` (SSE streaming), session cookie.
- `src/claude.ts` -- model-agnostic streaming chat client on the AI Gateway's
  OpenAI-compatible endpoint (`compat/chat/completions`). Despite the
  filename (kept to minimize churn), it's not Anthropic-only -- it's what
  every tier in `src/modelRouting.ts` calls through.
- `src/modelRouting.ts` -- **which *tier* a message belongs to** (the actual
  model pick happens in the Gateway, see below). 4 tiers, escalating order
  (`trivial -> technical -> standard -> complex`; a session's tier only
  ever moves right, never back):
  - `trivial` -> Llama 4 Scout (Workers AI): basic questions, <4 messages in.
  - `technical` -> GPT-OSS 120B (Workers AI): message asks *how/why*
    something works (`explain`, `extraction`, `ratio`, `grind`, etc.).
  - `standard` -> Claude Haiku (default): conversation's gone deeper (4+
    messages) without a technical or B2B signal.
  - `complex` -> Claude Sonnet: 12+ messages, or a bulk/B2B signal
    (`kg`, `bulk`, `wholesale`, `business`, `bundle`, `office`, `cafe`).
  Every call goes to `dynamic/pgc-tier-router` (a Dynamic Route on the
  Gateway, a chain of `conditional` nodes keyed on `metadata.tier`) rather
  than resolving straight to a model string here -- the tier is attached
  via `cf-aig-metadata` in src/index.ts, and the Route does the actual
  model selection. This is deliberate: showcases the Gateway's routing
  capability instead of just picking a model in application code.
- `src/session.ts` -- `ChatSession` Durable Object (RPC-style): per-visitor
  message history + the session's current model tier (escalate-only, see
  above). Also a generous message-count cap as a storage-growth backstop.
- `src/knowledge.ts` -- assembles the system prompt from
  `knowledge/brand-voice.md` + `knowledge/site-knowledge.md` (both baked into
  the Worker bundle as text via the `rules` entry in `wrangler.jsonc`).
- `src/gateway.ts` -- AI Gateway REST helpers: the Resilience Lab demo
  (`/api/demo/resilience`, A/B only -- the old "simulate outage" mode/route
  was retired), and the `/insights` admin panel's data
  (`/api/insights/summary`, `/api/insights/log` -- the latter powers a
  per-log conversation transcript viewer that strips the system prompt out).
- `scripts/build-knowledge.ts` -- dev-only Node script, regenerates
  `knowledge/site-knowledge.md` from the live site. Never bundled into the Worker.
- `public/` -- static chat UI + `/insights` admin panel, served via the
  Workers `assets` binding. Note: the chat UI's 👍/👎 feedback buttons were
  removed from `app.js` (too noisy per user feedback) -- the backend
  (`/api/feedback` -> `patchLog`) still works, just has no UI trigger.
- `Customer-Demo-Guide.html` (repo root) -- standalone, self-contained demo
  script for showing this project to a customer, organized around AI
  Gateway capabilities (not chat features). Open directly in a browser.

## Debugging hard-to-reproduce rendering bugs

For a real mobile-only CSS bug this session, screenshot-based guessing
burned a lot of time before switching to a scripted repro:

```bash
npm install --no-save playwright-core   # lightweight, no browser download
```

Then drive the system's already-installed Edge directly (works well on
this machine, where downloading a fresh Chromium build is slow/unreliable):

```js
import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 375, height: 700 }, isMobile: true, hasTouch: true });
```

Use `page.evaluate(() => el.getBoundingClientRect())` / `getComputedStyle()`
for exact pixel measurements instead of eyeballing a screenshot -- this is
what actually found the root cause (a `max-width` on the wrong element)
after several plausible-looking fixes had zero measurable effect.
`playwright-core` was installed with `--no-save` (so it's in
`node_modules/` as of this session but deliberately not in
`package.json`/`package-lock.json`) -- a fresh `npm install` on another
machine won't have it; reinstall with the command above if needed again.
