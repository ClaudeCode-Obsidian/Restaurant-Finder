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
 * Google has 4 meaningful restaurant tiers; we spread them across 0/2/3/4/6
 * so the labels still feel HK-priced.
 */
function priceTierFromGoogle(level: string | undefined): PriceTier {
  switch (level) {
    case 'PRICE_LEVEL_INEXPENSIVE': return 2; // ~$51–100
    case 'PRICE_LEVEL_MODERATE':    return 3; // ~$101–200
    case 'PRICE_LEVEL_EXPENSIVE':   return 4; // ~$201–400
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

export async function searchPlaces(input: PlaceSearchInput): Promise<Partial<Restaurant>[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set');

  const body: Record<string, unknown> = {
    textQuery: input.textQuery,
    maxResultCount: input.maxResults ?? 20,
    includedType: 'restaurant',
  };
  if (input.openNow !== undefined) body.openNow = input.openNow;
  if (input.locationBias) {
    body.locationBias = {
      circle: {
        center: { latitude: input.locationBias.lat, longitude: input.locationBias.lng },
        radius: input.locationBias.radiusMeters ?? 5000,
      },
    };
  }

  const res = await fetch(`${BASE}/places:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': SEARCH_FIELDS,
    },
    body: JSON.stringify(body),
    // Cache identical queries for 5 minutes to lower API spend.
    next: { revalidate: 300 },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Places search failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { places?: RawPlace[] };
  return (data.places ?? []).map(normalize);
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
