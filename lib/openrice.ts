/**
 * OpenRice price-tier scraper — Playwright edition.
 *
 * BACKGROUND
 * Plain `curl` to openrice.com returns an 18 KB anti-bot challenge page.
 * The actual restaurant data (including "priceRangeId") is hydrated by
 * client-side JavaScript only after the challenge clears. So we have to
 * render the page in a real headless Chromium to see the data.
 *
 * DESIGN
 *   - ONE shared browser per Node process (browser launch ~1-2s; expensive).
 *   - A semaphore caps concurrency at MAX_CONCURRENT to avoid memory blow-up
 *     when /api/restaurants fans out across 12 results.
 *   - Each request gets its own incognito context (fresh cookies / cache).
 *   - We use the spec's regex `"name":"X..."..."priceRangeId":N` against the
 *     fully-rendered HTML — same heuristic, just now applied to real data.
 *
 * Price mapping (per spec):
 *   0 = N/A, 1 = Under $50, 2 = $51-100, 3 = $101-200,
 *   4 = $201-400, 5 = $401-800, 6 = Over $801
 *
 * NOT FOR PRODUCTION SERVERLESS: Playwright's Chromium is ~200 MB and won't
 * fit in standard Vercel/AWS Lambda functions. For Vercel use, swap to
 * @sparticuz/chromium + playwright-core, or run this on a long-lived host.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { PriceTier } from './types';

const ENDPOINT = 'https://www.openrice.com/en/hongkong/restaurants';
const MAX_CONCURRENT = 4;       // browser pages running at the same time
const PAGE_TIMEOUT_MS = 20_000; // hard cap per page

/* ─────────── Shared browser singleton ─────────── */

let _browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (_browserPromise) return _browserPromise;
  _browserPromise = chromium
    .launch({
      headless: true,
      // The first flag prevents `navigator.webdriver === true`, which is
      // the most common bot-detection signal.
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    })
    .catch((err) => {
      _browserPromise = null; // allow retry next call
      throw err;
    });
  return _browserPromise;
}

/* ─────────── Concurrency limiter ─────────── */

let _active = 0;
const _waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (_active < MAX_CONCURRENT) {
    _active++;
    return;
  }
  await new Promise<void>((resolve) => _waiters.push(resolve));
  _active++;
}

function release(): void {
  _active--;
  const next = _waiters.shift();
  if (next) next();
}

/* ─────────── Public API ─────────── */

