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
 * Price resolution chain (priority order — what we DISPLAY):
 *   1. OpenRice `priceRangeId`     — PREFERRED for display, and FREE: it
 *                                    rides along in the availability JSON we
 *                                    already fetched; ~60-70% HK coverage
 *   2. Places API `priceLevel`     — instant fallback when not on OpenRice
 *   3. Google Maps histogram       — Playwright; only when 1 + 2 both failed
 *   4. OpenRice Playwright scrape  — only when 1–3 all failed; ~5s extra
 *   5. Claude estimate             — bundled into the description call
 *   6. Cuisine-aware default       — last resort so we never show N/A
 *
 * Why OpenRice first: its per-person band is HK-local and matches the
 * figure diners see on the booking page, whereas Places' coarse 4-level
 * `priceLevel` is a rougher signal. Ordering also helps SPEED — availability
 * is resolved first, which primes the OpenRice price cache, so most
 * restaurants get a confirmed price for free with no Google Maps scrape.
 *
 * Top-band exception: when the user filters for the "over $800" band,
 * Google Places' priceLevel is used in preference to OpenRice (steps 1 and 2
 * swap). OpenRice's scale tops out at a flat "Over $801" and can't separate
 * genuinely ultra-premium fine dining (Google VERY_EXPENSIVE → 6) from
 * regular fine dining (Google EXPENSIVE → 5); Places can. See enrichOne.
 */

import { NextRequest, NextResponse } from 'next/server';
import { searchPlaces } from '@/lib/googlePlaces';
import { areaBox } from '@/lib/hk-areas';
import { fetchGoogleMapsPrice } from '@/lib/google-reserve';
import { fetchPriceTier as fetchOpenRicePrice } from '@/lib/openrice';
import { getOpenRicePriceTier } from '@/lib/openrice-booking';
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

/**
 * Ranking-only score: a restaurant's star rating nudged up by a small bonus
 * for review volume, so a well-reviewed 4.7★ place isn't out-ranked by a 5.0★
 * place that only has a handful of ratings.
 *
 * IMPORTANT: this score is used ONLY to order the candidate pool. It is never
 * stored or shown — every card still displays the real Google rating
 * (p.rating). We deliberately don't mutate the rating itself.
 *
 * Bonus rule (per the product spec):
 *   - 0 at or below 150 reviews.
 *   - +0.02 for every COMPLETE 50 reviews above 150
 *     (200 reviews → +0.02, 250 → +0.04, …, 650 → +0.20).
 *   - total bonus capped at +0.20.
 *   - boosted score capped at 5.0 so it can never exceed a perfect rating.
 */
