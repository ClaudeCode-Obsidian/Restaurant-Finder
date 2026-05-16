/**
 * GET /api/restaurants?q=...&dateTime=...&partySize=...
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

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = sp.get('q')?.trim();
  if (!q) return NextResponse.json({ error: 'Missing q' }, { status: 400 });

  const dateTime = sp.get('dateTime') || new Date().toISOString();
  const partySize = parseInt(sp.get('partySize') ?? '2', 10);

  // 1. Get candidate restaurants from Google.
  const places = await searchPlaces({
    textQuery: q,
    maxResults: 12, // 12 keeps the UI dense but the cost low
  });

  // 2. Enrich each in parallel.
  const enriched = await Promise.all(
    places.map(async (p): Promise<Restaurant> => {
      const name = p.name ?? 'Unknown';
      const googlePlacesTier = p.priceTier ?? 0;
      // fetchGoogleMapsPrice + fetchAvailability *share* a Maps page visit
      // via promise-cache in lib/google-reserve.ts — only one Playwright
      // navigation happens per restaurant even though we kick off both here.
      const [mapsPriceTier, describe, availability] = await Promise.all([
        fetchGoogleMapsPrice(p.placeId!),
        describeRestaurant({
          name,
          rating: p.rating ?? 0,
          priceLabel: '', // not known yet; we pass after the inner await chain
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
          location: p.location ?? { lat: 0, lng: 0 },
        }),
      ]);
      const blurb = describe.description;

      // Price resolution — priority order:
      //   1. Places API priceLevel (instant, came back with the search response)
      //   2. Google Maps histogram (Playwright visit, but shared with the
      //      Reserve booking-URL discovery so already paid for)
      //   3. OpenRice scrape (separate Playwright visit — slow, so only
      //      fire when the first two failed)
      //   4. Claude's per-restaurant estimate
      //   5. Cuisine-aware hardcoded default — guarantees we never show N/A
      //
      // Calibration: Google's Maps histogram caps display at $500+ for ALL
      // upper-tier HK places, so it can't distinguish tier 5 from tier 6.
      // When Places API says VERY_EXPENSIVE we override a capped Maps tier
      // back up to 6.
      let priceTier: PriceTier =
        googlePlacesTier > 0 ? googlePlacesTier
        : mapsPriceTier > 0 ? mapsPriceTier
        : 0;
      if (priceTier === 0) {
        // Conditional: only ~30% of restaurants reach this — Places + Maps
        // already covered the rest. OpenRice scrape is ~4–6s per restaurant.
        priceTier = await fetchOpenRicePrice(name);
      }
      if (priceTier === 0) priceTier = describe.estimatedPriceTier;
      if (priceTier === 0) priceTier = defaultTierFromCuisine(p.cuisine, p.rating ?? 0);
      // Override: trust Places API's top-tier label over a capped Maps signal.
      if (googlePlacesTier === 6 && priceTier < 6) priceTier = 6;
      const priceLabel = PRICE_LABELS[priceTier];
      return {
        placeId: p.placeId!,
        name,
        description: blurb,
        rating: p.rating ?? 0,
        userRatingsTotal: p.userRatingsTotal ?? 0,
        priceTier,
        priceLabel,
        address: p.address ?? '',
        neighborhood: extractNeighborhood(p.address),
        location: p.location ?? { lat: 0, lng: 0 },
        openingHours: p.openingHours,
        openNow: p.openNow,
        photoUrl: p.photoUrl,
        cuisine: p.cuisine,
        websiteUrl: p.websiteUrl,
        bookingUrl: p.bookingUrl,
        availability,
      };
    })
  );

  return NextResponse.json({ restaurants: enriched, dateTime, partySize, q });
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
