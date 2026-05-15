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
import type { PriceTier, TimeSlot } from './types';

const PAGE_TIMEOUT_MS = 25_000;
const POST_NAV_MS = 4000;         // wait for Reserve widget to hydrate
const POST_CLICK_MS = 1500;       // wait after each picker interaction
const SLOT_WINDOW_MIN = 60;       // ±60 minutes around requested time

/* ─────────── Maps-data cache (booking URL + price tier) ─────────── */

interface MapsData {
  bookingUrl: string | null;
  /** 0 = unknown; 1–6 mapped from Google Maps price range. */
  priceTier: PriceTier;
}

// We cache PROMISES (not values) so concurrent callers for the same
// placeId share one Playwright fetch instead of racing two.
const _mapsDataCache = new Map<string, Promise<MapsData>>();

/* ─────────── Public API ─────────── */

export interface ReserveInput {
  placeId: string;
  dateTime: string;      // ISO 8601
  partySize: number;
}

/**
 * Read Google Maps for a placeId — single Playwright visit yields both
 * the Reserve booking URL and the price-range tier. Cached by placeId.
 *
 * Used by:
 *   - /api/restaurants price column (replaces the OpenRice scrape, which
 *     was both slow and bot-blocked)
 *   - fetchReserveSlots (below), which consumes the bookingUrl
 */
export function fetchMapsData(placeId: string): Promise<MapsData> {
  if (_mapsDataCache.has(placeId)) return _mapsDataCache.get(placeId)!;
  const p = doFetchMapsData(placeId);
  _mapsDataCache.set(placeId, p);
  return p;
}

/** Sugar: returns just the price tier (0 if unknown). */
export async function fetchGoogleMapsPrice(placeId: string): Promise<PriceTier> {
  return (await fetchMapsData(placeId)).priceTier;
}

/**
 * Given a Google placeId + requested date/time, return a standardised
 * list of ±1-hour TimeSlots scraped from Google's Reserve flow with
 * the date picker driven to the user's requested day.
 * Returns an empty array if the restaurant has no Google booking link
 * (caller should fall back to placeholder slots).
 */
