/**
 * GET /api/restaurants?q=...&dateTime=...&partySize=...
 *
 * RESPONSE FORMAT: newline-delimited JSON (NDJSON), streamed.
 * The client reads it incrementally and renders each restaurant card
 * as soon as it arrives, instead of waiting ~15 s for the whole batch.
 *
 * Wire format — one JSON object per line, in this order:
 *   {"type":"meta","count":8,"dateTime":"...","partySize":2,"q":"..."}
 *   {"type":"restaurant","restaurant":{...}}   ← repeated, in completion order
 *   {"type":"restaurant","restaurant":{...}}
 *   ...
 *   {"type":"done"}
 *
 * On a per-restaurant failure we still emit a `restaurant` event with
 * placeholders so the user sees the card with whatever info we have,
 * rather than the slot disappearing.
 *
 * Per restaurant we run, IN PARALLEL:
 *   - Google Maps price-tier scrape (Playwright; visit is shared with the
 *     Reserve booking-URL discovery via fetchMapsData promise-cache)
 *   - Claude-generated description (also yields a backup price estimate)
 *   - Availability lookup
 *
 * Price resolution chain (priority order):
 *   1. Places API `priceLevel`  — instant, free, ~46% HK coverage
 *   2. Google Maps histogram    — Playwright but already-loaded; ~70% coverage
 *   3. OpenRice Playwright      — only when 1 + 2 both failed; ~5s extra
 *   4. Claude estimate          — bundled into the description call
 *   5. Cuisine-aware default    — last resort so we never show N/A
 */

import { NextRequest, NextResponse } from 'next/server';
import { searchPlaces } from '@/lib/googlePlaces';
import { fetchGoogleMapsPrice } from '@/lib/google-reserve';
import { fetchPriceTier as fetchOpenRicePrice } from '@/lib/openrice';
import { fetchAvailability } from '@/lib/availability';
import { describeRestaurant } from '@/lib/claude';
import { PRICE_LABELS, type PriceTier, type Restaurant } from '@/lib/types';

export const runtime = 'nodejs'; // need Node APIs for cheerio/scraping
export const dynamic = 'force-dynamic'; // results vary per query — don't cache the route itself

/**
 * The FilterPanel price dropdown sends these exact band strings. Map each to
 * its 1–6 PriceTier so we can filter results by price. Keep in sync with
 * PRICES in app/components/FilterPanel.tsx.
 */
const PRICE_BAND_TIER: Record<string, number> = {
  'under $50': 1,
  '$51 to $100': 2,
  '$101 to $200': 3,
  '$201 to $400': 4,
  '$401 to $800': 5,
  'over $800': 6,
};

/**
 * Keep a restaurant for a given price band. `requestedTier` 0 means "Any
 * price" → keep everything. Otherwise:
 *   - unconfirmed price (estimate) → keep (user opted to see these),
 *   - confirmed price → keep only within one tier of the band.
 */
