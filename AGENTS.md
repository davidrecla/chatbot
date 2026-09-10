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
- `src/claude.ts` -- Anthropic Messages API client. Reads target URL/headers
  from `Env` so Phase 2 (AI Gateway) is a config change, not a rewrite.
- `src/session.ts` -- `ChatSession` Durable Object (RPC-style), per-visitor
  message history, interim message-count cap (retired once real Gateway rate
  limiting exists in Phase 2).
- `src/knowledge.ts` -- assembles the system prompt from
  `knowledge/brand-voice.md` + `knowledge/site-knowledge.md` (both baked into
  the Worker bundle as text via the `rules` entry in `wrangler.jsonc`).
- `scripts/build-knowledge.ts` -- dev-only Node script, regenerates
  `knowledge/site-knowledge.md` from the live site. Never bundled into the Worker.
- `public/` -- static chat UI, served via the Workers `assets` binding.