export async function fetchReserveSlots(input: ReserveInput): Promise<TimeSlot[]> {
  const { bookingUrl } = await fetchMapsData(input.placeId);
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

/* ─────────── Step 1: scrape the Maps place page (URL + price) ─────────── */

/**
 * Single Playwright visit to the Maps place page that pulls:
 *   - The Reserve "table" anchor href (Google's universal booking URL)
 *   - The price-range tier, read from the "Price range histogram" widget
 *     (or its short summary like "$100–350" / "$500+ per person")
 *
 * Returns `{ bookingUrl: null, priceTier: 0 }` on any failure so callers
 * can fall through to their next-best source.
 */
async function doFetchMapsData(placeId: string): Promise<MapsData> {
  await acquire();
  let ctx: BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    ctx = await newGoogleContext(browser);
    const page = await ctx.newPage();
    const url = `https://www.google.com/maps/place/?q=place_id:${placeId}`;
    await page.goto(url, { waitUntil: 'commit', timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(5500);

    const scraped = await page.evaluate(() => {
      // Booking URL
      let reserveHref: string | null = null;
      for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        if (/\/maps\/reserve\/v\//.test(a.href || '')) {
          reserveHref = a.href;
          break;
        }
      }
      // Price — prefer the histogram (full distribution); fall back to
      // the inline summary text. We return the *text* of whichever we
      // find; tier mapping happens in TS so it's testable.
      //
      // Observed Google Maps shapes:
      //   Histogram aria-label "Price range histogram"
      //     + text       "$1–50$50–100$100–150"  (HKD ranges)
      //                  "$400–450$450–500$500+" (capped at $500+ in HK)
      //                  "$10–20$20–30$30–40"    (USD for US places)
      //   Inline summary "$10–20"  "$100–350"
      //   "Per person"   "$50–100 per person"  "$500+ per person"
      //   Open-ended     "·$500+"
      //   Word label     "Inexpensive"  "Moderate"  "Expensive"  "Very Expensive"
      let priceText: string | null = null;
      const hist = document.querySelector('[aria-label*="Price range" i]');
      if (hist) {
        priceText = (hist.getAttribute('aria-label') || '') + ' ' + (hist.textContent || '');
      } else {
        const body = document.body.innerText;
        // Try numeric patterns first; fall back to word labels.
        const r =
          body.match(/\$\d[\d,]*\+\s*per person/i) ||
          body.match(/\$\d[\d,]*[–\-—]\$?\d[\d,]*\s*per person/i) ||
          body.match(/\$\d[\d,]*[–\-—]\$?\d[\d,]*/) ||
          body.match(/[·•]\s*\$\d[\d,]*\+/) ||
          // Word label — must be surrounded by separators to avoid
          // matching a review sentence like "the food is moderate".
          body.match(/[·•]\s*(Very Expensive|Expensive|Moderate|Inexpensive)\b/);
        if (r) priceText = r[0];
      }
      return { reserveHref, priceText };
    });

    return {
      bookingUrl: scraped.reserveHref,
      priceTier: priceTierFromText(scraped.priceText),
    };
  } catch {
    return { bookingUrl: null, priceTier: 0 };
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
    release();
  }
}

/**
 * Map a Google Maps price string to our 0–6 PriceTier (OpenRice scale).
 *
 * Every format Google Maps surfaces, with examples:
 *
 *   Range w/ midpoint                    → tier from midpoint
 *     "$50–100 per person"               → mid 75   → 2 ($51-100)
 *     "$100–350"                         → mid 225  → 4 ($201-400)
 *     histogram "$1–50$50–100$100–150"   → mid ≈75  → 2
 *
 *   Open-ended ("$N+") — we bias UP one tier vs the lower-bound rule
 *   because Google caps HK histograms at $500+ so genuine tier-6
 *   restaurants look identical to tier-5 ones in the raw bucket text.
 *     "·$500+ per person"                → 5  (could be 6; we round up)
 *     "·$100+ per person" (USD)          → 3
 *
 *   Word labels (rare; only when user-report data is thin)
 *     "Inexpensive"  → 1
 *     "Moderate"     → 3
 *     "Expensive"    → 4
 *     "Very Expensive" → 6
 *
 * Currency assumption: Google reports prices in the LOCAL currency for
 * the place. For HK places that's HKD, which maps directly onto the
 * OpenRice tier ladder. The few US/EU restaurants that show in HK
 * queries (rare) will be undervalued — acceptable.
 */
function priceTierFromText(text: string | null): PriceTier {
  if (!text) return 0;

  // Word labels first — use `\b` so "Inexpensive" doesn't also match
  // "Expensive". Check more-specific ones first.
  if (/\bvery expensive\b/i.test(text)) return 6;
  if (/\binexpensive\b/i.test(text)) return 1;
  if (/\bexpensive\b/i.test(text)) return 4;
  if (/\bmoderate\b/i.test(text)) return 3;

  // Strip commas inside numbers ("$1,500" → "$1500") so the int parse
  // doesn't split a single price into two separate digits.
  const clean = text.replace(/(\$\d{1,3}(?:,\d{3})+)/g, (m) => m.replace(/,/g, ''));

  // Each dollar token may be a range "$50–100" or a single value "$500".
  // We need BOTH ends of any range — Google's histogram texts are bucket
  // boundaries like "$1–50$50–100", so the actual upper bound only
  // appears AFTER the en-dash.
  const matches = [...clean.matchAll(/\$(\d+)(?:[–\-—](\d+))?/g)];
  const nums = matches.flatMap((m) =>
    m[2] ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [parseInt(m[1], 10)]
  );
  if (nums.length === 0) return 0;

  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  // "+" anywhere in the relevant range portion means an open upper bound.
  const isOpenEnded = /\$\d[\d,]*\+/.test(clean);

  // For open-ended values, treat the cap as the LOW edge of the next
  // bucket up — Google's "$500+" really means "we don't know, could be
  // way more". Closed ranges use the midpoint.
  const point = isOpenEnded ? Math.max(hi, lo) * 1.25 : Math.round((lo + hi) / 2);

  if (point <= 50) return 1;
  if (point <= 100) return 2;
  if (point <= 200) return 3;
  if (point <= 400) return 4;
  if (point <= 800) return 5;
  return 6;
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
