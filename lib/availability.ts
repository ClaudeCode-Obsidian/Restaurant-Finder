/**
 * Availability lookup across multiple reservation platforms.
 *
 * Strategy:
 *   1. Detect platform from the booking-URL host.
 *   2. Call that platform's public-but-undocumented availability endpoint.
 *   3. On ANY failure (network, parse, change of markup), fall back to
 *      placeholder slots that link OUT to the booking site.
 *
 * Implemented:
 *   - OpenTable  (opentable.com / .co.uk / .hk)
 *   - Inline     (inline.app)         — common in HK
 *   - SevenRooms (sevenrooms.com)
 *   - Chope      (chope.co)
 *
 * IMPORTANT: These endpoints are reverse-engineered from each platform's
 * own widget. They are not officially supported. If a platform changes
 * their API the function returns placeholder slots — the app still works.
 *
 * To add another platform, write `<platform>Slots(input)` that returns
 * `TimeSlot[]` and register it in dispatch().
 */

import type { TimeSlot } from './types';

export interface AvailabilityInput {
  bookingUrl?: string;
  websiteUrl?: string;
  /** ISO 8601 user-requested date/time. */
  dateTime: string;
  partySize: number;
  restaurantName: string;
  location: { lat: number; lng: number };
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function fetchAvailability(input: AvailabilityInput): Promise<TimeSlot[]> {
  const url = input.bookingUrl ?? input.websiteUrl;
  if (!url) return placeholderSlots(input);
  return dispatch(url, input);
}

async function dispatch(url: string, input: AvailabilityInput): Promise<TimeSlot[]> {
  const host = safeHost(url);
  try {
    if (host.includes('opentable')) return await openTableSlots(input);
    if (host.includes('inline.app')) return await inlineSlots(url, input);
    if (host.includes('sevenrooms.com')) return await sevenRoomsSlots(url, input);
    if (host.includes('chope.co')) return await chopeSlots(url, input);
  } catch {
    /* fall through to placeholder */
  }
  return placeholderSlots(input);
}

/* ─────────── OpenTable ───────────
   Uses the public web-search endpoint which returns slots embedded in a
   GraphQL JSON payload. We regex out the slot times instead of trying to
   parse the whole GraphQL shape, since that schema changes occasionally.
*/
async function openTableSlots(input: AvailabilityInput): Promise<TimeSlot[]> {
  const isoMin = new Date(input.dateTime).toISOString().slice(0, 19);
  const params = new URLSearchParams({
    dateTime: isoMin,
    covers: String(input.partySize),
    term: input.restaurantName,
    latitude: String(input.location.lat),
    longitude: String(input.location.lng),
    shouldUseLatLongSearch: 'true',
  });
  const res = await fetch(`https://www.opentable.com/dapi/fe/gql?${params}`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`OpenTable ${res.status}`);
  return parseSlots(await res.text(), input);
}

/* ─────────── Inline ───────────
   Inline embeds its widget at inline.app/booking/<token>/...
   Their availability endpoint is:
     POST https://inline.app/api/booking/<token>/availability
     { date: "YYYY-MM-DD", peopleCount: <n> }
   Returns { availableTimes: ["HH:MM", ...] }.
*/
async function inlineSlots(url: string, input: AvailabilityInput): Promise<TimeSlot[]> {
  const token = extractInlineToken(url);
  if (!token) throw new Error('Inline: no token in URL');
  const target = new Date(input.dateTime);
  const dateStr = target.toISOString().slice(0, 10);

  const res = await fetch(`https://inline.app/api/booking/${token}/availability`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({ date: dateStr, peopleCount: input.partySize }),
  });
  if (!res.ok) throw new Error(`Inline ${res.status}`);
  const data = (await res.json()) as { availableTimes?: string[] };
  const times = data.availableTimes ?? [];
  return pickClosestSlots(times, target, input.bookingUrl ?? url);
}

