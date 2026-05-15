/**
 * Google Maps booking-link discovery + time-slot scraping.
 *
 * TWO-STAGE FLOW per restaurant:
 *
 *   Stage A — Booking URL discovery (Playwright):
 *     Open /maps/place/?q=place_id:<id>. Find the "Reserve a table"
 *     anchor; its href is the Google Reserve universal URL
 *     /maps/reserve/v/dine/c/<token>. Cached per placeId.
 *
 *   Stage B — Slot extraction (Playwright + date-picker interaction):
 *     Open the Reserve URL, click the date picker, click the user's
 *     requested day. The slot list in the DOM updates client-side
 *     (no XHR — slots are computed from an inline schedule the page
 *     embeds), then we read the `data-bts="<unix_seconds>"` attributes
 *     for the now-selected date and filter to ±60 min of target.
 *
 * Why Stage B can't be pure HTTP: a plain fetch returns the page with
 * slots for the restaurant's NEXT available date only — May 16 even if
 * the user asked for May 30. Earlier date-param tricks (?date=, etc.)
 * are ignored by the server. The Reserve page's date picker is purely
 * client-side; selecting a different day is the only way to surface
 * its slots, and the JS that does so is too gnarly to reimplement.
 *
 * If the user's date isn't in the picker (restaurant fully booked /
 * not bookable on that day), we fall back to the slots Google shows
 * by default — flagged `nextAvailableDate: true` for the UI.
 *
 * STANDARDISED OUTPUT
 *   { time: ISO-8601, available: true, bookingUrl: <google reserve url> }
 * The `bookingUrl` deep-links into Google's flow which routes to whichever
 * underlying partner (OpenTable / Inline / OpenRice / Diningcity) the
 * restaurant uses.
 */

import type { BrowserContext, Page } from 'playwright';
import { acquire, getBrowser, newGoogleContext, release } from './playwright-pool';
import type { TimeSlot } from './types';

const PAGE_TIMEOUT_MS = 25_000;
const POST_NAV_MS = 4000;         // wait for Reserve widget to hydrate
const POST_CLICK_MS = 1500;       // wait after each picker interaction
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
 * list of ±1-hour TimeSlots scraped from Google's Reserve flow with
 * the date picker driven to the user's requested day.
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
    await page.waitForTimeout(POST_NAV_MS);

    // Drive the date picker to the user's requested day. Falls through
    // silently if the date is unavailable — we'll harvest whatever the
    // page is currently showing and label it next-available.
    const dateMatched = await selectDate(page, new Date(input.dateTime));
    if (input.partySize !== 2) await selectPartySize(page, input.partySize);

    const html = await page.content();
    return parseSlotsFromHtml(html, input.dateTime, bookingUrl, dateMatched);
  } catch {
    return [];
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
    release();
  }
}

/**
 * Click the date selector and pick the day matching `target`.
 * Returns true if the date was actually selected, false if it wasn't
 * in the dropdown (restaurant not bookable on that day).
 *
 * The picker dropdown items have aria-labels like "Saturday, 30 May";
 * we match by full day-and-month so we don't pick the wrong month
 * when day numbers repeat (e.g. "1 May" vs "1 June").
 */
async function selectDate(page: Page, target: Date): Promise<boolean> {
  try {
    await page
      .locator('[aria-label*="reservation date" i]')
      .first()
      .click({ timeout: 4000 });
    await page.waitForTimeout(600);

    // "30 May" — matches the dropdown's aria-label like "Saturday, 30 May".
    const dayMonth = target.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
    });
    const item = page.locator(`[aria-label*="${dayMonth}" i]`).first();
    if (!(await item.count())) return false;
    await item.click({ timeout: 4000 });
    await page.waitForTimeout(POST_CLICK_MS);
    return true;
  } catch {
    return false;
  }
}

async function selectPartySize(page: Page, size: number): Promise<void> {
  try {
    await page
      .locator('[aria-label*="party size" i]')
      .first()
      .click({ timeout: 3000 });
    await page.waitForTimeout(500);
    await page
      .getByRole('option', { name: String(size) })
      .first()
      .click({ timeout: 3000 });
    await page.waitForTimeout(POST_CLICK_MS);
  } catch {
    /* leave at default of 2 */
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
 * each <li> in the time picker. After Playwright drives the date picker
 * to the user's requested day, the DOM updates client-side and the
 * `data-bts` attributes reflect that day's slot times.
 *
 * Behaviour:
 *   - If `dateMatched` is true (Playwright successfully picked the user's
 *     date) and the slots fall within ±SLOT_WINDOW_MIN of target, return
 *     them as confirmed slots.
 *   - Otherwise, return whatever the page is showing — likely the
 *     restaurant's next-available date — flagged `nextAvailableDate`
 *     so the UI can render a "Earliest open: <date>" badge.
 */
function parseSlotsFromHtml(
  html: string,
  isoTarget: string,
  bookingUrl: string,
  dateMatched: boolean
): TimeSlot[] {
  const targetMs = new Date(isoTarget).getTime();
  const windowMs = SLOT_WINDOW_MIN * 60_000;

  const seen = new Set<number>();
  const allSlots: number[] = [];
  const re = /data-bts="(\d{10})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const ms = parseInt(m[1], 10) * 1000;
    if (seen.has(ms)) continue;
    seen.add(ms);
    allSlots.push(ms);
  }
  if (allSlots.length === 0) return [];

  allSlots.sort((a, b) => a - b);
  const inWindow = allSlots.filter((ms) => Math.abs(ms - targetMs) <= windowMs);

  if (dateMatched && inWindow.length > 0) {
    return inWindow.slice(0, 5).map((ms) => ({
      time: new Date(ms).toISOString(),
      available: true,
      bookingUrl,
    }));
  }

  // Either Playwright couldn't pick the user's date, or no slots
  // are within their requested time window. Surface the 5 earliest
  // visible slots flagged as next-available so the UI can banner them.
  return allSlots.slice(0, 5).map((ms) => ({
    time: new Date(ms).toISOString(),
    available: true,
    bookingUrl,
    nextAvailableDate: true,
  }));
}
