/**
 * Shared Playwright browser pool.
 *
 * Used by both lib/openrice.ts and lib/google-reserve.ts so we launch
 * Chromium *once* per Node process (browser launch is ~1–2 s; expensive).
 *
 * Concurrency is capped at MAX_CONCURRENT pages across the whole app —
 * not per module — so a single /api/restaurants request that needs both
 * an OpenRice scrape AND a Google Reserve lookup for 12 restaurants
 * doesn't open 24 simultaneous browser pages and exhaust memory.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';

const MAX_CONCURRENT = 3;

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
  // Note: we intentionally DON'T block images/fonts here — Google Maps and
  // Google Reserve sometimes hang `domcontentloaded` when subresources are
  // aborted by route filters. Speed-conscious modules (OpenRice) can attach
  // their own route filter on the context they get from this factory.
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