function extractInlineToken(url: string): string | null {
  // inline.app/booking/<token> or inline.app/booking/<token>/something
  const m = url.match(/inline\.app\/booking\/([^/?#]+)/i);
  return m ? m[1] : null;
}

/* ─────────── SevenRooms ───────────
   Venue URL looks like:
     https://www.sevenrooms.com/explore/<venue_slug>/reservations/...
   Their widget API:
     GET https://www.sevenrooms.com/api-yoa/availability/widget/range
       ?venue=<slug>&time_slot=HH:MM&party_size=N&start_date=YYYY-MM-DD
   Returns { data: { availability: { "YYYY-MM-DD": [{ time:"19:00", ...}] }}}
*/
async function sevenRoomsSlots(url: string, input: AvailabilityInput): Promise<TimeSlot[]> {
  const slug = extractSevenRoomsSlug(url);
  if (!slug) throw new Error('SevenRooms: no slug');
  const target = new Date(input.dateTime);
  const dateStr = target.toISOString().slice(0, 10);
  const hhmm = target.toISOString().slice(11, 16);

  const params = new URLSearchParams({
    venue: slug,
    time_slot: hhmm,
    party_size: String(input.partySize),
    start_date: dateStr,
    num_days: '1',
  });
  const res = await fetch(
    `https://www.sevenrooms.com/api-yoa/availability/widget/range?${params}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`SevenRooms ${res.status}`);
  const data = (await res.json()) as {
    data?: { availability?: Record<string, Array<{ time?: string; is_requestable?: boolean }>> };
  };
  const slots = data.data?.availability?.[dateStr] ?? [];
  const times = slots.map((s) => s.time).filter((t): t is string => Boolean(t));
  return pickClosestSlots(times, target, input.bookingUrl ?? url);
}

function extractSevenRoomsSlug(url: string): string | null {
  // .../explore/<slug>/reservations/...  OR  .../reservations/<slug>/...
  const m =
    url.match(/sevenrooms\.com\/explore\/([^/?#]+)/i) ??
    url.match(/sevenrooms\.com\/reservations\/([^/?#]+)/i);
  return m ? m[1] : null;
}

/* ─────────── Chope ───────────
   Chope URLs: https://www.chope.co/hong-kong-restaurants/restaurant/<slug>
   Their availability endpoint (used by the booking widget):
     GET https://book.chope.co/api/restaurants/<slug>/availability
       ?date=YYYY-MM-DD&time=HH:MM&pax=N&country=HK
   Returns { slots: [{ time: "19:00", available: true }] }.
*/
async function chopeSlots(url: string, input: AvailabilityInput): Promise<TimeSlot[]> {
  const slug = extractChopeSlug(url);
  if (!slug) throw new Error('Chope: no slug');
  const target = new Date(input.dateTime);
  const params = new URLSearchParams({
    date: target.toISOString().slice(0, 10),
    time: target.toISOString().slice(11, 16),
    pax: String(input.partySize),
    country: 'HK',
  });
  const res = await fetch(
    `https://book.chope.co/api/restaurants/${slug}/availability?${params}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Chope ${res.status}`);
  const data = (await res.json()) as {
    slots?: Array<{ time?: string; available?: boolean }>;
  };
  const slots = data.slots ?? [];
  return slots
    .filter((s) => s.time)
    .slice(0, 5)
    .map((s) => ({
      time: combineDateAndTime(target, s.time!).toISOString(),
      available: Boolean(s.available),
      bookingUrl: input.bookingUrl ?? url,
    }));
}

function extractChopeSlug(url: string): string | null {
  const m = url.match(/chope\.co\/[a-z-]+\/restaurant\/([^/?#]+)/i);
  return m ? m[1] : null;
}

/* ─────────── Shared helpers ─────────── */

/**
 * Given a list of "HH:MM" strings, return up to 5 TimeSlots closest to the
 * requested target time, all marked available=true.
 */
function pickClosestSlots(
  hhmmList: string[],
  target: Date,
  bookingUrl?: string
): TimeSlot[] {
  if (hhmmList.length === 0) return [];
  const targetMins = target.getHours() * 60 + target.getMinutes();
  const withDelta = hhmmList
    .map((t) => {
      const [h, m] = t.split(':').map(Number);
      const mins = h * 60 + m;
      return { t, delta: Math.abs(mins - targetMins) };
    })
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 5)
    .sort((a, b) => a.t.localeCompare(b.t));
  return withDelta.map(({ t }) => ({
    time: combineDateAndTime(target, t).toISOString(),
    available: true,
    bookingUrl,
  }));
}

/** Replace HH:MM portion of `date` with given "HH:MM" string. */
function combineDateAndTime(date: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Regex extraction of OpenTable's GraphQL slot fields. */
function parseSlots(text: string, input: AvailabilityInput): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const re = /"timeSlot"\s*:\s*"([^"]+)"[^}]*?"available"\s*:\s*(true|false)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && slots.length < 5) {
    slots.push({
      time: m[1],
      available: m[2] === 'true',
      bookingUrl: input.bookingUrl,
    });
  }
  return slots.length ? slots : placeholderSlots(input);
}

/**
 * Fallback when we can't determine real availability.
 * Times centered on the requested time; marked unavailable so the UI shows
 * them as "click to confirm on booking site" rather than promising a booking
 * we can't deliver.
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

function safeHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}