function inPriceBand(r: Restaurant, requestedTier: number): boolean {
  if (!requestedTier) return true;
  if (!r.priceConfirmed) return true;
  return Math.abs(r.priceTier - requestedTier) <= 1;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = sp.get('q')?.trim();
  if (!q) return NextResponse.json({ error: 'Missing q' }, { status: 400 });

  const dateTime = sp.get('dateTime') || new Date().toISOString();
  const partySize = parseInt(sp.get('partySize') ?? '2', 10);
  // Structured price band the user picked (e.g. "$101 to $200"), mapped to a
  // 1–6 tier. 0 = "Any price" → no price filtering at all.
  const requestedTier = PRICE_BAND_TIER[sp.get('price') ?? ''] ?? 0;

  // 1. Get candidate restaurants from Google.
  //
  // We fetch a wider pool (20) than we'll display (8) so we can favour
  // highly-rated places before paying the per-restaurant Playwright cost.
  // Anything ≥ 4.3 stars is treated as "highly rated" — Google's own
  // research and OpenTable conventions both put the "great" threshold
  // around there for restaurants with non-trivial review counts.
  const RATING_THRESHOLD = 4.3;
  const MIN_REVIEWS = 30; // ignore the rating if barely anyone has rated it
  // We want to surface ~8 restaurants with a bookable table NEAR the
  // requested time. Many places won't have one (fully booked, or no online
  // booking), so we enrich a deeper pool than 8 and let the client split the
  // survivors into "available near your time" vs "not available at your time".
  // Restaurants with no booking link, or none free near the time, are dropped
  // below and never reach the client.
  const MAX_ENRICH = 16;

  // The user's query (`q`) carries the target area in plain English
  // (e.g. "sushi in Causeway Bay") — Google's textQuery parser handles
  // location extraction natively, so we don't need a separate
  // locationBias unless we later add explicit map-based area picking.
  //
  // 30 candidates requires 2 paged Places API calls (cap is 20/page).
  // Still cheap (~1s total) and lets us cherry-pick the best 8 to
  // enrich with Playwright.
  const pool = await searchPlaces({
    textQuery: q,
    maxResults: 30,
  });

  // Stable partition: highly-rated first, everything else after, each
  // group keeping Google's original relevance order. We deliberately
  // don't sort *purely* by rating — Google's relevance signal already
  // factors in distance, popularity, query match etc., and we don't want
  // to surface a 4.9-star coffee stand above a 4.4-star sushi temple
  // when the user searched "sushi".
  const highlyRated = pool.filter(
    (p) => (p.rating ?? 0) >= RATING_THRESHOLD && (p.userRatingsTotal ?? 0) >= MIN_REVIEWS,
  );
  const rest = pool.filter(
    (p) => !((p.rating ?? 0) >= RATING_THRESHOLD && (p.userRatingsTotal ?? 0) >= MIN_REVIEWS),
  );
  // Pre-filter by price BEFORE paying the per-restaurant Playwright cost:
  // drop places whose Google-confirmed price is clearly outside the band
  // (more than one tier away — we allow one band either side per the user's
  // setting). Places with no price yet (tier 0) are kept; their real tier is
  // resolved during enrichment and re-checked there.
  const ranked = [...highlyRated, ...rest];
  const banded = requestedTier
    ? ranked.filter((p) => {
        const t = p.priceTier ?? 0;
        return t === 0 || Math.abs(t - requestedTier) <= 1;
      })
    : ranked;
  const places = banded.slice(0, MAX_ENRICH);

  // 2. Stream-enrich. Each restaurant's enrichment promise resolves
  //    independently; we emit its result on the wire the instant it
  //    finishes, in COMPLETION order (not pool order).
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        } catch {
          /* controller already closed (client disconnected) */
        }
      };

      send({ type: 'meta', count: places.length, dateTime, partySize, q });

      await Promise.all(
        places.map(async (p) => {
          let restaurant: Restaurant;
          try {
            restaurant = await enrichOne(p, dateTime, partySize);
          } catch (err) {
            // Don't let one failure kill the whole stream — fall back to a
            // degraded card (status 'check_failed') so a genuinely-bookable
            // place isn't silently dropped just because our scrape threw.
            console.error('enrichment failed', p.placeId, err);
            restaurant = degradedCard(p);
          }
          // Drop dead ends: no booking link at all, or a working booking
          // system with nothing free near the requested time. Everything
          // still actionable — bookable now, bookable at another time/date,
          // or "link exists but we couldn't read it" — goes to the client,
          // which decides which section to place it in.
          if (isHiddenForResults(restaurant)) return;
          // Drop restaurants whose CONFIRMED price falls outside the chosen
          // band (±1 tier). Estimated/unconfirmed prices are kept — the user
          // asked to see places we couldn't price with certainty.
          if (!inPriceBand(restaurant, requestedTier)) return;
          send({ type: 'restaurant', restaurant });
        }),
      );

      send({ type: 'done' });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      // NDJSON keeps the per-line framing trivial on the client; no
      // SSE event-types or `data:` prefix to parse.
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      // Disable proxy buffering — needed when running behind nginx
      // (and a no-op elsewhere). Without this, the response can be
      // buffered into a single chunk and the streaming benefit is lost.
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Run the full enrichment pipeline for one Place and return a Restaurant.
 * Extracted from the inline `.map()` so the streaming controller stays
 * tidy and per-restaurant errors can be caught individually.
 */
