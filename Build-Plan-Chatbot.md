# Pure Grounds Coffee Co. — Claude Chatbot on Cloudflare Workers (Phase 1) + AI Gateway Showcase (Phase 2)

Build a brand-styled Claude-powered chatbot at chatbot.puregroundscoffee.com on Cloudflare Workers with a static knowledge base distilled from the live site, architected so Phase 2 can drop in Cloudflare AI Gateway as a transparent proxy and showcase (nearly) every requested Gateway feature with minimal code churn — tracked via a checklist so any session can pick up where the last one left off.

## How to resume this build in a later session

This document is the single source of truth for progress, not just the initial plan. Rules for any session (this one or a future one) working from it:

1. Read the **Status Checklist** first. Everything marked `[x]` is done — don't redo it, verify it still looks right if unsure.
2. Work items **top to bottom, phase by phase** — do not start Phase 2 items until every Phase 1 item is checked off and Phase 1 has been manually verified end-to-end.
3. After finishing a checklist item, **edit this file** to flip its `[ ]` to `[x]`, and jot a one-line note if a decision changed something (e.g. a different gateway ID, a renamed file). Keep the doc in sync with reality — it is the handoff mechanism between sessions.
4. If something in "Context gathered" turns out to be stale (site content changed, a Cloudflare feature moved), update that section too rather than leaving it wrong for the next session.
5. Don't skip ahead to Phase 2 wiring "just in case" — `claude.ts` is deliberately structured so Phase 2 is a config change, so there's no benefit to doing it early and it adds risk/complexity to Phase 1 verification.

## Environment note (read this before running anything)

The project working directory **moved off Google Drive**. It now lives at:

```
C:\Users\drecla\Dev Projects\chatbot
```

(previously `G:\My Drive\Developer Folder\Chatbot Repo\chatbot` -- that copy is
stale, do not edit it). Google Drive's virtual filesystem made `npm install`
take 20+ minutes and repeatedly left unkillable stray `node.exe` processes;
plain local disk installs in ~15 seconds. Git remote (`github.com/davidrecla/chatbot`)
is unchanged. If this machine's Google Drive sync path ever needs to be used
again for this project, re-copy files over first (`robocopy ... /E /XD node_modules`)
rather than editing the Drive copy directly.

This machine also has a TLS-intercepting proxy/AV (self-signed root cert) that
breaks Node's default HTTPS requests (`fetch failed` / `SELF_SIGNED_CERT_IN_CHAIN`),
even though browsers/PowerShell's `Invoke-WebRequest` work fine (they trust the
Windows cert store). Fix: run Node with `--use-system-ca` (already wired into
`npm run build:knowledge` via `cross-env NODE_OPTIONS=--use-system-ca`). Add the
same flag to any other ad-hoc Node network scripts on this machine.

## Status Checklist

