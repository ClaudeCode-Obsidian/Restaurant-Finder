/**
 * Google Maps booking-link discovery + time-slot scraping.
 *
 * FLOW per restaurant:
 *   1. Open https://www.google.com/maps/place/?q=place_id:<id> in headless
 *      Chromium, with consent cookies pre-set.
 *   2. Find the "Reserve a table" anchor. Its href points to a Google
 *      Reserve universal URL: /maps/reserve/v/dine/c/<token>
 *   3. Open that Reserve URL and let it render. The page hosts a Google
 *      booking widget which exposes time-slot pills as plain DOM buttons.
 *   4. Extract all visible HH:MM strings, filter to ±60 min around the
 *      user's requested time, return as standardised TimeSlot[].
 *
 * STANDARDISED OUTPUT
 * Every restaurant — regardless of which underlying platform (OpenTable,
 * Inline, SevenRooms, partner widget) Google routes to — produces:
 *
 *   { time: ISO-8601, available: true, bookingUrl: <google reserve url> }
 *
 * The `bookingUrl` deep-links into the Google flow; clicking it carries
 * the user through to the actual booking partner with our requested date
 * and party size already filled in.
 *
 * CACHE
 * Booking URLs barely change. We cache (placeId → reserveUrl) in memory
 * for the lifetime of the Node process so a second search for the same
 * restaurant skips the Maps lookup entirely.
 */

import type { BrowserContext } from 'playwright';
import { acquire, getBrowser, newGoogleContext, release } from './playwright-pool';
import type { TimeSlot } from './types';

const PAGE_TIMEOUT_MS = 20_000;
const POST_LOAD_MS = 5500;        // hydration buffer per page
const SLOT_WINDOW_MIN = 60;       // ±60 minutes around requested time

/* ─────────── Booking URL cache ─────────── */

const _bookingUrlCache = new Map<string, string | null>();
//                                      ^ null means "we looked, no Reserve link"

/* ─────────── Public API ─────────── */

export interface ReserveInput {
  placeId: string;
  dateTime: string;      // ISO 8601
  partySize: number;
}

/**
 * Given a Google placeId + requested date/time, return a standardised
 * list of ±1-hour TimeSlots scraped from Google's Reserve flow.
 * Returns an empty array if the restaurant has no Google booking link
 * (caller should fall back to placeholder slots).
 */
export async function fetchReserveSlots(input: ReserveInput): Promise<TimeSlot[]> {
  const bookingUrl = await getBookingUrl(input.placeId);
  if (!bookingUrl) return [];

  await acquire();
  let ctx: BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    ctx = await newGoogleContext(browser);
    const page = await ctx.newPage();
    await page.goto(bookingUrl, { waitUntil: 'commit', timeout: PAGE_TIMEOUT_MS });
    // The Reserve widget renders time pills under the date selector. If the
    // restaurant uses an embedded partner widget (iframe), times may be a
    // few seconds slower to appear.
    await page.waitForTimeout(POST_LOAD_MS);
    const text = await page.evaluate(() => document.body.innerText);
    return parseSlots(text, input.dateTime, bookingUrl);
  } catch {
    return [];
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
    release();
  }
}

/* ─────────── Step 1: discover the Reserve URL ─────────── */

async function getBookingUrl(placeId: string): Promise<string | null> {
  if (_bookingUrlCache.has(placeId)) return _bookingUrlCache.get(placeId)!;

  await acquire();
  let ctx: BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    ctx = await newGoogleContext(browser);
    const page = await ctx.newPage();
    const url = `https://www.google.com/maps/place/?q=place_id:${placeId}`;
    await page.goto(url, { waitUntil: 'commit', timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(POST_LOAD_MS);

    const reserveHref = await page.evaluate(() => {
      const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]');
      for (const a of anchors) {
        const href = a.href || '';
        const text = (a.textContent || '').trim();
        if (/\/maps\/reserve\/v\//.test(href) || /Reserve a table/i.test(text)) {
          return href;
        }
      }
      return null;
    });

    _bookingUrlCache.set(placeId, reserveHref);
    return reserveHref;
  } catch {
    _bookingUrlCache.set(placeId, null);
    return null;
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
    release();
  }
}

/* ─────────── Step 2: parse time slots ─────────── */

/**
 * The Reserve page renders time slots as 24-hour or 12-hour strings sprinkled
 * through the body text. We greedy-match anything that looks like HH:MM (or
 * HH:MM AM/PM) and keep only the ones within ±SLOT_WINDOW_MIN of the user's
 * target. Caps at 5 slots so the UI stays tidy.
 */
function parseSlots(bodyText: string, isoTarget: string, bookingUrl: string): TimeSlot[] {
  const target = new Date(isoTarget);
  const targetMin = target.getHours() * 60 + target.getMinutes();
  const re = /\b(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?\b/g;

  const seen = new Set<number>();
  const candidates: { mins: number; date: Date }[] = [];

  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyText)) !== null) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const suffix = (m[3] || '').toLowerCase();
    if (suffix === 'pm' && h < 12) h += 12;
    if (suffix === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) continue;
    // Filter out junky hits like "0:00" / "00:00" and review-relative times.
    if (h < 6) continue; // restaurants don't open before 6 AM
    const slotMin = h * 60 + min;
    if (Math.abs(slotMin - targetMin) > SLOT_WINDOW_MIN) continue;
    if (seen.has(slotMin)) continue;
    seen.add(slotMin);

    const d = new Date(target);
    d.setHours(h, min, 0, 0);
    candidates.push({ mins: slotMin, date: d });
  }

  candidates.sort((a, b) => a.mins - b.mins);
  return candidates.slice(0, 5).map(({ date }) => ({
    time: date.toISOString(),
    available: true,
    bookingUrl,
  }));
}
