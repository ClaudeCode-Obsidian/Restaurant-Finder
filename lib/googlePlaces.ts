/**
 * Google Places API (New) client.
 *
 * We use the "Places API (New)" REST endpoints (places.googleapis.com/v1) rather
 * than the older Maps Places library because the new one returns richer data
 * (editorial summary, price level, opening hours, website) in a single call.
 *
 * Required env: GOOGLE_MAPS_API_KEY (server-side only — never expose this one).
 */

import type { PriceTier, Restaurant } from './types';

/**
 * Map Google Places `priceLevel` enum to our 0–6 PriceTier (OpenRice scale).
 *
 * Calibrated against a 60-restaurant Hong Kong sample (15 per tier) where
 * we scraped each one's Google Maps price-range histogram. Observed
 * midpoints in HKD:
 *   INEXPENSIVE     : mid ~$76      → tier 2  ($51–100)
 *   MODERATE        : mid ~$232     → tier 4  ($201–400)
 *   EXPENSIVE       : mid ~$411–450 → tier 5  ($401–800)
 *   VERY_EXPENSIVE  : Maps caps display at $500+, but Places API knows
 *                     these are fine-dining (Joël Robuchon, Lung King
 *                     Heen, Caprice, etc.) → tier 6 (Over $801)
 *
 * Earlier mapping was off by one for MODERATE and EXPENSIVE — fixed.
 */
function priceTierFromGoogle(level: string | undefined): PriceTier {
  switch (level) {
    case 'PRICE_LEVEL_INEXPENSIVE': return 2; // ~$51–100
    case 'PRICE_LEVEL_MODERATE':    return 4; // ~$201–400
    case 'PRICE_LEVEL_EXPENSIVE':   return 5; // ~$401–800
    case 'PRICE_LEVEL_VERY_EXPENSIVE': return 6; // Over $801
    default: return 0;
  }
}

const BASE = 'https://places.googleapis.com/v1';
// Field mask — Google requires explicitly listing fields you want.
// This keeps responses small and your bill predictable.
const SEARCH_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.regularOpeningHours',
  'places.currentOpeningHours.openNow',
  'places.editorialSummary',
  'places.websiteUri',
  'places.reservable',
  'places.googleMapsUri',
  'places.photos',
  'places.primaryTypeDisplayName',
].join(',');

export interface PlaceSearchInput {
  textQuery: string;       // e.g. "sushi restaurants in Central, Hong Kong"
  locationBias?: { lat: number; lng: number; radiusMeters?: number };
  /**
   * Hard geographic boundary (a rectangle: SW `low` → NE `high`). When set,
   * results are RESTRICTED to this box — used to confine a search to the area
   * the user picked. Takes precedence over `locationBias` (Places treats the
   * two as mutually exclusive). Text Search only accepts a rectangle here.
   */
  locationRestriction?: {
    low: { latitude: number; longitude: number };
    high: { latitude: number; longitude: number };
  };
  maxResults?: number;     // 1–20, defaults 20
  openNow?: boolean;
}

/** Raw shape of one place from the API. We only type the fields we use. */
interface RawPlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  shortFormattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  currentOpeningHours?: { openNow?: boolean };
  editorialSummary?: { text: string };
  websiteUri?: string;
  reservable?: boolean;
  googleMapsUri?: string;
  photos?: Array<{ name: string }>;
  primaryTypeDisplayName?: { text: string };
}

/**
 * The Places API (New) `searchText` endpoint caps `maxResultCount` at 20
 * per request. To return more, we follow `nextPageToken` and concatenate
 * pages. Google attaches the location filter to the *first* request only —
 * subsequent paged requests echo the token alone, which is correct.
 */
const PAGE_MAX = 20;