### Phase 1 — Claude-only chatbot
- [x] 0. Save this plan as `Build-Plan-Chatbot.md` in repo root (this file).
- [x] 1. Scaffold Worker project: `wrangler.jsonc`, TypeScript config, `package.json`, `.dev.vars.example`, `AGENTS.md` (build/dev/deploy/verify commands).
- [x] 2. Write `scripts/build-knowledge.ts` (crawls sitemap.xml + Shopify `{handle}.json` + page/blog HTML → `knowledge/site-knowledge.md`). Note: `{handle}.json` has no stock data; availability is merged in from `/collections/all/products.json`.
- [x] 3. Run it once; hand-review/edit `knowledge/site-knowledge.md`. Reviewed -- fixed tags (comma string, not array), stripped noisy collection-grid fallback text, capped long pages (e.g. Terms of Service) at ~4000 chars with a link back, since this whole doc is resent on every chat request.
- [x] 4. Hand-write `knowledge/brand-voice.md` (tone/style guide distilled from the Coffee Guides blog).
- [x] 5. Implement `src/claude.ts` (streaming Anthropic Messages API client; base URL/headers from env so Phase 2 = config swap).
- [x] 6. Implement `src/knowledge.ts` (assembles system prompt from brand-voice + site-knowledge + guardrail instructions). Markdown files baked in via a `Text` module rule in `wrangler.jsonc` + `src/md.d.ts` ambient type.
- [x] 7. Implement `src/session.ts` (Durable Object `ChatSession`: per-visitor history keyed by session cookie). Uses Workers RPC (extends `DurableObject` from `cloudflare:workers`), not manual fetch dispatch.
- [x] 8. Implement `src/index.ts` (routing: static assets, `/api/chat` SSE streaming handler, interim per-session rate/length caps). `npm run typecheck` passes.
- [x] 9. Build static UI: `public/index.html`, `public/style.css`, `public/app.js` (Montserrat + gold/brown/cream palette, logo pulled from the site's own CDN into `public/assets/logo.png`, full-page chat, footer disclaimer/link to main site).
- [x] 10. Configure `wrangler.jsonc` (assets binding, Durable Object binding+migration, vars/secret placeholders for `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`).
- [x] 11. `wrangler secret put ANTHROPIC_API_KEY`; `wrangler deploy`; attach Workers Custom Domain `chatbot.puregroundscoffee.com`. Live: routes/custom_domain added to `wrangler.jsonc`; deploy auto-disabled `workers_dev` since an explicit route exists (single clean URL, no `*.workers.dev` duplicate).
- [x] 12. Manually verify Phase 1 end-to-end — **gate before Phase 2**. Verified locally (`wrangler dev`) and in production (`https://chatbot.puregroundscoffee.com`): grounded product/company answers, multi-turn memory, off-topic redirect all work. Found + fixed a real bug: session cookie was unconditionally `Secure`, which silently broke multi-turn memory over local plain-HTTP `wrangler dev` (browsers/HTTP clients correctly refuse `Secure` cookies over non-HTTPS) -- now conditional on request protocol.
- [x] 13. Commit Phase 1 work with clear messages (push only when asked). Committed (`9c9c4f5`); not pushed yet -- push when you're ready.

### Phase 2 — AI Gateway proxy + feature showcase
- [ ] 14. Create AI Gateway `pgc-chatbot` in Cloudflare dashboard; create gateway token.
- [ ] 15. Switch `ANTHROPIC_BASE_URL` to the gateway's Anthropic endpoint + add `cf-aig-authorization` header/secret. Redeploy; reverify chat still works unchanged.
- [ ] 16. Add `cf-aig-metadata` (session id, surface tag) to requests.
- [ ] 17. Add stable `cacheKey`/`cacheTtl` for common FAQ-shaped questions; enable gateway caching.
- [ ] 18. Configure spend limits + rate limiting on the gateway (dashboard); retire the Phase-1 interim caps once confirmed working.
- [ ] 19. Enable Guardrails (Llama Guard 3) on the gateway.
- [ ] 20. Enable DLP (predefined Financial/PII profiles), flag mode first.
- [ ] 21. Implement `POST /api/feedback` (👍/👎 buttons in UI → `env.AI.gateway("pgc-chatbot").patchLog(...)`).
- [ ] 22. Configure a Dynamic Route (primary Claude → fallback Claude Haiku → fallback Workers AI) in the dashboard.
- [ ] 23. Implement `src/gateway.ts` + `POST /api/demo/resilience` (OpenAI-compat endpoint, `model: "dynamic/<route>"`) — isolated demo path, "simulate outage" + "A/B split" controls.
- [ ] 24. Build `/insights` admin panel (`public/insights.html/js`): requests, cache-hit rate, spend, latency, feedback ratio, model split, Resilience Lab controls; pulls from `src/gateway.ts` REST/Analytics calls.
- [ ] 25. Set up Cloudflare Access application protecting `/insights`; verify unauthenticated access is blocked.
- [ ] 26. Confirm/log Logpush and Unified Billing/ZDR as optional talking points (dashboard-only, not required to wire up).
- [ ] 27. Dry-run the manager-facing demo script end-to-end; commit Phase 2 work.

## Post-launch UX/behavior refinements (v1.1, after initial Phase 1 ship)

Real user testing after the first deploy surfaced several behavior/UX
changes. These are now part of the durable behavior contract, not one-off
tweaks -- keep them in mind if you touch tone, pacing, or the chat UI:

- **Persona reversed from "redirect to a human" to "act as the sales
  consultant yourself."** The bot never suggests emailing hello@puregroundscoffee.com
  or "talking to our team." It answers directly and, when a purchase is the
  next step, links straight to the product/bundle page instead. This also
  meant dropping the site's `agents.md` (Shop.app/UCP agent instructions,
  meant for *other* shopping bots) entirely from the generated knowledge doc
  since it actively conflicted with this stance. See `src/knowledge.ts` and
  the "Act like a real sales consultant" section of `knowledge/brand-voice.md`.
- **B2B/business-bundle knowledge is a first-class scenario**, not an edge
  case. `scripts/build-knowledge.ts` gives "page" content (About, Business
  Bundles, pricing) a much higher truncation cap (`MAX_SECTION_CHARS_PAGE`,
  9000 chars) than policies/blog (4000), since the Coffee Business Bundles
  page was getting cut off mid-description at the old shared 4000 cap.
