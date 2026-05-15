/**
 * Google Maps booking-link discovery + time-slot scraping.
 *
 * TWO-STAGE FLOW per restaurant:
 *
 *   Stage A — Booking URL discovery (Playwright):
 *     Open https://www.google.com/maps/place/?q=place_id:<id> in headless
 *     Chromium with consent cookies pre-set. Find the "Reserve a table"
 *     anchor; its href is the Google Reserve universal URL
 *     /maps/reserve/v/dine/c/<token>. Cached in memory by placeId so we
 *     only pay this cost once per restaurant per process lifetime.
 *
 *   Stage B — Slot scraping (PLAIN HTTP — no Playwright):
 *     The Reserve page is server-side rendered. The time-pill data lives
 *     directly in the HTML as `data-bts="<unix_seconds>"` attributes
 *     adjacent to the slot picker. A simple `fetch` with the same consent
 *     cookies gets the full page; a regex pulls out the timestamps.
 *
 * Why two stages? Stage A still needs Playwright because the place page
 * is a Maps SPA where the Reserve anchor only appears after JS execution.
 * Stage B is plain HTML — bypassing Playwright there cuts ~10s/restaurant
 * and avoids the concurrency timeouts we saw in earlier iterations.
 *
 * STANDARDISED OUTPUT
 *   { time: ISO-8601, available: true, bookingUrl: <google reserve url> }
 * The `bookingUrl` deep-links into Google's flow which routes to whichever
 * underlying platform (OpenTable / Inline / OpenRice / Diningcity) the
 * restaurant uses.
 *
 * LIMITATION
 *   The Reserve URL is opaque — `?date=…&time=…&size=…` params are ignored
 *   by the server, which always returns slots centred on ~19:00 for 2
 *   guests today. So this works best for dinner-time / today queries.
 *   For other windows we still rely on placeholder slots.
 */

import type { BrowserContext } from 'playwright';
import { acquire, getBrowser, newGoogleContext, release } from './playwright-pool';
import type { TimeSlot } from './types';

const PAGE_TIMEOUT_MS = 20_000;
const SLOT_WINDOW_MIN = 60;       // ±60 minutes around requested time

const RESERVE_FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  // Consent cookies — same values Playwright contexts use. CONSENT=YES
  // skips Google's consent interstitial; SOCS is set after a user clicks
  // "Accept all" once and persists their choices.
  Cookie:
    'CONSENT=YES+cb.20210328-17-p0.en+FX+917; ' +
    'SOCS=CAESHAgBEhJnd3NfMjAyNDA3MDgtMF9SQzIaAmVuIAEaBgiAyJq1Bg',
};

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
  try {
    const res = await fetch(bookingUrl, {
      headers: RESERVE_FETCH_HEADERS,
      // Cache same restaurant for 5 min — slot data only updates as
      // bookings come in.
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseSlotsFromHtml(html, input.dateTime, bookingUrl);
  } catch {
    return [];
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
    // Wait for the place panel to hydrate — only the JS-rendered DOM
    // exposes the Reserve anchor.
    await page.waitForTimeout(5500);

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

/* ─────────── Step 2: parse time slots from HTML ─────────── */

/**
 * The Reserve page embeds slot data as `data-bts="<unix_seconds>"` on
 * each <li> in the time picker. We pull every distinct timestamp,
 * filter to ±SLOT_WINDOW_MIN around the user's target, and return up to
 * 5 slots so the UI stays tidy.
 *
 * Why timestamps rather than the visible "19:30" text? The text appears
 * many times in the page (operating hours, reviews, etc.) but `data-bts`
 * is exclusive to the slot picker — much more precise.
 */
function parseSlotsFromHtml(html: string, isoTarget: string, bookingUrl: string): TimeSlot[] {
  const targetMs = new Date(isoTarget).getTime();
  const windowMs = SLOT_WINDOW_MIN * 60_000;

  const seen = new Set<number>();
  const slots: { ms: number }[] = [];
  const re = /data-bts="(\d{10})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const ms = parseInt(m[1], 10) * 1000;
    if (seen.has(ms)) continue;
    if (Math.abs(ms - targetMs) > windowMs) continue;
    seen.add(ms);
    slots.push({ ms });
  }

  slots.sort((a, b) => a.ms - b.ms);
  return slots.slice(0, 5).map(({ ms }) => ({
    time: new Date(ms).toISOString(),
    available: true,
    bookingUrl,
  }));
}
