/**
 * OpenRice booking API — primary availability source.
 *
 * Two undocumented but public JSON endpoints, reverse-engineered from
 * the OpenRice booking widget on www.openrice.com:
 *
 *   1. POI search   GET /api/v2/search?what=<name>&uiCity=hongkong
 *      → returns [{ poiId, name, district }, ...]
 *
 *   2. Availability GET /api/v2/booking/picker?poiId=<id>&seat=<n>
 *                          &bookingDate=YYYY-MM-DD&timeSlot=HH:MM
 *      → returns { isAvailable, isBookingDisabled,
 *                  body: { timeSlots: [{timeSlot:"19:00", isDisabled, ...}] },
 *                  availableDate: [{readable_Date, isSelected}, ...] }
 *
 * Why this is the primary path now:
 *   - ~200 ms per restaurant (pure HTTP) vs ~3–5 s for the Google
 *     Reserve Playwright dance.
 *   - Returns slots for any date in a 90-day window — no flaky
 *     date-picker click required.
 *   - Three clean response states (bookable / disabled / 404) we can
 *     map directly to our green / amber / fallback UI.
 *
 * Coverage caveat: ~60–70% of HK Central restaurants are on OpenRice
 * TMS. Misses (Pici Central, DIECI, Yardbird, …) fall through to the
 * existing Google Reserve scraper.
 *
 * Stability caveat: undocumented internal API. If OpenRice changes the
 * shape, all callers degrade gracefully — fetchOpenRiceSlots returns
 * [], which lets fetchAvailability fall through.
 */

import type { TimeSlot } from './types';

const BASE = 'https://www.openrice.com';
const HK_TZ = 'Asia/Hong_Kong';
const SLOT_WINDOW_MIN = 60; // ±60 min around target time for "in window"
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ─────────── POI ID resolution (with cache) ─────────── */

/**
 * In-memory cache keyed by `${name}|${district ?? ''}`. POI IDs are
 * extremely stable (OpenRice doesn't recycle them across restaurant
 * closures), so a process-lifetime cache is fine here. Values can be
 * `null` to remember misses and avoid re-querying.
 */
const _poiCache = new Map<string, number | null>();

interface SearchHit {
  poiId: number;
  name: string;
  district?: { name?: string };
}

/**
 * Resolve a restaurant name (+ optional district/neighborhood hint) to
 * an OpenRice poiId. Returns null when no match is found.
 *
 * Disambiguation: OpenRice search returns up to 5 results ranked by
 * relevance. We prefer:
 *   1. Result whose district.name matches the provided hint (case-insensitive).
 *   2. Otherwise the first result.
 *
 * Why the hint matters: "Sole Mio" returns multiple branches; without
 * a district hint we'd pick the wrong one and report wrong availability.
 */
export async function searchOpenRicePoi(
  name: string,
  districtHint?: string,
): Promise<number | null> {
  const key = `${name.toLowerCase()}|${(districtHint ?? '').toLowerCase()}`;
  if (_poiCache.has(key)) return _poiCache.get(key)!;

  try {
    const url =
      `${BASE}/api/v2/search?uiLang=en&uiCity=hongkong&rows=5&what=` +
      encodeURIComponent(name);
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    if (!res.ok) {
      _poiCache.set(key, null);
      return null;
    }
    const data = (await res.json()) as {
      paginationResult?: { results?: SearchHit[] };
      searchedPoi?: SearchHit[];
    };
    // OpenRice's search response shape varies — sometimes
    // `paginationResult.results`, sometimes `searchedPoi`.
    const results = data.paginationResult?.results ?? data.searchedPoi ?? [];
    if (results.length === 0) {
      _poiCache.set(key, null);
      return null;
    }

    let pick: SearchHit | undefined;
    if (districtHint) {
      const hint = districtHint.toLowerCase();
      pick = results.find((r) =>
        (r.district?.name ?? '').toLowerCase().includes(hint),
      );
    }
    pick ??= results[0];
    _poiCache.set(key, pick.poiId);
    return pick.poiId;
  } catch {
    _poiCache.set(key, null);
    return null;
  }
}

/* ─────────── Availability picker ─────────── */

export interface BookingInput {
  restaurantName: string;
  /** Optional district/neighborhood for POI disambiguation. */
  districtHint?: string;
  /** ISO 8601 target. We split into HK-local date + time for the API. */
  dateTime: string;
  partySize: number;
}

interface PickerSlot {
  timeSlot: string; // "HH:MM"
  isDisabled?: boolean;
  isSuggested?: boolean;
  availableSeats?: number;
}

interface PickerResponse {
  isAvailable?: boolean;
  isBookingDisabled?: boolean;
  bookingDate?: string;
  /**
   * The picker response wraps slots under `bookingWidget.timeSlots`.
   *
   * (Don't confuse this with the unrelated `/api/v2/booking/preview`
   * POST endpoint, which uses `body.timeSlots` — that's the next step
   * in the booking funnel, not the availability lookup. Mixing those
   * shapes up will make every restaurant look unavailable.)
   */
  bookingWidget?: {
    isAvailable?: boolean;
    isBookingDisabled?: boolean;
    timeSlots?: PickerSlot[];
  };
  // Error case for 4xx wrapped responses
  success?: boolean;
  error?: { httpCode?: number };
}

