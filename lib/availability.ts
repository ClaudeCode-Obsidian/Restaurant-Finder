/**
 * Availability lookup, in priority order:
 *
 *   1. OpenRice         (JSON, ~200 ms) — primary; covers ~60-70% of HK
 *   2. Google Reserve   (Playwright, ~3–5 s) — broadest fallback;
 *                          proxies to OpenTable / Inline / BistroChat /
 *                          SevenRooms / Chope via Google's Reserve UI
 *   3. Placeholder      — last resort, marked unavailable
 *
 * Each tier returns `[]` to mean "I couldn't help here, try the next
 * source." Only a non-empty result short-circuits the chain.
 *
 * BistroChat was previously a Tier 2 between OpenRice and Google
 * Reserve. It was removed because its `/get-availability` endpoint
 * returns only a WEEKLY TEMPLATE — "this restaurant takes bookings at
 * these times in general" — not a real-time per-date slot count. The
 * user can't trust those slots are actually available, so we prefer
 * Google Reserve's real-time slot scrape (which is slower but
 * minute-accurate) over BistroChat's faster but unreliable template.
 *
 * Coverage note: removing BistroChat costs ~1 restaurant per 8 in HK
 * Central searches (Pici-class places that only OpenRice ignores and
 * Google Reserve does cover). Net effect: same hit rate, more accurate
 * slot data, slower tail latency (~3 s) for the affected restaurants.
 *
 * The earlier 4-way parallel race across OpenTable / SevenRooms / Chope
 * / Inline was removed in a previous turn: for HK Italian Central
 * queries it never won (Hong Kong coverage on those platforms is too
 * sparse), and it added ~2-3 s of dead time to every OpenRice miss.
 * If we expand to non-HK markets where those platforms have real
 * footprint, restore the race from git history.
 *
 * IMPORTANT: Both partner endpoints (OpenRice, Google Reserve) are
 * reverse-engineered from each platform's own widget. Neither is
 * officially supported. When a partner changes their API the function
 * falls through to the next source — the app degrades gracefully.
 */

import { fetchReserveSlots } from './google-reserve';
import { fetchOpenRiceSlots } from './openrice-booking';
import type { AvailabilityStatus, TimeSlot } from './types';

export interface AvailabilityInput {
  /** Google Places place_id — used to look up the Google Reserve URL. */
  placeId?: string;
  /** Google's reservable flag; skip the expensive Reserve dance when false. */
  reservable?: boolean;
  bookingUrl?: string;
  websiteUrl?: string;
  /** ISO 8601 user-requested date/time. */
  dateTime: string;
  partySize: number;
  restaurantName: string;
  /** Neighborhood / district for OpenRice POI disambiguation. */
  neighborhood?: string;
  location: { lat: number; lng: number };
}

export interface AvailabilityResult {
  slots: TimeSlot[];
  status: AvailabilityStatus;
}

export async function fetchAvailability(input: AvailabilityInput): Promise<AvailabilityResult> {
  // ┌─────────────────────────────────────────────────────────────────┐
  // │ TIER 1 — OpenRice (~200 ms, real-time, ~60-70% HK coverage).    │
  // └─────────────────────────────────────────────────────────────────┘
  const orSlots = await fetchOpenRiceSlots({
    restaurantName: input.restaurantName,
    districtHint: input.neighborhood,
    dateTime: input.dateTime,
    partySize: input.partySize,
  }).catch(() => [] as TimeSlot[]);
  if (orSlots.length > 0) return { slots: orSlots, status: 'available' };

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ TIER 2 — Google Reserve via Playwright (~3-5 s, real-time).     │
  // │ Slow but proxies to almost every booking partner via Google.    │
  // │ Drives the date picker to the user's requested day, then        │
  // │ reads `data-bts` slot timestamps from the rendered DOM.         │
  // └─────────────────────────────────────────────────────────────────┘
  if (input.placeId && input.reservable !== false) {
    let reserve = await fetchReserveSlots({
      placeId: input.placeId,
      dateTime: input.dateTime,
      partySize: input.partySize,
    });
    // A 'failed' outcome is usually a transient load/timeout (slow page,
    // momentary contention) rather than a real "no booking" — give it one
    // more try before we downgrade to the "couldn't confirm" message.
    if (reserve.slots.length === 0 && reserve.status === 'failed') {
      reserve = await fetchReserveSlots({
        placeId: input.placeId,
        dateTime: input.dateTime,
        partySize: input.partySize,
      });
    }
    if (reserve.slots.length > 0) {
      return { slots: reserve.slots, status: 'available' };
    }
    // No slots — translate WHY into a user-facing status. A failed scrape
    // ('failed') becomes "couldn't confirm"; a hydrated-but-empty page
    // ('no_slots') becomes "nothing near your time"; a missing booking
    // link ('no_link') becomes "no booking link".
    const status: AvailabilityStatus =
      reserve.status === 'failed'
        ? 'check_failed'
        : reserve.status === 'no_slots'
          ? 'no_slots'
          : 'no_booking_link';
    return { slots: placeholderSlots(input), status };
  }

  // No placeId, or Google says it isn't reservable → no booking system.
  return { slots: placeholderSlots(input), status: 'no_booking_link' };
}

/**
 * Fallback when we can't determine real availability.
 * Times centered on the requested time; marked unavailable so the UI shows
 * them as "click to confirm on booking site" rather than promising a
 * booking we can't deliver.
 */
function placeholderSlots(input: AvailabilityInput): TimeSlot[] {
  const target = new Date(input.dateTime);
  return [-30, -15, 0, 15, 30].map((delta) => {
    const d = new Date(target.getTime() + delta * 60_000);
    return {
      time: d.toISOString(),
      available: false,
      bookingUrl: input.bookingUrl ?? input.websiteUrl,
    };
  });
}
