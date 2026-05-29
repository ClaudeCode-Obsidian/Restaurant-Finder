# CLAUDE.md — Restaurant Finder

This file is the operating manual for any Claude session working on this repo. Read it first; follow the operational rules at the bottom strictly.

## Project goal

A web app that finds Hong Kong restaurants matching a free-text request ("casual Italian in Central tonight at 7 for 4"), and tells the user **whether real-time slots are bookable** at their requested time — not just whether the restaurant exists.

The hard part is availability. We chain multiple booking sources (OpenRice → Google Reserve → placeholder) and degrade gracefully when each fails. Output streams as NDJSON so users see results progressively rather than waiting for the slowest restaurant.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 14** (App Router) | Server components + streaming responses out of the box |
| Language | **TypeScript** (strict) | One source of truth for shared types between API and UI |
| Styling | **Tailwind CSS** | No design system overhead for a single-developer app |
| LLM | **Anthropic Claude** (`@anthropic-ai/sdk`) | Free-text → structured `SearchQuery`, and per-restaurant editorial blurbs |
| Places | **Google Places API (New)** v1 REST | Single call returns rating, photos, hours, price level, reservable flag |
| Maps UI | **Google Maps JS API** + `@googlemaps/js-api-loader` | Browser-side map with hover sync |
| Headless browser | **Playwright** (Chromium) | Drives Google Reserve's MDC date/party/time pickers; OpenRice fallback scraping |
| HTML parsing | **cheerio** | When we get HTML back from a fetch and don't need a browser |

API keys live in `.env.local`:
- `ANTHROPIC_API_KEY` — server only
- `GOOGLE_MAPS_API_KEY` — server only, **never** expose to the browser
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — browser-restricted key, HTTP-referrer-locked

## File structure

```
app/
  page.tsx                       Landing page (chatbox + cuisine chips)
  search/page.tsx                Results page (list ← → map, synced hover)
  layout.tsx · globals.css       Root wrapper + Tailwind entry
  api/
    chat/route.ts                POST: free-text → SearchQuery via Claude
    restaurants/route.ts         GET:  streams NDJSON of enriched restaurants
  components/
    ChatBox.tsx                  Text + Web Speech voice input
    CuisineBubbles.tsx           Two scrolling rows of suggestion chips
    MapView.tsx                  Google Map, markers, hover sync
    RestaurantCard.tsx           Single result card with slot pills

lib/
  types.ts                       Shared types: PriceTier, TimeSlot, Restaurant, SearchQuery
  googlePlaces.ts                Places API (New) wrapper with HK location bias (50km, API max)
  availability.ts                Tiered availability chain (OpenRice → Google Reserve → placeholder)
  openrice-booking.ts            Tier 1 — OpenRice picker API (HTTP, ~200ms, 60-70% HK coverage)
  google-reserve.ts              Tier 2 — Google Reserve via Playwright with date/party/time pickers
  openrice.ts                    Legacy OpenRice helpers (POI search, etc.)
  playwright-pool.ts             Shared Chromium singleton, MAX_CONCURRENT=4, HK-locale context
  claude.ts                      Anthropic client + prompts for query parsing & editorial blurbs

scripts/                         One-off TS scripts (run via `npx tsx`). Diagnostic scripts MUST be deleted after use.
probe-tier-calibration.mjs       Standalone calibration helper for the price-tier mapping
```

## Availability chain (read before editing)

1. **OpenRice** (Tier 1) — HTTP-only call to `/api/v2/booking/picker`. Real-time, ~200ms, covers ~60-70% of HK restaurants. Returns `[]` to fall through.
2. **Google Reserve** (Tier 2) — Playwright opens the Reserve widget, **must drive three pickers in order**: date → party → time. Reserve uses Material Design Components (MDC) which listen to native pointer events — programmatic `.click()` from `page.evaluate` is a silent no-op; use Playwright's `locator.click()`. The time picker is critical: Reserve centres its 9 slot pills on whatever the time dropdown shows; default is "current clock rounded up", not the user's request.
3. **Placeholder** — last resort, `available: false`, links to whatever booking URL we know.

Slot output is normalised to `TimeSlot[]` regardless of source. Each slot has `time` (ISO), `available`, optional `bookingUrl`, and one of `nextAvailableTime` / `nextAvailableDate` flags when the slot isn't a direct match.

## Things that have burned us before — don't repeat

- Fixed `setTimeout` after SPA route changes. Always wait on a concrete DOM signal (`waitForSelector`, `waitForFunction`) instead.
- Trusting trigger labels to contain absolute dates. Reserve uses **relative labels** ("Today" / "Tomorrow") for the next two days. Match on change-from-pre-click-value, not on a specific string.
- Clicking elements that look right by aria-label but are actually hidden listboxes (MDC pattern). Click the visible `[role="combobox"][aria-haspopup="listbox"]` trigger.
- Blocking images/fonts in Playwright routes — broke Reserve link injection on heavy Maps pages. Block analytics only.
- `MAX_CONCURRENT > 4` — Reserve anchor injection misses its 8s window under load.
- Forgetting `locationBias` on Google Places — searches drift outside HK ("Sole Mio" → London).
- Using BistroChat as an availability source — it returns weekly templates, not real-time slots. Removed.

---

## Operational rules (strict — apply every session)

These are **non-negotiable** and govern my behaviour, not the codebase.

1. **Output Constraints:** Keep individual tool responses concise and prefer multiple shorter outputs to avoid token limits. When generating code or long documents, write directly to files and summarise the content in the chat unless explicitly asked to elaborate or go into detail.

2. **Anti-Bot Scraping:** If we need to scrape restaurant data, default to using Playwright then Claude in Chrome MCP to bypass WAF defenses / CAPTCHA / Anti-bot mechanisms; do not attempt raw HTTP requests first.

3. **Incremental Commits:** We need to stop running multi-hour sessions with zero commits. Prompt me to commit via Git after every successful milestone or file creation to protect our progress.

4. **Resuming Work:** If a session is interrupted by usage limits, immediately check for in-progress tasks, partial files, and TODOs, and summarize what's done before starting new work.

5. **Plain-Language Explanations:** The user is NOT a software engineer. When summarising what went wrong, what happened, or what I did, avoid technical jargon. If a technical term is genuinely needed, add a short plain-English explanation in parentheses right after it — e.g. "the request returned a 500 (the server hit an error and gave up)", or "Node was trying IPv6 (a newer type of internet address) that this network can't reach". Prefer everyday analogies over precise-but-opaque terminology. Keep deep code-level detail in the files and comments, not in the chat summary.