/**
 * Fetch availability slots from OpenRice for one restaurant. Returns
 * the standardised TimeSlot[] that the rest of the app consumes.
 *
 * Behaviour:
 *   - Restaurant not on OpenRice TMS (404)            → []  (fall through)
 *   - In system but booking disabled / no slots       → []  (fall through)
 *   - Slots exist, some within ±60 min of target time → those slots, available=true
 *   - Slots exist but all outside target window       → 5 earliest, flagged
 *                                                        nextAvailableTime: true
 *
 * The caller (fetchAvailability) treats [] as "I couldn't help, try
 * the next source" — never as "definitely no booking exists."
 */
export async function fetchOpenRiceSlots(input: BookingInput): Promise<TimeSlot[]> {
  const poiId = await searchOpenRicePoi(input.restaurantName, input.districtHint);
  if (poiId == null) return [];

  const target = new Date(input.dateTime);
  // The API expects date + time in HK-local terms. Build them via
  // Intl.DateTimeFormat so DST/offset edge cases can't bite.
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: HK_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: HK_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const bookingDate = dateFmt.format(target); // "YYYY-MM-DD"
  const timeSlot = timeFmt.format(target).slice(0, 5); // "HH:MM"

  const url =
    `${BASE}/api/v2/booking/picker?poiId=${poiId}&countryCode=HK&seat=${input.partySize}` +
    `&timeSlot=${encodeURIComponent(timeSlot)}&bookingDate=${bookingDate}` +
    `&uiLang=en&uiCity=hongkong`;

  let data: PickerResponse;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    // 404 means "not on OpenRice TMS." Anything else non-OK is a
    // transient failure — also fall through.
    if (!res.ok) return [];
    data = (await res.json()) as PickerResponse;
  } catch {
    return [];
  }

  // Some responses come back wrapped: {success: false, error: {httpCode: 404}}.
  if (data.success === false) return [];
  // Check both the top-level flags AND the nested bookingWidget flags.
  // The two layers can disagree — `isAvailable` at top level means
  // "this restaurant has booking", while `bookingWidget.isAvailable`
  // means "slots exist for the requested date". We want the slots-exist
  // signal; bail if either says no.
  if (data.isBookingDisabled || data.bookingWidget?.isBookingDisabled) return [];
  if (data.isAvailable === false || data.bookingWidget?.isAvailable === false) return [];

  const slots = data.bookingWidget?.timeSlots ?? [];
  const enabled = slots.filter((s) => !s.isDisabled);
  if (enabled.length === 0) return [];

  const bookingUrl = buildBookingUrl(poiId, bookingDate, input.partySize, timeSlot);

  // Convert each "HH:MM" into a full ISO datetime in HK time.
  const targetMs = target.getTime();
  const windowMs = SLOT_WINDOW_MIN * 60_000;
  const slotsWithMs = enabled.map((s) => ({
    s,
    ms: combineHkDateTime(bookingDate, s.timeSlot),
  }));

  const inWindow = slotsWithMs.filter(({ ms }) => Math.abs(ms - targetMs) <= windowMs);

  // Right date + slots near the requested time → CONFIRMED slots.
  if (inWindow.length > 0) {
    return inWindow.slice(0, 5).map(({ ms }) => ({
      time: new Date(ms).toISOString(),
      available: true,
      bookingUrl,
    }));
  }

  // Right date but no slots within the user's time window — the
  // restaurant only does lunch when the user asked for dinner, or
  // similar. Surface the 5 earliest, flagged so the UI shows
  // amber "Other times on <date>" rather than green.
  return slotsWithMs
    .sort((a, b) => a.ms - b.ms)
    .slice(0, 5)
    .map(({ ms }) => ({
      time: new Date(ms).toISOString(),
      available: true,
      bookingUrl,
      nextAvailableTime: true,
    }));
}

/* ─────────── Helpers ─────────── */

/**
 * Combine "YYYY-MM-DD" + "HH:MM" → ms-since-epoch, interpreted in HK time.
 *
 * HK is UTC+8 with no daylight saving — straightforward. We avoid
 * `Date.parse('YYYY-MM-DDTHH:MM:00')` (which uses local TZ) by
 * constructing the UTC moment directly.
 */
function combineHkDateTime(dateStr: string, hhmm: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mm] = hhmm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h - 8, mm); // HK = UTC+8
}

/**
 * OpenRice's booking-creation URL. Clicking this deep-links the user
 * into a pre-filled booking flow for the slot they chose.
 *
 * Captured from the live widget; uses URL-fragment params (after `#`)
 * rather than query params, which OpenRice's SPA reads client-side.
 */
function buildBookingUrl(
  poiId: number,
  bookingDate: string,
  seat: number,
  timeSlot: string,
): string {
  const frag = new URLSearchParams({
    bookingDate,
    seat: String(seat),
    timeSlot,
  }).toString();
  return `${BASE}/en/hongkong/booking/create/${poiId}#${frag}`;
}