- **Replies are short by default** (2-4 sentences), longer only for genuine
  multi-item comparisons (e.g. bundle sizing). Enforced primarily via the
  system prompt's "Keep it short" rule, with `ANTHROPIC_MAX_TOKENS` as a
  loose backstop. That backstop needs headroom: 500 was tried and cut a
  legitimate 6-bundle breakdown off mid-sentence, which looks worse than a
  slightly longer reply -- settled on 800.
- **Chat pacing no longer streams token-by-token.** `public/app.js` now
  mimics a real chat exchange: a silent "seen" pause (1.2-2.2s), then a
  "typing..." indicator held for a duration scaled to the reply's length
  (0.8s base + ~8ms/char, clamped 1.2-4s), then the full reply appears at
  once, rendered through a small markdown-lite renderer (`**bold**` -> real
  `<strong>`, `[label](url)` and bare URLs -> real `<a>` links). The backend
  still streams SSE as before; the frontend just no longer reveals it
  progressively -- it buffers, then reveals atomically.
- **Never use em/en dashes** (prompt instruction + a regex safety net in
  `src/claude.ts`'s `stripLongDashes`), **Filipino replies are Taglish**
  (mostly English + Filipino connectors, not textbook-formal Filipino).

## Context gathered

- **Target repo**: `G:\My Drive\Developer Folder\Chatbot Repo\chatbot` — git repo (`origin` = `github.com/davidrecla/chatbot`), currently just `README.md` + `.gitignore`. Greenfield build.
- **Site**: `puregroundscoffee.com` is a Shopify store (Dawn theme). Sitemap structure:
  - Products: `/products/{handle}` (+ `/products/{handle}.json` for clean structured data)
  - Collections: `Homegrown Series (Mt. Apo)`, `Espresso`, `Pour Over`, `Green Coffee Beans`, `All Coffees`
  - Pages: `About Us`, `Coffee Business Bundles` (B2B/wholesale pricing inquiry)
  - Blog: `Coffee Guides` (`/blogs/pgccoguidetocoffeeexcellence/...`) — best source of brand *voice*: warm, sensory, educational, second-person ("you"), occasional italics for emphasis, no emoji, light editorializing.
  - Policies: privacy/terms/refund.
  - Store ships an `agents.md` + Shopify UCP/MCP commerce endpoints, but that's written for *third-party* shopping agents (installing Shop.app, etc.), not our own chatbot. Per user direction (see below), we deliberately do NOT inject it into the system prompt or lean on "redirect to a human/email" -- the bot acts as the sales consultant itself and links directly to product/bundle pages instead.
- **Brand palette/fonts** extracted from live theme CSS variables (`--color-*`, `--font-*`): Montserrat (headings + body); warm gold/bronze accent `#B68637`, deep coffee brown `#49281A`, cream/oat neutral `#E2DED7`, near-black text `#121212`/`#171717`, white. Double-check exact hex/scheme usage against computed styles during implementation.
- **Anthropic access**: user has a real Anthropic Console API key (separate from any claude.ai chat plan).
- **DNS**: `puregroundscoffee.com` is on Cloudflare nameservers under an account the user controls — Workers Custom Domain for `chatbot.puregroundscoffee.com` is viable.
- **AI Gateway facts** (confirmed via current docs):
  - Provider-specific endpoint `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic/v1/messages` is a pass-through of the Anthropic Messages API — the "just change the base URL" story for Phase 2.
  - Basic **request retries** work on that same endpoint via `cf-aig-max-attempts`/`cf-aig-retry-delay`/`cf-aig-backoff` headers.
  - Multi-provider **Fallbacks / Dynamic Routing / A-B testing** now live under **Dynamic Routing**, invoked via the **OpenAI-compatible** endpoint (`/compat/chat/completions`) with `model: "dynamic/<route-name>"`. The old "Universal Endpoint" is deprecated — hence the isolated demo path.
  - **DLP** free on all plans (2 predefined profiles without Zero Trust). **Guardrails** run on Workers AI (Llama Guard 3), billed as normal Workers AI inference. **Logpush** requires a paid plan (optional talking point). **Unified Billing** and **Zero Data Retention** are real, current features. **`patchLog`** feedback API is live/supported (unlike the deprecated "Evaluations" UI, which we will not build around).
  - Workers static assets configured via `wrangler.jsonc` `assets: { directory, binding, run_worker_first }` — one Worker serves the SPA + API.

## Architecture

```
chatbot/
  wrangler.jsonc
  package.json / tsconfig.json
  src/
    index.ts        # routing: static assets, /api/chat, /api/feedback, /api/demo/resilience, /api/insights/*
    session.ts       # Durable Object "ChatSession" — per-visitor message history, keyed by a session cookie
    claude.ts         # thin Claude client: reads ANTHROPIC_BASE_URL/headers from env, so Phase 2 = swap env values
    knowledge.ts      # builds the system prompt from brand-voice.md + site-knowledge.md
    gateway.ts        # (Phase 2) AI Gateway REST helpers (logs, analytics, patchLog) for /api/insights + /api/feedback
    types.ts
  public/             # served via the `assets` binding
    index.html style.css app.js   # main chat UI, brand-styled
    insights.html insights.js     # "Gateway Insights" admin panel (Phase 2), protected by Cloudflare Access
    assets/           # logo/favicon pulled from the site's own CDN
  knowledge/
    brand-voice.md     # hand-written tone/style guide
    site-knowledge.md  # generated knowledge doc (products, prices, tasting notes, About, bundles, policies, FAQs)
  scripts/
    build-knowledge.ts # crawls sitemap.xml + Shopify {handle}.json + page/blog HTML, regenerates site-knowledge.md
  .dev.vars.example
  Build-Plan-Chatbot.md  # this document, kept up to date as the cross-session build log
  AGENTS.md
```

### Phase 1 design notes
- System prompt = brand-voice guide + site knowledge + explicit guardrails: stay on Pure Grounds Coffee Co. topics; never invent prices/stock; redirect to `puregroundscoffee.com` / `hello@puregroundscoffee.com` for things not in the knowledge base; refuse to attempt checkout itself.
- Chat flow: session cookie → Durable Object stores running message list → `POST /api/chat` streams Claude's SSE response back to the browser.
- UI: full-page brand-styled chat (not an embedded widget) at bare `chatbot.puregroundscoffee.com`.
- Interim cost/abuse safety (pre-Gateway): cap `max_tokens`, cap input length, soft per-session message-count ceiling — explicitly temporary, retired once Gateway rate limiting is on (checklist item 18).

### Phase 2 design notes — feature-by-feature mapping
- **Core setup/minimal integration**: base URL + one auth header swap in `claude.ts`'s config, no other code changes.
- **Custom metadata/User Insights**: `cf-aig-metadata` per request (session id, surface tag).
- **Response caching**: stable `cacheKey`/`cacheTtl` on FAQ-shaped questions.
- **Spend limits/Rate limiting/Cost analytics**: dashboard-only config.
- **Logs/Analytics/Logpush**: automatic once traffic flows through the gateway; Logpush called out as optional paid add-on.
- **Guardrails**: Llama Guard 3 via Workers AI, dashboard-enabled.
- **DLP**: predefined Financial/PII profiles, flag mode first.
- **Intent/anomaly detection**: dashboard-level, no app change.
- **Cloudflare Access**: protects the `/insights` admin panel (not the public chatbot, whose visitors are anonymous) — the honest place to demo "tie usage to real users."
- **Fallbacks/Dynamic Routing/A-B testing**: isolated `/api/demo/resilience` endpoint using the OpenAI-compat endpoint + a dashboard-configured Dynamic Route; "simulate outage" and "A/B split" demo controls in the Insights panel.
- **Human feedback loop**: 👍/👎 buttons → `/api/feedback` → `patchLog`, visible/filterable in native Logs UI.
- **"Gateway Insights" panel**: requests, cache-hit rate, spend, latency, feedback ratio, model/provider split, plus Resilience Lab controls — a companion to, not a replacement for, the native Cloudflare dashboard.
- **Suggested additions beyond the requested list**: Unified Billing (single-invoice procurement pitch), Zero Data Retention (trust/compliance angle for PII-adjacent traffic). Explicitly not building on the deprecated Evaluations feature.

## Verification

- [ ] `npm run build:knowledge` produces a sane, human-reviewable `site-knowledge.md`.
- [ ] `wrangler dev` locally: multi-turn conversation stays in character, cites only knowledge-doc facts, refuses to fabricate prices/stock, redirects off-topic/purchase requests appropriately.
- [ ] `tsc --noEmit` / lint passes.
- [ ] `wrangler deploy` succeeds; `chatbot.puregroundscoffee.com` resolves and serves the chat UI over HTTPS via the Custom Domain.
- [ ] Mobile + desktop visual check against brand palette/fonts.
- [ ] Phase 2: requests visibly flow through the AI Gateway dashboard (logs, cache hits on repeated FAQ, forced-failure resilience demo showing `cf-aig-step` fallback, thumbs feedback appearing on a log entry, `/insights` inaccessible without Access login).

## Open items / things the user needs to do outside of code

- Create the Anthropic API key as a Worker secret when we get there (key itself already exists).
- Confirm comfort with a Workers Paid plan if usage grows beyond free-tier Durable Object limits.
- Phase 2: create the AI Gateway + gateway token, and decide who should be allowed into the `/insights` Cloudflare Access application (email domain vs specific addresses) — will ask again at that point.
