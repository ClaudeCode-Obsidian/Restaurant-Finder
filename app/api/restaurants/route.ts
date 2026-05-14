/**
 * GET /api/restaurants?q=...&dateTime=...&partySize=...
 *
 * The fan-out endpoint. For each Google Places result we kick off, IN PARALLEL:
 *   - OpenRice price tier lookup
 *   - Claude-generated description
 *   - Availability lookup (best-effort)
 *
 * We use Promise.all so all three run concurrently per restaurant. Sequential
 * would be O(N × 3) round-trips; parallel is O(N) which keeps the page snappy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { searchPlaces } from '@/lib/googlePlaces';
import { fetchPriceTier } from '@/lib/openrice';
import { fetchAvailability } from '@/lib/availability';
import { describeRestaurant } from '@/lib/claude';
import { PRICE_LABELS, type Restaurant } from '@/lib/types';

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
      const [priceTier, blurb, availability] = await Promise.all([
        fetchPriceTier(name),
        describeRestaurant({
          name,
          rating: p.rating ?? 0,
          priceLabel: '', // not known yet; we pass after the inner await chain
          cuisine: p.cuisine,
          editorial: p.description,
        }),
        fetchAvailability({
          bookingUrl: p.bookingUrl,
          websiteUrl: p.websiteUrl,
          dateTime,
          partySize,
          restaurantName: name,
          location: p.location ?? { lat: 0, lng: 0 },
        }),
      ]);
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
 * Crude neighborhood extractor — Google addresses look like
 *   "Shop 1234, IFC Mall, 8 Finance St, Central, Hong Kong"
 * We grab the second-to-last comma-separated chunk as the neighborhood.
 */
function extractNeighborhood(address?: string): string | undefined {
  if (!address) return undefined;
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}