async function enrichOne(
  p: Partial<Restaurant>,
  dateTime: string,
  partySize: number,
): Promise<Restaurant> {
  const name = p.name ?? 'Unknown';
  const googlePlacesTier = p.priceTier ?? 0;
  // fetchGoogleMapsPrice + fetchAvailability *share* a Maps page visit
  // via promise-cache in lib/google-reserve.ts — only one Playwright
  // navigation happens per restaurant even though we kick off both here.
  const [mapsPriceTier, describe, availabilityResult] = await Promise.all([
    fetchGoogleMapsPrice(p.placeId!),
    describeRestaurant({
      name,
      rating: p.rating ?? 0,
      priceLabel: '', // not known yet; resolved below
      cuisine: p.cuisine,
      editorial: p.description,
    }),
    fetchAvailability({
      placeId: p.placeId,
      reservable: p.reservable,
      bookingUrl: p.bookingUrl,
      websiteUrl: p.websiteUrl,
      dateTime,
      partySize,
      restaurantName: name,
      // Neighborhood lets OpenRice disambiguate between branches of the
      // same restaurant name (e.g. "Sole Mio" Central vs Causeway Bay).
      neighborhood: extractNeighborhood(p.address),
      location: p.location ?? { lat: 0, lng: 0 },
    }),
  ]);
  const blurb = describe.description;

  // Price resolution — see route docstring for the priority order.
  // `priceConfirmed` tracks whether the tier came from a real source
  // (Places / Maps / OpenRice) vs an estimate (Claude / cuisine default).
  let priceTier: PriceTier =
    googlePlacesTier > 0 ? googlePlacesTier
    : mapsPriceTier > 0 ? mapsPriceTier
    : 0;
  let priceConfirmed = priceTier > 0; // Places or Maps gave us a real figure
  if (priceTier === 0) {
    // Conditional: ~30% of restaurants reach this. OpenRice scrape is ~4–6s.
    priceTier = await fetchOpenRicePrice(name);
    if (priceTier > 0) priceConfirmed = true; // OpenRice is a real source too
  }
  if (priceTier === 0) priceTier = describe.estimatedPriceTier; // estimate
  if (priceTier === 0) priceTier = defaultTierFromCuisine(p.cuisine, p.rating ?? 0); // estimate
  // Override: trust Places API's top-tier label over a capped Maps signal.
  if (googlePlacesTier === 6 && priceTier < 6) {
    priceTier = 6;
    priceConfirmed = true;
  }
  const priceLabel = PRICE_LABELS[priceTier];

  return {
    placeId: p.placeId!,
    name,
    description: blurb,
    rating: p.rating ?? 0,
    userRatingsTotal: p.userRatingsTotal ?? 0,
    priceTier,
    priceLabel,
    priceConfirmed,
    address: p.address ?? '',
    neighborhood: extractNeighborhood(p.address),
    location: p.location ?? { lat: 0, lng: 0 },
    openingHours: p.openingHours,
    openNow: p.openNow,
    photoUrl: p.photoUrl,
    cuisine: p.cuisine,
    websiteUrl: p.websiteUrl,
    bookingUrl: p.bookingUrl,
    availability: availabilityResult.slots,
    availabilityStatus: availabilityResult.status,
  };
}

/**
 * Results we never surface: a place with no booking link at all, or one we
 * checked successfully that has no open table near the requested time. Both
 * are dead ends for someone trying to book, so we omit them entirely.
 *
 * Anything with a bookable slot (green = near the time, or amber = another
 * time/date) stays, as does 'check_failed' (a booking link we couldn't read
 * — we don't want to hide a place that might actually be free).
 */
function isHiddenForResults(r: Restaurant): boolean {
  const hasBookable = (r.availability ?? []).some((s) => s.available);
  if (hasBookable) return false;
  const status = r.availabilityStatus ?? 'no_slots';
  return status === 'no_booking_link' || status === 'no_slots';
}

/**
 * Fallback card we emit when enrichment throws unexpectedly. Better to
 * show the user the basic Places-API info than to silently swallow a
 * restaurant in the stream.
 */
function degradedCard(p: Partial<Restaurant>): Restaurant {
  const tier = (p.priceTier ?? 0) as PriceTier;
  return {
    placeId: p.placeId!,
    name: p.name ?? 'Unknown',
    description: p.description ?? '',
    rating: p.rating ?? 0,
    userRatingsTotal: p.userRatingsTotal ?? 0,
    priceTier: tier,
    priceLabel: PRICE_LABELS[tier],
    // Only Places gave us this tier; treat >0 as confirmed, 0 as unknown so
    // price filtering keeps it rather than dropping a place we never priced.
    priceConfirmed: tier > 0,
    address: p.address ?? '',
    neighborhood: extractNeighborhood(p.address),
    location: p.location ?? { lat: 0, lng: 0 },
    openingHours: p.openingHours,
    openNow: p.openNow,
    photoUrl: p.photoUrl,
    cuisine: p.cuisine,
    websiteUrl: p.websiteUrl,
    bookingUrl: p.bookingUrl,
    availability: [],
    // Enrichment threw before we could check — we genuinely don't know.
    availabilityStatus: 'check_failed',
  };
}

/**
 * Last-resort price tier from cuisine + rating, in HK context.
 * Rules are intentionally conservative — when uncertain, we land on tier 3
 * ($101–200), which is the median HK dinner price.
 */
function defaultTierFromCuisine(cuisine: string | undefined, rating: number): PriceTier {
  const c = (cuisine ?? '').toLowerCase();
  // Fast-food / cafe / cha chaan teng / noodles
  if (/(fast.?food|noodle|cha.?chaan|cafe|coffee|bakery|tea)/.test(c)) return 1;
  // Fine dining / omakase / Michelin / kaiseki
  if (/(fine.?dining|omakase|kaiseki|michelin)/.test(c)) return 5;
  // Cuisine known but generic — bump by rating: 4.7+ likely upscale
  if (c) return rating >= 4.7 ? 4 : 3;
  // No cuisine info at all — pick the HK median
  return 3;
}

/**
 * Crude neighborhood extractor — Google addresses look like
 *   "Shop 1234, IFC Mall, 8 Finance St, Central, Hong Kong"
 * We grab the second-to-last comma-separated chunk as the neighborhood.
 */
function extractNeighborhood(address?: string): string | undefined {
  if (!address) return undefined;
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}
