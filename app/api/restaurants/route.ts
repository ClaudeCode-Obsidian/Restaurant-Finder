/**
 * GET /api/restaurants?q=...&dateTime=...&partySize=...
 *
 * The fan-out endpoint. For each Google Places result we kick off, IN PARALLEL:
 *   - Google Maps price-tier scrape (one Playwright visit, shared with the
 *     Reserve URL discovery via fetchMapsData promise-cache)
 *   - Claude-generated description
 *   - Availability lookup
 *
 * We use Promise.all so all three run concurrently per restaurant. Sequential
 * would be O(N × 3) round-trips; parallel is O(N) which keeps the page snappy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { searchPlaces } from '@/lib/googlePlaces';
import { fetchGoogleMapsPrice } from '@/lib/google-reserve';
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
      // Four-tier fallback for price (each step kicks in only if prior was 0):
      //   1. Google Maps price-range histogram — accurate HKD ranges, free
      //      from the same Playwright visit we use for the Reserve URL.
      //   2. Google Places `priceLevel` enum — sparse in HK (chains only).
      //   3. Claude's estimate from cuisine + rating + name.
      //   4. Cuisine-aware hardcoded default — guarantees we never show N/A.
      const priceTier =
        mapsPriceTier > 0 ? mapsPriceTier
        : googlePlacesTier > 0 ? googlePlacesTier
        : describe.estimatedPriceTier > 0 ? describe.estimatedPriceTier
        : defaultTierFromCuisine(p.cuisine, p.rating ?? 0);
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