const REVIEW_BONUS_BASELINE = 150; // bonus only accrues above this many reviews
const REVIEW_BONUS_STEP = 50; // reviews per bonus increment
const REVIEW_BONUS_PER_STEP = 0.02; // points added per increment
const REVIEW_BONUS_CAP = 0.2; // maximum total bonus
function rankingScore(p: Partial<Restaurant>): number {
  const rating = p.rating ?? 0;
  const reviews = p.userRatingsTotal ?? 0;
  const steps = Math.floor((reviews - REVIEW_BONUS_BASELINE) / REVIEW_BONUS_STEP);
  const bonus = steps > 0 ? Math.min(steps * REVIEW_BONUS_PER_STEP, REVIEW_BONUS_CAP) : 0;
  return Math.min(rating + bonus, 5.0);
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
  // The area the user picked (e.g. "Central"). When it's one of our known HK
  // areas we confine the Google Places search to that area's bounding box —
  // a hard geographic filter, instead of relying on the soft "in <area>" text
  // hint that let other districts leak in. Unknown/custom or "Any area" → no
  // box → falls back to the HK-wide bias.
  const box = areaBox(sp.get('area'));

  // 1. Get candidate restaurants from Google.
  //
  // We fetch a wide pool (60) than we'll display so we can rank the best
  // places before paying the per-restaurant Playwright cost.
  //
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
  // 60 candidates requires 3 paged Places API calls (cap is 20/page).
  // Measured ~4.1s vs ~3.6s for 40 — the extra page adds only ~0.5s, and
  // it only affects this upfront step (enrichment is still capped at
  // MAX_ENRICH), so it buys a deeper ranking pool for negligible cost.
  const pool = await searchPlaces({
    textQuery: q,
    maxResults: 60,
    locationRestriction: box ? { low: box.low, high: box.high } : undefined,
  });

  // Rank by a review-volume-adjusted star score (see rankingScore): the real
  // rating plus a small bonus for having lots of reviews, so a 4.7★ place with
  // thousands of reviews isn't buried under a 5.0★ place with only a handful.
  // Ties broken by raw review count. This score is for ORDERING ONLY — the
  // rating shown to users is always the untouched Google value (p.rating).
  const ranked = [...pool].sort((a, b) => {
    const scoreDelta = rankingScore(b) - rankingScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    return (b.userRatingsTotal ?? 0) - (a.userRatingsTotal ?? 0);
  });
  // Pre-filter by price BEFORE paying the per-restaurant Playwright cost:
  // drop places whose Google-confirmed price is clearly outside the band
  // (more than one tier away — we allow one band either side per the user's
  // setting). Places with no price yet (tier 0) are kept; their real tier is
  // resolved during enrichment and re-checked there.
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
            restaurant = await enrichOne(p, dateTime, partySize, requestedTier);
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
  requestedTier: number,
): Promise<Restaurant> {
  const name = p.name ?? 'Unknown';
  const googlePlacesTier = p.priceTier ?? 0;
  const neighborhood = extractNeighborhood(p.address);

  // Identify what booking/availability signal Google Places itself gave us,
  // before we go out to OpenRice / Google Reserve. Places tells us *whether*
  // a place takes reservations (`reservable`), but never returns real-time
  // slots or a booking URL — so we log what's present and what isn't.
  const placesSignal = identifyPlacesBookingSignal(name, p);

  // The description (Claude) is independent of price/availability, so let
  // it run in the background while we resolve those.
  const describePromise = describeRestaurant({
    name,
    rating: p.rating ?? 0,
    priceLabel: '', // not known yet; resolved below
    cuisine: p.cuisine,
    editorial: p.description,
  });

  // Resolve availability FIRST. For OpenRice-covered restaurants this is a
  // ~200 ms JSON call that also primes the OpenRice price cache
  // (priceRangeId) as a side effect — which the price step below reads for
  // free, letting us skip the slow Google Maps scrape entirely.
  const availabilityResult = await fetchAvailability({
    placeId: p.placeId,
    reservable: placesSignal.reservable,
    bookingUrl: placesSignal.bookingLink,
    websiteUrl: p.websiteUrl,
    dateTime,
    partySize,
    restaurantName: name,
    // Neighborhood lets OpenRice disambiguate between branches of the
    // same restaurant name (e.g. "Sole Mio" Central vs Causeway Bay).
    neighborhood,
    location: p.location ?? { lat: 0, lng: 0 },
  });

  // Price resolution — see route docstring for the full chain.
  // `priceConfirmed` tracks whether the tier came from a real source
  // (OpenRice / Places / Maps) vs an estimate (Claude / cuisine default).
  //
  // By DEFAULT we display the OpenRice price in preference to Google Places:
  // OpenRice's per-person band is HK-local and matches what diners actually
  // see on the booking page, whereas Places' coarse 4-level `priceLevel` is a
  // rougher signal.
  //
  // EXCEPTION — the top "over $800" band (requestedTier 6): OpenRice's scale
  // tops out at a flat "Over $801", so it can't tell a genuinely ultra-premium
  // room (Caprice, Joël Robuchon — Google's VERY_EXPENSIVE → tier 6) apart
  // from a merely-pricey fine-dining spot (Google's EXPENSIVE → tier 5). When
  // the user is specifically filtering for this band, Google Places' price is
  // the better differentiator, so we prefer it here.
  const topBandMode = requestedTier === 6;
  let priceTier: PriceTier = 0;
  let priceConfirmed = false;
  let pricedByOpenRice = false;
  const orTier = getOpenRicePriceTier(name, neighborhood);
  if (topBandMode) {
    // Top-band filter: Google Places first (differentiates 5 vs 6), then OpenRice.
    if (googlePlacesTier > 0) {
      priceTier = googlePlacesTier;
      priceConfirmed = true;
    } else if (orTier > 0) {
      priceTier = orTier;
      priceConfirmed = true;
      pricedByOpenRice = true;
    }
  } else {
    // Default: OpenRice first (HK-local, matches the booking page), then Places.
    if (orTier > 0) {
      priceTier = orTier;
      priceConfirmed = true;
      pricedByOpenRice = true;
    } else if (googlePlacesTier > 0) {
      priceTier = googlePlacesTier;
      priceConfirmed = true;
    }
  }
  // Google Maps histogram — Playwright. Only when neither OpenRice nor Places
  // priced it. For OpenRice misses that fell through to the Reserve scraper,
  // the Maps page is already loaded, so this reuses that visit via the
  // promise-cache in lib/google-reserve.ts.
  if (priceTier === 0) {
    const mapsTier = await fetchGoogleMapsPrice(p.placeId!);
    if (mapsTier > 0) {
      priceTier = mapsTier;
      priceConfirmed = true;
    }
  }
  if (priceTier === 0) {
    // Conditional last-resort real source. OpenRice Playwright scrape ~4–6s.
    priceTier = await fetchOpenRicePrice(name);
    if (priceTier > 0) priceConfirmed = true;
  }
  const describe = await describePromise;
  const blurb = describe.description;
  if (priceTier === 0) priceTier = describe.estimatedPriceTier; // estimate
  if (priceTier === 0) priceTier = defaultTierFromCuisine(p.cuisine, p.rating ?? 0); // estimate
  // Override: trust Places API's top-tier label over a capped Maps signal —
  // but NOT over an OpenRice price, which we prefer to display.
  if (!pricedByOpenRice && googlePlacesTier === 6 && priceTier < 6) {
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
 * What Google Places (New) tells us about a restaurant's booking situation.
 * Deliberately small: Places exposes only a `reservable` boolean. It does
 * NOT return real-time availability (a slot list) or a dedicated booking
 * URL, so those always come from OpenRice / Google Reserve downstream.
 */
interface PlacesBookingSignal {
  /** Places' own flag: does this place take reservations? undefined = unknown. */
  reservable?: boolean;
  /** A usable booking link from Places — Places has no such field today, so
   *  this is effectively always undefined; kept for forward compatibility. */
  bookingLink?: string;
}

/**
 * Inspect (and log) the booking/availability data Google Places returned for
 * one restaurant, so we can see at a glance how much we're relying on the
 * downstream OpenRice / Reserve lookups. Returns the signal so the caller can
 * feed it into the availability stage.
 */
function identifyPlacesBookingSignal(name: string, p: Partial<Restaurant>): PlacesBookingSignal {
  const reservable = p.reservable;
  const bookingLink = p.bookingUrl; // Places (New) exposes no booking-URL field
  const reservableStr = reservable === true ? 'yes' : reservable === false ? 'no' : 'unknown';
  console.debug(
    `[places] "${name}": reservable=${reservableStr}; realtime-slots=none; ` +
      `booking-link=${bookingLink ? 'yes' : 'none'}`,
  );
  return { reservable, bookingLink };
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
