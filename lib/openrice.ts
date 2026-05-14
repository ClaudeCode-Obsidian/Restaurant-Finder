/**
 * OpenRice price-tier scraper.
 *
 * Per spec, we hit the OpenRice HK search endpoint and look for the
 *   "name": "<restaurant>...","priceRangeId": <0-6>
 * pattern in the response. We use a regex on the raw HTML/JSON-in-script
 * rather than a full DOM parse because OpenRice ships the data in inline
 * JSON blobs that are easier to grep than to traverse.
 *
 * Price mapping (per spec):
 *   0 = N/A, 1 = Under $50, 2 = $51-100, 3 = $101-200,
 *   4 = $201-400, 5 = $401-800, 6 = Over $801
 *
 * Caveat: scraping is brittle. If OpenRice changes their markup, this
 * function returns 0 (N/A) and the app degrades gracefully — it does not
 * crash. That's the right trade-off for a non-essential field.
 */

import type { PriceTier } from './types';

const ENDPOINT = 'https://www.openrice.com/en/hongkong/restaurants';

export async function fetchPriceTier(restaurantName: string): Promise<PriceTier> {
  try {
    const url = `${ENDPOINT}?whatwhere=${encodeURIComponent(restaurantName)}`;
    const res = await fetch(url, {
      headers: {
        // OpenRice 403s requests without a browser-like UA.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      next: { revalidate: 86400 }, // price tier rarely changes — cache 24h
    });
    if (!res.ok) return 0;
    const html = await res.text();

    // Find the FIRST match whose name starts with our restaurant (case-insensitive).
    // Pattern from spec, but loosened to allow whitespace variance.
    const needle = restaurantName.toLowerCase().slice(0, 12); // first ~12 chars
    const re = /"name"\s*:\s*"([^"]+)"[^}]*?"priceRangeId"\s*:\s*(\d)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const [, candidateName, tier] = m;
      if (candidateName.toLowerCase().includes(needle)) {
        const t = parseInt(tier, 10);
        if (t >= 0 && t <= 6) return t as PriceTier;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}