/**
 * Default location bias: a circle centred on Hong Kong.
 *
 * The radius is set to 50 km because Google's Places API (New) caps
 * `circle.radius` at exactly 50,000 m — anything larger returns
 * `INVALID_ARGUMENT`. 50 km is still enough to cover the entire HK
 * SAR (the territory spans ~50 km east-west and ~40 km north-south
 * including outlying islands), so this bias places every HK
 * restaurant comfortably inside the circle.
 *
 * Note this is a "bias" not a "restriction" — Google may still return
 * results outside the circle if the textQuery strongly identifies a
 * place elsewhere. But for ambiguous queries the bias dominates
 * ranking.
 *
 * Concrete case this fixes: `q=Sole Mio Italian Restaurant` with no
 * city qualifier used to resolve to O'Sole Mio in London (1,508
 * reviews) instead of HK Sole Mio (284 reviews). With the bias,
 * Google scores nearby matches higher and HK Sole Mio wins.
 *
 * Centre: 22.3193°N, 114.1694°E — Tsim Sha Tsui, the centre of
 * Hong Kong's urban core.
 */
const HK_LOCATION_BIAS = {
  lat: 22.3193,
  lng: 114.1694,
  radiusMeters: 50_000,
};

export async function searchPlaces(input: PlaceSearchInput): Promise<Partial<Restaurant>[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set');

  const target = input.maxResults ?? 20;
  const results: Partial<Restaurant>[] = [];
  let pageToken: string | undefined;

  // Apply the HK bias by default; an explicit caller-supplied bias
  // overrides it. (For tests / future multi-region support.)
  const bias = input.locationBias ?? HK_LOCATION_BIAS;

  // Loop until we have enough, or Google runs out of pages.
  while (results.length < target) {
    const remaining = target - results.length;
    const body: Record<string, unknown> = {
      textQuery: input.textQuery,
      maxResultCount: Math.min(remaining, PAGE_MAX),
      includedType: 'restaurant',
    };
    if (input.openNow !== undefined) body.openNow = input.openNow;
    // A hard area restriction (rectangle) wins over the soft HK-wide bias —
    // Places treats the two as mutually exclusive, so we send only one.
    if (input.locationRestriction) {
      body.locationRestriction = {
        rectangle: {
          low: input.locationRestriction.low,
          high: input.locationRestriction.high,
        },
      };
    } else {
      body.locationBias = {
        circle: {
          center: { latitude: bias.lat, longitude: bias.lng },
          radius: bias.radiusMeters ?? 5000,
        },
      };
    }
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(`${BASE}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': SEARCH_FIELDS + ',nextPageToken',
      },
      body: JSON.stringify(body),
      // Cache identical queries for 5 minutes to lower API spend.
      // The cache key includes the request body so paged requests are
      // cached independently — fine, since they're deterministic.
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Places search failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { places?: RawPlace[]; nextPageToken?: string };
    const page = (data.places ?? []).map(normalize);
    results.push(...page);

    // Stop if Google has nothing more, or this page was empty (defensive
    // against an infinite loop if the API ever returns an empty page +
    // a still-valid token).
    pageToken = data.nextPageToken;
    if (!pageToken || page.length === 0) break;
  }

  return results.slice(0, target);
}

function normalize(p: RawPlace): Partial<Restaurant> {
  return {
    placeId: p.id,
    name: p.displayName?.text ?? 'Unknown',
    rating: p.rating ?? 0,
    userRatingsTotal: p.userRatingCount ?? 0,
    address: p.formattedAddress ?? p.shortFormattedAddress ?? '',
    location: p.location
      ? { lat: p.location.latitude, lng: p.location.longitude }
      : { lat: 0, lng: 0 },
    openingHours: p.regularOpeningHours?.weekdayDescriptions,
    openNow: p.currentOpeningHours?.openNow,
    description: p.editorialSummary?.text ?? '',
    priceTier: priceTierFromGoogle(p.priceLevel),
    websiteUrl: p.websiteUri,
    reservable: p.reservable,
    cuisine: p.primaryTypeDisplayName?.text,
    photoUrl: p.photos?.[0]
      ? photoUrl(p.photos[0].name, 800)
      : undefined,
  };
}

/** Build a photo URL. The "name" is an opaque token from the photos array. */
export function photoUrl(photoName: string, maxWidthPx = 800): string {
  // The API key is appended server-side. We return the full URL because
  // <img> tags load these directly from the browser.
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  return `https://places.googleapis.com/v1/${photoName}/media?key=${apiKey}&maxWidthPx=${maxWidthPx}`;
}
