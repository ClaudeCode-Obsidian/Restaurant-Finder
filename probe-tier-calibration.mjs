import { chromium } from 'playwright';

const API_KEY = 'AIzaSyB5BwdsuZEcDATOytAiCB1PbC9gGGshPDk';
const TARGET_PER_LEVEL = 15;
const CONCURRENCY = 5;

// Broad geographic + cuisine sweep to gather enough restaurants with
// priceLevel set across all four buckets.
const SEARCH_QUERIES = [
  'restaurants Central Hong Kong',
  'restaurants Causeway Bay Hong Kong',
  'restaurants Tsim Sha Tsui Hong Kong',
  'restaurants Sheung Wan Hong Kong',
  'restaurants Wan Chai Hong Kong',
  'restaurants Mongkok Hong Kong',
  'restaurants SoHo Hong Kong',
  'cheap eats Hong Kong',
  'fine dining Hong Kong',
  'steakhouse Hong Kong',
  'omakase Hong Kong',
  'cha chaan teng Hong Kong',
];

/* ─────────── Step 1: gather candidates from Places API ─────────── */

async function searchPlaces(query) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.priceLevel,places.formattedAddress',
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 20, includedType: 'restaurant' }),
  });
  return (await res.json()).places ?? [];
}

console.log('Step 1: querying Places API across', SEARCH_QUERIES.length, 'queries...');
const seen = new Map();
for (const q of SEARCH_QUERIES) {
  const places = await searchPlaces(q);
  for (const p of places) seen.set(p.id, p);
  console.log(`  ${q.padEnd(40)} → ${places.length} places (pool now ${seen.size} unique)`);
}

// Group by priceLevel
const buckets = {
  PRICE_LEVEL_INEXPENSIVE: [],
  PRICE_LEVEL_MODERATE: [],
  PRICE_LEVEL_EXPENSIVE: [],
  PRICE_LEVEL_VERY_EXPENSIVE: [],
};
for (const p of seen.values()) {
  if (p.priceLevel && buckets[p.priceLevel]) buckets[p.priceLevel].push(p);
}
console.log('\npriceLevel distribution:');
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(28)} ${v.length}`);

/* ─────────── Step 2: scrape Maps price for each ─────────── */

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'en-US', timezoneId: 'Asia/Hong_Kong', viewport: { width: 1400, height: 900 },
});
await ctx.addCookies([
  { name: 'CONSENT', value: 'YES+cb.20210328-17-p0.en+FX+917', domain: '.google.com', path: '/' },
  { name: 'SOCS', value: 'CAESHAgBEhJnd3NfMjAyNDA3MDgtMF9SQzIaAmVuIAEaBgiAyJq1Bg', domain: '.google.com', path: '/' },
]);

async function scrapeMapsPrice(placeId) {
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.google.com/maps/place/?q=place_id:${placeId}`, { waitUntil: 'commit', timeout: 25000 });
    await page.waitForTimeout(5000);
    return await page.evaluate(() => {
      const hist = document.querySelector('[aria-label*="Price range" i]');
      let text = null;
      if (hist) text = (hist.getAttribute('aria-label') || '') + ' ' + (hist.textContent || '');
      else {
        const body = document.body.innerText;
        const r =
          body.match(/\$\d[\d,]*\+\s*per person/i) ||
          body.match(/\$\d[\d,]*[–\-—]\$?\d[\d,]*\s*per person/i) ||
          body.match(/\$\d[\d,]*[–\-—]\$?\d[\d,]*/) ||
          body.match(/[·•]\s*\$\d[\d,]*\+/);
        if (r) text = r[0];
      }
      return text;
    });
  } catch { return null; }
  finally { await page.close().catch(() => {}); }
}

function rangeFromText(text) {
  if (!text) return null;
  const clean = text.replace(/(\$\d{1,3}(?:,\d{3})+)/g, (m) => m.replace(/,/g, ''));
  const matches = [...clean.matchAll(/\$(\d+)(?:[–\-—](\d+))?/g)];
  const nums = matches.flatMap((m) => m[2] ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [parseInt(m[1], 10)]);
  if (nums.length === 0) return null;
  return { lo: Math.min(...nums), hi: Math.max(...nums), openEnded: /\+/.test(clean) };
}

// Concurrency-limited mapper
async function mapPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }));
  return results;
}

console.log('\nStep 2: scraping Maps for up to', TARGET_PER_LEVEL, 'restaurants per level (concurrency', CONCURRENCY + ')...');
const observations = {};
for (const [level, places] of Object.entries(buckets)) {
  const target = places.slice(0, TARGET_PER_LEVEL);
  console.log(`\n--- ${level} (${target.length} places) ---`);
  const results = await mapPool(target, async (p, idx) => {
    const text = await scrapeMapsPrice(p.id);
    const range = rangeFromText(text);
    const name = p.displayName?.text || '(unknown)';
    console.log(`  [${idx + 1}/${target.length}] ${name.slice(0, 40).padEnd(40)} ${text ? text.slice(0, 50) : '(no price)'}`);
    return { name, text, range };
  }, CONCURRENCY);
  observations[level] = results;
}

await browser.close();

/* ─────────── Step 3: aggregate + report ─────────── */

console.log('\n\n==========================================');
console.log('CALIBRATION RESULTS');
console.log('==========================================\n');

for (const [level, obs] of Object.entries(observations)) {
  const ranges = obs.filter(o => o.range);
  const los = ranges.map(o => o.range.lo);
  const his = ranges.map(o => o.range.hi);
  const mids = ranges.map(o => (o.range.lo + o.range.hi) / 2);
  const openCount = ranges.filter(o => o.range.openEnded).length;

  const avg = (a) => a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(0) : '-';
  const median = (a) => {
    if (!a.length) return '-';
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };

  console.log(`\n${level}  (${ranges.length}/${obs.length} have Maps price data, ${openCount} open-ended)`);
  console.log(`  lo:   min=${ranges.length ? Math.min(...los) : '-'}  mean=${avg(los)}  median=${median(los)}`);
  console.log(`  hi:   max=${ranges.length ? Math.max(...his) : '-'}  mean=${avg(his)}  median=${median(his)}`);
  console.log(`  mid:  mean=${avg(mids)}  median=${median(mids)}`);
}
