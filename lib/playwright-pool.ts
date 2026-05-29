/**
 * Shared Playwright browser pool.
 *
 * Used by lib/openrice.ts and lib/google-reserve.ts so we launch
 * Chromium *once* per Node process (browser launch is ~1–2 s; expensive).
 *
 * Concurrency is capped at MAX_CONCURRENT pages across the whole app —
 * not per module — so a single /api/restaurants request doesn't open
 * dozens of simultaneous browser pages and exhaust memory.
 *
 * Set to 4 (was 8) for two reasons:
 *   1. OpenRice's HTTP booking API now handles ~60-70% of availability
 *      lookups (see lib/openrice-booking.ts), so the Playwright path is
 *      only exercised for the long tail of restaurants OpenRice doesn't
 *      cover. Less parallelism is needed.
 *   2. At 8x parallel, the Google Reserve anchor was injecting too
 *      slowly on heavy pages (Pici Central, 10k+ reviews) — the 8 s
 *      timeout in google-reserve.ts was timing out under network/CPU
 *      contention. 4x gives each Maps page enough breathing room that
 *      Reserve injection comfortably completes within the bounded wait.
 *
 * Each restaurant still does at most TWO sequential Playwright visits
 * (Maps place page → Reserve page), so peak concurrent pages stays at 4,
 * not 8.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';

// Raised 4 → 6. With 8 restaurants per search and two sequential Playwright
// visits each (Maps page → Reserve page), a cap of 4 meant up to half the
// restaurants sat queued long enough that their Reserve check timed out and
// fell back to the "couldn't confirm" placeholder. 6 lets more run in
// parallel without overwhelming a typical dev machine; revisit if memory
// pressure or Reserve-anchor injection slowness reappears under load.
const MAX_CONCURRENT = 6;

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
