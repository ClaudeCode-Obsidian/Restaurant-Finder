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

import type { PriceTier, TimeSlot } from './types';

const BASE = 'https://www.openrice.com';
const HK_TZ = 'Asia/Hong_Kong';
const SLOT_WINDOW_MIN = 60; // ±60 min around target time for "in window"
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ─────────── Observability ─────────── */

/**
 * OpenRice is an undocumented API that fails in many quiet ways (rate-limit,
 * shape drift, coverage gap, booking cutoff). The old code swallowed every
 * one of these as a bare `[]`, so a search that silently fell through to the
 * slow Reserve scraper left no trace and was impossible to diagnose. We now
 * log a one-line, greppable reason for every non-success.
 *
 *   - 'warn'  → something unexpected (HTTP error, thrown fetch, bad shape).
 *               Worth noticing; may indicate the API changed or is blocking.
 *   - 'debug' → an expected, benign fall-through (not on OpenRice, booking
 *               disabled, no slots near the time). Normal for ~30–40% of
 *               restaurants; logged so the fall-through is still visible.
 */
function logOpenRice(level: 'warn' | 'debug', restaurant: string, reason: string): void {
  const msg = `[openrice] "${restaurant}": ${reason}`;
  if (level === 'warn') console.warn(msg);
  else console.debug(msg);
}

/* ─────────── Throttle + rate-limit-aware fetch ─────────── */

/**
 * OpenRice blocks bursty callers: when too many requests arrive at once it
 * stops returning JSON and serves an HTML "slow down" page (HTTP 200, body
 * starting with `<`). The old code called res.json() on that HTML, which threw
 * a SyntaxError we mistook for "restaurant not found" — silently dropping real
 * OpenRice coverage. This helper closes that hole with three guards:
 *
 *   1. THROTTLE — never more than OR_MAX_CONCURRENT OpenRice HTTP calls in
 *      flight at once (process-wide), plus a little JITTER, so a wave of 16
 *      enrichments doesn't hammer OpenRice in the same instant. This keeps us
 *      under the rate limit so the block page rarely appears at all — the most
 *      important guard.
 *   2. DETECT — before parsing, confirm the body really is JSON (content-type
 *      says json AND it doesn't start with `<`). An HTML block page is treated
 *      as a transient rate-limit, never as "not found".
 *   3. RETRY — on a block page / non-200 / network error, back off (a growing
 *      delay) and retry up to OR_MAX_RETRIES times before giving up.
 */
const OR_MAX_CONCURRENT = 4; // max simultaneous OpenRice HTTP calls, process-wide
const OR_MAX_RETRIES = 2; // extra attempts after the first (3 total)
const OR_BACKOFF_BASE_MS = 500; // retry backoff base; grows per attempt (~0.5s, ~1s)
const OR_JITTER_MS = 150; // small random spacing before each call

let _orActive = 0;
const _orWaiters: Array<() => void> = [];
async function orAcquire(): Promise<void> {
  if (_orActive < OR_MAX_CONCURRENT) {
    _orActive++;
    return;
  }
  await new Promise<void>((resolve) => _orWaiters.push(resolve));
  _orActive++;
}
function orRelease(): void {
  _orActive--;
  _orWaiters.shift()?.();
}
const orSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const orJitter = (base: number) => base + Math.floor(Math.random() * base); // base..2×base

/** Outcome of a throttled OpenRice GET: parsed JSON, or a transient block. */
type OrResult<T> = { data: T } | { rateLimited: true };

/**
 * Throttled, block-page-aware OpenRice JSON GET. Returns `{ data }` on success,
 * or `{ rateLimited: true }` when OpenRice blocked us / errored after all
 * retries — which callers treat as "couldn't reach OpenRice this time; fall
 * through and DON'T cache" (so it self-heals on the next search).
 */
async function openRiceJson<T>(url: string, restaurant: string): Promise<OrResult<T>> {
  for (let attempt = 0; attempt <= OR_MAX_RETRIES; attempt++) {
    if (attempt > 0) await orSleep(orJitter(OR_BACKOFF_BASE_MS) * attempt); // back off, growing
    await orAcquire();
    try {
      await orSleep(orJitter(OR_JITTER_MS)); // small spacing under the throttle
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
      });
      const ct = res.headers.get('content-type') ?? '';
      const body = await res.text();
      // DETECT: a real JSON reply (not a 200 + HTML block page, not a non-200).
      if (res.ok && ct.includes('json') && !body.trimStart().startsWith('<')) {
        return { data: JSON.parse(body) as T };
      }
      const why = !res.ok ? `HTTP ${res.status}` : 'HTML block page (rate-limited)';
      logOpenRice('warn', restaurant, `${why} — attempt ${attempt + 1}/${OR_MAX_RETRIES + 1}`);
    } catch (err) {
      logOpenRice(
        'warn',
        restaurant,
        `fetch threw ${(err as Error)?.name ?? 'Error'} — attempt ${attempt + 1}/${OR_MAX_RETRIES + 1}`,
      );
    } finally {
      orRelease();
    }
  }
  return { rateLimited: true };
}

