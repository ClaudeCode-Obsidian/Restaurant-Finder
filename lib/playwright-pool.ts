/**
 * Shared Playwright browser pool.
 *
 * Used by lib/openrice.ts and lib/google-reserve.ts so we launch
 * Chromium *once* per Node process (browser launch is ~1–2 s; expensive).
 *
 * Concurrency is capped at MAX_CONCURRENT pages across the whole app —
 * not per module — so a single /api/restaurants request doesn't open
 * dozens of simultaneous browser pages and exhaust memory. OpenRice's
 * HTTP booking API now handles ~60-70% of availability lookups (see
 * lib/openrice-booking.ts), so the Playwright path is only exercised for
 * the long tail of restaurants OpenRice doesn't cover.
 *
 * See the comment on MAX_CONCURRENT below for the current value and the
 * benchmark behind it.
 *
 * Each restaurant still does at most TWO sequential Playwright visits
 * (Maps place page → Reserve page), so the pages a single restaurant
 * holds at once is one, not two.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';

// Raised 6 → 12. A concurrency benchmark on the dev machine (Apple M1, 8
// cores, 16 GB) ran 12 simultaneous Maps page-loads with ZERO failures and
// only ~15% higher per-page latency vs 6 — the scrape is dominated by page
// load + timeout waits (I/O-bound), not CPU, so the box isn't saturated at
// 12. The win: a request's browser-bound tail (often ~10-13 restaurants
// that miss OpenRice) now runs in roughly ONE wave instead of 2-3, cutting
// heavy-query total time substantially.
//
// Watch-outs if this regresses:
//   - The benchmark measured the timeout path (no Reserve anchor rendered).
//     The success path does more CPU work; at 8x historically the Reserve
//     anchor sometimes injected too slowly and timed out on heavy pages.
//   - The M1 Air is fanless and throttles under SUSTAINED load — many
//     concurrent user requests at 12-each could multiply total page count.
// If Reserve timeouts or memory pressure reappear under real load, step
// back toward 8.
const MAX_CONCURRENT = 12;

/* ─────────── Browser singleton ─────────── */

let _browserPromise: Promise<Browser> | null = null;

export function getBrowser(): Promise<Browser> {
  if (_browserPromise) return _browserPromise;
  _browserPromise = chromium
    .launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    })
    .catch((err) => {
      _browserPromise = null;
      throw err;
    });
  return _browserPromise;
}

/* ─────────── Concurrency limiter ─────────── */

let _active = 0;
const _waiters: Array<() => void> = [];

export async function acquire(): Promise<void> {
  if (_active < MAX_CONCURRENT) {
    _active++;
    return;
  }
  await new Promise<void>((resolve) => _waiters.push(resolve));
  _active++;
}

export function release(): void {
  _active--;
  const next = _waiters.shift();
  if (next) next();
}

/* ─────────── Context factory ─────────── */

/**
 * Make a browser context pre-configured with a HK-flavoured human-looking
 * fingerprint and pre-accepted Google cookies. The CONSENT cookie skips
 * Google's interstitial consent page (a 'YES' value is what gets stamped
 * after the user clicks "Accept all" in a real session).
 */
export async function newGoogleContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Hong_Kong',
    viewport: { width: 1400, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  await ctx.addCookies([
    {
      name: 'CONSENT',
      value: 'YES+cb.20210328-17-p0.en+FX+917',
      domain: '.google.com',
      path: '/',
    },
    {
      name: 'SOCS',
      value: 'CAESHAgBEhJnd3NfMjAyNDA3MDgtMF9SQzIaAmVuIAEaBgiAyJq1Bg',
      domain: '.google.com',
      path: '/',
    },
  ]);
  // Hide common automation signals before any page script runs.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  // EXPERIMENT (revertable): block ONLY pure-overhead requests.
  // We do NOT block images/fonts/media yet — earlier testing showed
  // that on heavy restaurant pages (Pici Central, ~10 k reviews), the
  // Reserve anchor failed to inject when subresources were blocked.
  // Likely the page's JS observes asset load state before triggering
  // Reserve injection.
  //
  // Analytics beacons are pure fire-and-forget; killing them is
  // safe and saves a measurable amount of CPU on every visit.
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (/(google-analytics|googletagmanager|doubleclick|google\.com\/log\b)/.test(url)) {
      return route.abort();
    }
    return route.continue();
  });

  return ctx;
}

/* ─────────── Cleanup hook ─────────── */

if (typeof process !== 'undefined' && !process.env.__PW_POOL_REGISTERED__) {
  process.env.__PW_POOL_REGISTERED__ = '1';
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