export async function fetchPriceTier(restaurantName: string): Promise<PriceTier> {
  await acquire();
  let context: BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'Asia/Hong_Kong',
      // Block fonts/images/media to make pages load 3-5x faster.
      // We only need the JSON data inside the HTML, not visual rendering.
    });
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    const url = `${ENDPOINT}?whatwhere=${encodeURIComponent(restaurantName)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    // Wait until SSR-hydrated content (which includes the price-range pill
    // in the metadata line) appears. We watch for any of the six possible
    // OpenRice price labels — whichever lands first means the cards have
    // rendered. 8s budget; on miss we fall through to parse what we have.
    await page
      .waitForSelector(
        'text=/(Below \\$50|\\$51-100|\\$101-200|\\$201-400|\\$401-800|Above \\$801)/',
        { timeout: 8000 }
      )
      .catch(() => undefined);

    // We need the *visible* text rather than the raw HTML — OpenRice puts
    // the price tier in a pipe-separated metadata strip:
    //     <neighborhood>|<cuisine>|<price-range>
    // which only reads correctly off the rendered DOM.
    const visibleText: string = await page.evaluate(
      () => (document.querySelector('main') ?? document.body).innerText
    );
    return parseTier(visibleText, restaurantName);
  } catch {
    return 0;
  } finally {
    if (context) await context.close().catch(() => undefined);
    release();
  }
}

/* ─────────── Text → tier ─────────── */

/**
 * OpenRice renders each result card as a 3-line block in the page's
 * visible text:
 *
 *     [N-2] Restaurant Name
 *     [N-1] Address line
 *     [N  ] Status | Neighborhood | Cuisine A / Cuisine B | $101-200
 *
 * Strategy:
 *   1. Find every line containing a price label.
 *   2. For each, the restaurant name is the most recent prior line that
 *      doesn't look like an address (no street numbers / no leading
 *      "Shop"/"G/F"/"Floor" prefix) — usually exactly 2 lines back.
 *   3. Score each candidate against the query, pick the best.
 *
 * The line-walk is more robust than splitting on blank lines because
 * innerText collapses card boundaries when ads/promos sit between cards.
 */
function parseTier(text: string, restaurantName: string): PriceTier {
  const needle = normalise(restaurantName);
  const lines = text
    // OpenRice's pipe-separated metadata uses U+00A0 (NBSP) around the
    // bars in some renders, plain space in others. Normalise to plain.
    .replace(/ /g, ' ')
    .split('\n')
    .map((s) => s.trim());

  let bestTier: PriceTier = 0;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PRICE_LABEL_RE);
    if (!m) continue;
    const tier = labelToTier(m[1]);
    if (!tier) continue;

    // Walk back up to 5 lines to find a plausible name line.
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const candidate = lines[j];
      if (!candidate || looksLikeAddress(candidate) || looksLikeMetadata(candidate)) continue;
      const score = matchScore(normalise(candidate), needle);
      if (score > bestScore) {
        bestScore = score;
        bestTier = tier;
      }
      break; // first non-address line is our name; stop looking back
    }
  }
  return bestScore > 0 ? bestTier : 0;
}

/** Detect address lines like "Shop 119, 1/F, ..." or "G/F, 9-11 Fuk Wing St". */
function looksLikeAddress(line: string): boolean {
  return /^(shop|g\/f|\d+\/f|floor|unit|room|level)\b/i.test(line) ||
    /^\d+\s/.test(line) ||
    /\b(road|street|avenue|lane|terrace|mansion|building|centre|center|plaza|mall|tower|estate)\b/i.test(line);
}

/** Detect metadata lines (the very line we just matched the price on, or counters). */
function looksLikeMetadata(line: string): boolean {
  return PRICE_LABEL_RE.test(line) ||
    /^\d+(\.\d+)?[KM]?$/.test(line) ||                  // bare review counts: "29.9K"
    /^\+\d+/.test(line) ||                              // "+388"
    /^(open now|closed now|booking|reserve|earn)\b/i.test(line);
}

const PRICE_LABEL_RE =
  /(Below\s*\$50|\$51-100|\$101-200|\$201-400|\$401-800|Above\s*\$80[01])/;

function labelToTier(label: string): PriceTier {
  const l = label.replace(/\s+/g, '').toLowerCase();
  if (l.startsWith('below')) return 1;
  if (l.startsWith('$51')) return 2;
  if (l.startsWith('$101')) return 3;
  if (l.startsWith('$201')) return 4;
  if (l.startsWith('$401')) return 5;
  if (l.startsWith('above')) return 6;
  return 0;
}

/** Strip punctuation/spacing/casing for fuzzy matching. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
}

/**
 * Score how well a card name matches the query. Returns 0 for no overlap,
 * higher for longer common-prefix-or-substring matches. Cheap heuristic —
 * enough to disambiguate "Sushi Itsu" from "Sushi Wadatsumi" on the same
 * results page.
 */
function matchScore(card: string, needle: string): number {
  if (!card || !needle) return 0;
  if (card === needle) return 1000;
  if (card.startsWith(needle) || needle.startsWith(card)) return 500 + needle.length;
  if (card.includes(needle)) return 200 + needle.length;
  if (needle.includes(card)) return 100 + card.length;
  // Token overlap: count chars in common at the start.
  let i = 0;
  while (i < Math.min(card.length, needle.length) && card[i] === needle[i]) i++;
  return i;
}

/* ─────────── Cleanup hook ─────────── */

// Best-effort cleanup when the Node process exits — keeps stray
// Chromium processes from lingering after `next dev` is killed.
if (typeof process !== 'undefined' && !process.env.__OPENRICE_CLEANUP_REGISTERED__) {
  process.env.__OPENRICE_CLEANUP_REGISTERED__ = '1';
  const close = async () => {
    if (_browserPromise) {
      try {
        const b = await _browserPromise;
        await b.close();
      } catch {
        /* ignore */
      }
    }
  };
  process.on('exit', close);
  process.on('SIGINT', () => {
    void close();
    process.exit(0);
  });
}