/* ─────────── POI ID resolution (with TTL cache) ─────────── */

/**
 * In-memory cache keyed by `${name}|${district ?? ''}`.
 *
 * Entries carry an expiry. The old cache stored values forever AND cached
 * misses — so a single transient OpenRice hiccup early in the server's life
 * stamped a restaurant "not found" permanently, and every later search
 * skipped straight to the slow Reserve path. (Observed live: a 3-day-old
 * process returned nothing for restaurants a fresh process resolved fine.)
 *
 * Fixed policy:
 *   - real match  → cached POI_HIT_TTL_MS (POI IDs are stable, so this is long).
 *   - genuine "no such restaurant on OpenRice" → cached POI_MISS_TTL_MS only,
 *     so a temporary outage can't blacklist a real restaurant for the whole
 *     process lifetime — it self-heals after a few minutes.
 *   - transient failure (network throw, non-200) → NOT cached at all; retried
 *     on the next search.
 */
interface PoiCacheEntry {
  poiId: number | null;
  /**
   * OpenRice's `priceRangeId` for this POI — the SAME 1–6 scale the app
   * uses (1 = under $50 … 6 = over $801), or 0 when unknown. It rides
   * along in the search response we already fetch, so caching it here
   * lets the price-resolution step read it for free (no Google Maps
   * Playwright scrape) for any OpenRice-covered restaurant. See
   * getOpenRicePriceTier.
   */
  priceTier: number;
  expires: number;
}
const _poiCache = new Map<string, PoiCacheEntry>();
const POI_HIT_TTL_MS = 24 * 60 * 60 * 1000; // 24h — a confirmed match
const POI_MISS_TTL_MS = 10 * 60 * 1000; // 10 min — a genuine "not found"

/** Read through the TTL cache. `undefined` = not cached (or expired). */
function poiCacheGet(key: string): number | null | undefined {
  const e = _poiCache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expires) {
    _poiCache.delete(key);
    return undefined;
  }
  return e.poiId;
}

function poiCacheSet(key: string, poiId: number | null, priceTier: number, ttlMs: number): void {
  _poiCache.set(key, { poiId, priceTier, expires: Date.now() + ttlMs });
}

/**
 * Cache-only lookup of the OpenRice price tier for a restaurant, using the
 * SAME key as searchOpenRicePoi. Returns 0 (unknown) unless a *current*
 * cache entry holds a valid 1–6 tier.
 *
 * This makes no network call by design: the availability lookup
 * (fetchOpenRiceSlots → searchOpenRicePoi) runs first in the enrichment
 * pipeline and primes this cache as a side effect, so by the time price
 * resolution reads it, the value is already there for OpenRice-covered
 * places. A miss here simply means "not on OpenRice / not looked up yet"
 * and the caller falls through to its next price source.
 */
export function getOpenRicePriceTier(name: string, districtHint?: string): PriceTier {
  const key = `${name.toLowerCase()}|${(districtHint ?? '').toLowerCase()}`;
  const e = _poiCache.get(key);
  if (!e || Date.now() > e.expires) return 0;
  const t = e.priceTier;
  return (t >= 1 && t <= 6 ? t : 0) as PriceTier;
}

interface SearchHit {
  poiId: number;
  name: string;
  district?: { name?: string };
  /** OpenRice price band 1–6 (0/absent = unknown). Same scale as our PriceTier. */
  priceRangeId?: number;
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
  const cached = poiCacheGet(key);
  if (cached !== undefined) return cached;

  // rows=2: we only ever use the first match (or the district-hint match), so
  // 2 keeps the response small while still allowing one branch disambiguation.
  const url =
    `${BASE}/api/v2/search?uiLang=en&uiCity=hongkong&rows=2&what=` +
    encodeURIComponent(name);
  const res = await openRiceJson<{
    paginationResult?: { results?: SearchHit[] };
    searchedPoi?: SearchHit[];
  }>(url, name);
  if ('rateLimited' in res) {
    // Block page / non-200 / error after retries. DON'T cache — a bad moment
    // shouldn't blacklist this name; it self-heals on the next search.
    logOpenRice('warn', name, 'search unavailable (rate-limited/error) — not caching');
    return null;
  }
  const data = res.data;
  // OpenRice's search response shape varies — sometimes
  // `paginationResult.results`, sometimes `searchedPoi`.
  const results = data.paginationResult?.results ?? data.searchedPoi ?? [];
  if (results.length === 0) {
    // Genuine "no such restaurant on OpenRice" — safe to cache, but only
    // briefly so a transient empty response can still recover.
    logOpenRice('debug', name, 'search returned no results — cached as miss (10m)');
    poiCacheSet(key, null, 0, POI_MISS_TTL_MS);
    return null;
  }

