# Restaurant Finder

A web app that finds restaurants, checks availability, and helps you book — driven by an AI agent over Google Places + OpenRice.

Built with **Next.js 14 (App Router) · TypeScript · Tailwind CSS · Claude (Anthropic)**.

## What it does

1. **Landing page** — a chatbox (text + voice via Web Speech API) with cuisine suggestion chips.
2. **Claude parses** your free-text request into a structured query (cuisine, area, date, party size).
3. The server fans out, **in parallel**, per candidate restaurant:
   - **Google Places (New) API** — name, rating, reviews, address, hours, photo, website
   - **OpenRice** scrape — HK price tier (0–6)
   - **Claude** — short editorial blurb (formality + ambience + specialties)
   - **Availability** lookup — OpenTable slot endpoint when detected, fallback otherwise
4. Results render OpenTable-style: list on the left, Google Map on the right with synced hover.

## Setup

```bash
# 1. Install
npm install

# 2. Copy env template and fill in your keys
cp .env.example .env.local
# Edit .env.local with:
#   ANTHROPIC_API_KEY                 (https://console.anthropic.com/)
#   GOOGLE_MAPS_API_KEY               (server-side, used by API routes)
#   NEXT_PUBLIC_GOOGLE_MAPS_API_KEY   (browser, restrict by HTTP referrer)

# 3. In Google Cloud Console, enable:
#    - Places API (New)
#    - Maps JavaScript API

# 4. Run
npm run dev
# → http://localhost:3000
```

## Project structure

```
app/
  page.tsx                 Landing page
  search/page.tsx          Results page (list + map)
  layout.tsx               Root <html> wrapper
  globals.css              Tailwind entry
  api/
    chat/route.ts          POST: parse free-text → SearchQuery
    restaurants/route.ts   GET:  Google Places + enrich in parallel
  components/
    ChatBox.tsx            Text + voice input
    CuisineBubbles.tsx     Suggestion chips
    RestaurantCard.tsx     One result row
    MapView.tsx            Google Map wrapper
lib/
  types.ts                 Shared types (Restaurant, TimeSlot, …)
  googlePlaces.ts          Places API (New) client
  openrice.ts              Price-tier scraper
  availability.ts          Booking-platform availability
  claude.ts                Anthropic SDK wrapper
```

## How the AI agent works

`/api/chat` calls Claude to parse natural language into JSON. `/api/restaurants`
fans out to three concurrent sources per restaurant (Places, OpenRice, availability)
and asks Claude again to write a grounded 2–3 sentence blurb from the resulting
data. Both Claude calls use `claude-haiku-4-5-20251001` for cost and speed; switch
to `claude-sonnet-4-6` in `lib/claude.ts` for higher-quality prose.

## Known limitations

- **Availability** across the long tail of HK reservation platforms (Inline,
  SevenRooms, Chope, restaurant widgets) is not solved here — we implement
  OpenTable and fall back to a "Check on booking site" deep link for the rest.
  Add new platforms by extending `lib/availability.ts`.
- **OpenRice scraping** breaks if their markup changes — by design it returns
  "Price N/A" rather than crashing.
- **Voice input** uses the Web Speech API. Works on Chrome / Edge / Safari.
  Firefox shows text-only.

## Tech choices

| Concern | Choice | Why |
|---|---|---|
| Framework | Next.js 14 App Router | One codebase, file-based routing, easy Vercel deploy |
| Language | TypeScript | Catches API-shape mismatches at compile time |
| Styling | Tailwind CSS | Utility classes; matches the OpenTable density |
| AI | Anthropic Claude (Haiku 4.5) | Fast parsing + grounded short summaries |
| Maps | Google Maps JS API | Same Cloud project as Places API |
| Voice | Web Speech API | Browser-built-in; no extra dependency |

## License

MIT.
