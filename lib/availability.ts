/**
 * Availability lookup.
 *
 * Reservation systems are fragmented (OpenTable, Inline, SevenRooms, Bistrochat,
 * Chope, restaurant-owned widgets…). Real-time availability for ALL of them is
 * impossible to scrape reliably. Instead:
 *
 *   1. We classify the booking URL by domain.
 *   2. For platforms we recognise, we attempt their public availability endpoint.
 *   3. For everything else, we surface the booking URL so the user can click through.
 *
 * For now we implement OpenTable (the most common in HK) and a graceful
 * "unknown platform" fallback. Adding more platforms = adding more functions
 * with the same signature.
 */

import type { TimeSlot } from './types';

export interface AvailabilityInput {
  bookingUrl?: string;
  websiteUrl?: string;
  /** ISO 8601 date/time the user wants to dine. */
  dateTime: string;
  partySize: number;
  restaurantName: string;
  location: { lat: number; lng: number };
}

export async function fetchAvailability(input: AvailabilityInput): Promise<TimeSlot[]> {
  const url = input.bookingUrl ?? input.websiteUrl;
  if (!url) return placeholderSlots(input);

  const host = safeHost(url);
  try {
    if (host.includes('opentable')) return await openTableSlots(input);
    // Add more platforms here as you support them:
    //   if (host.includes('inline-app.com')) return await inlineSlots(input);
    //   if (host.includes('sevenrooms.com'))  return await sevenRoomsSlots(input);
  } catch {
    // fall through to placeholder
  }
  return placeholderSlots(input);
}

/* ─────────── OpenTable ─────────── */

/**
 * OpenTable exposes a search endpoint that returns time slots near a given
 * time. We re-use the public web search API rather than the internal mobile
 * one because it's URL-stable and doesn't require auth.
 */
async function openTableSlots(input: AvailabilityInput): Promise<TimeSlot[]> {
  const target = new Date(input.dateTime);
  const isoMin = target.toISOString().slice(0, 19);
  const params = new URLSearchParams({
    dateTime: isoMin,
    covers: String(input.partySize),
    term: input.restaurantName,
    latitude: String(input.location.lat),
    longitude: String(input.location.lng),
    shouldUseLatLongSearch: 'true',
  });
  const res = await fetch(`https://www.opentable.com/dapi/fe/gql?${params}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 RestaurantFinder/0.1' },
  });
  if (!res.ok) return placeholderSlots(input);
  // OpenTable returns a complex GraphQL payload. Parsing it fully is out of
  // scope here; we extract any "slots" array we can find via regex on the JSON.
  const text = await res.text();
  const slots: TimeSlot[] = [];
  const re = /"timeSlot"\s*:\s*"([^"]+)"[^}]*?"available"\s*:\s*(true|false)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && slots.length < 5) {
    slots.push({ time: m[1], available: m[2] === 'true' });
  }
  return slots.length ? slots : placeholderSlots(input);
}

/* ─────────── Fallback ─────────── */

/**
 * When we cannot determine real availability, generate a few suggested times
 * around the requested time. We mark them "available: false" so the UI shows
 * them as "Check availability" rather than promising a booking we can't fulfil.
 */
function placeholderSlots(input: AvailabilityInput): TimeSlot[] {
  const target = new Date(input.dateTime);
  const offsetsMin = [-30, -15, 0, 15, 30];
  return offsetsMin.map((delta) => {
    const d = new Date(target.getTime() + delta * 60_000);
    return {
      time: d.toISOString(),
      available: false,
      bookingUrl: input.bookingUrl ?? input.websiteUrl,
    };
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}