  let pick: SearchHit | undefined;
  if (districtHint) {
    const hint = districtHint.toLowerCase();
    pick = results.find((r) => (r.district?.name ?? '').toLowerCase().includes(hint));
  }
  pick ??= results[0];
  // Cache the price band too — it's already in this response, and reading
  // it here saves a separate Google Maps Playwright scrape downstream.
  poiCacheSet(key, pick.poiId, pick.priceRangeId ?? 0, POI_HIT_TTL_MS);
  return pick.poiId;
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
 *   - OpenRice has nothing on the requested day and    → 5 earliest on the next
 *     bumps `bookingDate` to a later day                 open day, flagged
 *                                                        nextAvailableDate: true
 *
 * The caller (fetchAvailability) treats [] as "I couldn't help, try
 * the next source" — never as "definitely no booking exists." Every
 * fall-through is logged (via logOpenRice) so we can tell *why* a
 * restaurant produced nothing instead of failing silently.
 */
export async function fetchOpenRiceSlots(input: BookingInput): Promise<TimeSlot[]> {
  const poiId = await searchOpenRicePoi(input.restaurantName, input.districtHint);
  if (poiId == null) {
    logOpenRice('debug', input.restaurantName, 'no OpenRice poiId — falling through');
    return [];
  }

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
  const requestedDate = dateFmt.format(target); // "YYYY-MM-DD"
  const timeSlot = timeFmt.format(target).slice(0, 5); // "HH:MM"

  const url =
    `${BASE}/api/v2/booking/picker?poiId=${poiId}&countryCode=HK&seat=${input.partySize}` +
    `&timeSlot=${encodeURIComponent(timeSlot)}&bookingDate=${requestedDate}` +
    `&uiLang=en&uiCity=hongkong`;

  // Throttled + block-page-aware (see openRiceJson). A rate-limit / error after
  // retries falls through to the next availability source — never mistaken for
  // "no booking".
  const picker = await openRiceJson<PickerResponse>(url, input.restaurantName);
  if ('rateLimited' in picker) {
    logOpenRice('warn', input.restaurantName, 'picker unavailable (rate-limited/error) — falling through');
    return [];
  }
  const data = picker.data;

  // Some responses come back wrapped: {success: false, error: {httpCode: 404}}.
  if (data.success === false) {
    logOpenRice('debug', input.restaurantName, 'picker returned success:false — falling through');
    return [];
  }
  // Check both the top-level flags AND the nested bookingWidget flags.
  // The two layers can disagree — `isAvailable` at top level means
  // "this restaurant has booking", while `bookingWidget.isAvailable`
  // means "slots exist for the requested date". We want the slots-exist
  // signal; bail if either says no.
  if (data.isBookingDisabled || data.bookingWidget?.isBookingDisabled) {
    logOpenRice('debug', input.restaurantName, 'booking disabled — falling through');
    return [];
  }
  if (data.isAvailable === false || data.bookingWidget?.isAvailable === false) {
    logOpenRice('debug', input.restaurantName, 'isAvailable:false — falling through');
    return [];
  }

  const slots = data.bookingWidget?.timeSlots ?? [];
  const enabled = slots.filter((s) => !s.isDisabled);
  if (enabled.length === 0) {
    logOpenRice('debug', input.restaurantName, 'no enabled slots — falling through');
    return [];
  }

  // KEY FIX: OpenRice silently bumps `bookingDate` to the next day that
  // actually has tables when the requested day is full/closed (e.g. ask
  // for 1 Jun, it answers with slots for 2 Jun). The slots in the
  // response belong to THAT returned day, not the day we asked for — so
  // we must date them off the response, not off `requestedDate`, or
  // every slot ends up timestamped on the wrong day.
  const responseDate = data.bookingDate ?? requestedDate;
  const sameDay = responseDate === requestedDate;
  const bookingUrl = buildBookingUrl(poiId, responseDate, input.partySize, timeSlot);

  // Convert each "HH:MM" into a full ISO datetime in HK time, on the
  // day the slots actually belong to.
  const targetMs = target.getTime();
  const windowMs = SLOT_WINDOW_MIN * 60_000;
  const slotsWithMs = enabled.map((s) => ({
    s,
    ms: combineHkDateTime(responseDate, s.timeSlot),
  }));

  // OpenRice bumped us to a later day → nothing on the requested day.
  // Surface the 5 earliest on the next open day, flagged so the UI
  // shows amber "earliest open: <date>" rather than green.
  if (!sameDay) {
    logOpenRice(
      'debug',
      input.restaurantName,
      `no tables on ${requestedDate}; earliest open ${responseDate}`,
    );
    return slotsWithMs
      .sort((a, b) => a.ms - b.ms)
      .slice(0, 5)
      .map(({ ms }) => ({
        time: new Date(ms).toISOString(),
        available: true,
        bookingUrl,
        nextAvailableDate: true,
      }));
  }

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
