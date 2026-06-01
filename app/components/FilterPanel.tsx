'use client';

/**
 * FilterPanel — the structured-dropdown search control.
 *
 * Six dropdowns, in order: Date · Time · Cuisine · Price · Location · People.
 * On submit we build the /search URL directly (no LLM parse needed — the
 * dropdowns already give us structured input). Cuisine is LIFTED to the
 * parent so the landing-page bubbles can pre-select it.
 *
 * Two layouts via `variant`:
 *   - 'panel'   (default) → big stacked grid + "Find restaurants" button.
 *                           Used on the landing page.
 *   - 'compact'           → single horizontal row of small dropdowns + a
 *                           short submit button. Used in the results-page
 *                           header so users can refine without leaving.
 *
 * `initial` seeds Date/Time/Price/Location/People (e.g. on the results page,
 * reconstructed from the current search URL). Use `filtersFromSearch()` to
 * derive both `initial` and the cuisine value from a /search query.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

// Sentinel value for the "Others…" option — when selected we reveal a
// free-text input so the user can type a cuisine/location we don't list.
const OTHER = '__other__';

const CUISINES = [
  { value: '', label: 'Any cuisine' },
  { value: 'Italian', label: '🍝  Italian' },
  { value: 'Japanese', label: '🍣  Japanese' },
  { value: 'Cantonese', label: '🥢  Cantonese' },
  { value: 'Dim Sum', label: '🥟  Dim Sum' },
  { value: 'Thai', label: '🌶️  Thai' },
  { value: 'Vietnamese', label: '🍲  Vietnamese' },
  { value: 'Indian', label: '🍛  Indian' },
  { value: 'Korean', label: '🍱  Korean' },
  { value: 'French', label: '🥖  French' },
  { value: 'American', label: '🍔  American' },
  { value: 'Steakhouse', label: '🥩  Steakhouse' },
  { value: 'Seafood', label: '🦞  Seafood' },
  { value: 'Vegetarian', label: '🥗  Vegetarian' },
  { value: OTHER, label: '✏️  Others…' },
];

const PRICES = [
  { value: '', label: 'Any price' },
  { value: 'under $50', label: 'Under $50' },
  { value: '$51 to $100', label: '$51 – $100' },
  { value: '$101 to $200', label: '$101 – $200' },
  { value: '$201 to $400', label: '$201 – $400' },
  { value: '$401 to $800', label: '$401 – $800' },
  { value: 'over $800', label: 'Over $800' },
];

const LOCATIONS = [
  { value: '', label: 'Any area' },
  { value: 'Central', label: 'Central' },
  { value: 'Soho', label: 'Soho' },
  { value: 'Sheung Wan', label: 'Sheung Wan' },
  { value: 'Admiralty', label: 'Admiralty' },
  { value: 'Wan Chai', label: 'Wan Chai' },
  { value: 'Causeway Bay', label: 'Causeway Bay' },
  { value: 'Tsim Sha Tsui', label: 'Tsim Sha Tsui' },
  { value: 'Mong Kok', label: 'Mong Kok' },
  { value: 'Sai Ying Pun', label: 'Sai Ying Pun' },
  { value: 'Kennedy Town', label: 'Kennedy Town' },
  { value: 'Quarry Bay', label: 'Quarry Bay' },
  { value: OTHER, label: '✏️  Others…' },
];

// Build hourly+half-hour options 11:00 → 22:30. Covers HK lunch + dinner.
const TIMES: { value: string; label: string }[] = [{ value: '', label: 'Any time' }];
for (let h = 11; h <= 22; h++) {
  for (const m of [0, 30]) {
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    TIMES.push({ value: `${hh}:${mm}`, label: `${hh}:${mm}` });
  }
}

const PARTIES = Array.from({ length: 10 }, (_, i) => ({
  value: String(i + 1),
  label: `${i + 1} ${i === 0 ? 'person' : 'people'}`,
}));

/**
 * Combine a YYYY-MM-DD (HK calendar day) and HH:MM into an ISO 8601 instant.
 * Returns '' when no time is chosen — the search then ignores time and just
 * ranks by relevance. HK = UTC+8, no DST, so we subtract 8 h to get UTC.
 */
function combineDateTime(ymd: string, hhmm: string): string {
  if (!hhmm) return '';
  const day =
    ymd ||
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Hong_Kong',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi)).toISOString();
}

export interface FilterInitial {
  date?: string;
  time?: string;
  price?: string;
  location?: string;
  party?: string;
}

/**
 * Reverse the URL a search produced back into dropdown selections, so the
 * results-page header can show what the user actually searched for.
 *
 * The submit() builder writes `q` as
 *   "[cuisine] restaurant in [location], Hong Kong"
 * (price now travels in its own `price` param), so we parse cuisine/location
 * back out of `q`, take price from the param, and split the ISO dateTime into
 * the HK calendar day + HH:MM the Date/Time dropdowns expect.
 */
export function filtersFromSearch(
  q: string,
  dateTime: string,
  partySize: string,
  price: string,
): { cuisine: string; initial: FilterInitial } {
  let cuisine = '';
  const cm = q.match(/^(.*?)\s*restaurant\b/i);
  if (cm && cm[1].trim()) cuisine = cm[1].trim();

  // Price comes straight from its own param now; validate against the known
  // bands so a stray value can't pre-select a non-existent option.
  const validPrice = PRICES.some((p) => p.value === price) ? price : '';

  let location = '';
  const lm = q.match(/\bin (.+?),\s*Hong Kong/i);
  if (lm && lm[1].trim()) location = lm[1].trim();

  let date = '';
  let time = '';
  if (dateTime) {
    const d = new Date(dateTime);
    if (!Number.isNaN(d.getTime())) {
      date = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Hong_Kong',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
      time = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Hong_Kong',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(d);
    }
  }

  return { cuisine, initial: { date, time, price: validPrice, location, party: partySize || '2' } };
}

export function FilterPanel({
  cuisine,
  onCuisineChange,
  variant = 'panel',
  initial,
}: {
  cuisine: string;
  onCuisineChange: (v: string) => void;
  variant?: 'panel' | 'compact';
  initial?: FilterInitial;
}) {
  const router = useRouter();
  const compact = variant === 'compact';

  const [dates, setDates] = useState<{ value: string; label: string }[]>([]);
  const [date, setDate] = useState(initial?.date ?? '');
  const [time, setTime] = useState(initial?.time ?? '');
  const [price, setPrice] = useState(initial?.price ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [party, setParty] = useState(initial?.party ?? '2');
  const [submitting, setSubmitting] = useState(false);

  // "Others…" free-text modes — seed true when the incoming value isn't a
  // known option (e.g. a custom cuisine typed on a previous search).
  const [cuisineOther, setCuisineOther] = useState(
    !!cuisine && !CUISINES.some((o) => o.value === cuisine),
  );
  const [locationOther, setLocationOther] = useState(
    !!initial?.location && !LOCATIONS.some((o) => o.value === initial.location),
  );

  // Keep the cuisine dropdown's mode in sync when the value changes from
  // outside (bubble tap, or a seeded custom value). Leave an empty value
  // alone so selecting "Others…" (which clears cuisine) stays in text mode.
  useEffect(() => {
    if (cuisine && CUISINES.some((o) => o.value === cuisine)) setCuisineOther(false);
    else if (cuisine) setCuisineOther(true);
  }, [cuisine]);

  function handleCuisineSelect(v: string) {
    if (v === OTHER) {
      setCuisineOther(true);
      onCuisineChange('');
    } else {
      setCuisineOther(false);
      onCuisineChange(v);
    }
  }

  function handleLocationSelect(v: string) {
    if (v === OTHER) {
      setLocationOther(true);
      setLocation('');
    } else {
      setLocationOther(false);
      setLocation(v);
    }
  }

  // Build the next 14 days as dropdown options, client-side so the labels
  // ("Today" / "Tomorrow") track the user's clock and we avoid an SSR/CSR
  // hydration mismatch from Date.now(). Don't clobber a seeded date.
  useEffect(() => {
    const now = new Date();
    const opts = Array.from({ length: 14 }, (_, i) => {
      const dt = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      const value = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Hong_Kong',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(dt);
      const label =
        i === 0
          ? 'Today'
          : i === 1
            ? 'Tomorrow'
            : new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Asia/Hong_Kong',
                weekday: 'short',
                day: 'numeric',
                month: 'short',
              }).format(dt);
      return { value, label };
    });
    setDates(opts);
    setDate((cur) => cur || opts[0].value);
  }, []);

  function submit() {
    if (submitting) return;
    setSubmitting(true);

    // Note: price is NOT baked into `q`. Google's text search treats a price
    // phrase as loose keywords, not a real filter, so it never enforced the
    // band. We now pass price as its own param and filter by tier server-side.
    const parts: string[] = [];
    if (cuisine) parts.push(cuisine);
    parts.push('restaurant');
    if (location) parts.push(`in ${location}, Hong Kong`);
    else parts.push('Hong Kong');

    const params = new URLSearchParams({
      q: parts.join(' '),
      dateTime: combineDateTime(date, time),
      partySize: party,
      price, // '' = Any price (server skips the filter)
    });
    router.push(`/search?${params.toString()}`);
    // On the results page the route doesn't remount, so clear the busy
    // flag shortly after navigating to keep the button responsive.
    setTimeout(() => setSubmitting(false), 1200);
  }

  // ───────────────────────── Compact (results-header) layout ──────────────
  if (compact) {
    return (
      // flex-wrap so the six controls + button reflow onto multiple rows on
      // narrow phones instead of being crushed into one unreadable line. On
      // wide screens they all fit and stay on a single row automatically.
      <div className="flex flex-wrap w-full items-center gap-1.5">
        <Select value={date} onChange={setDate} options={dates} compact />
        <Select value={time} onChange={setTime} options={TIMES} compact />
        {cuisineOther ? (
          <TextInput value={cuisine} onChange={onCuisineChange} placeholder="Cuisine…" compact />
        ) : (
          <Select value={cuisine} onChange={handleCuisineSelect} options={CUISINES} compact />
        )}
        <Select value={price} onChange={setPrice} options={PRICES} compact />
        {locationOther ? (
          <TextInput value={location} onChange={setLocation} placeholder="Area…" compact />
        ) : (
          <Select
            value={location}
            onChange={handleLocationSelect}
            options={LOCATIONS}
            compact
          />
        )}
        <Select value={party} onChange={setParty} options={PARTIES} compact />
        <button
          onClick={submit}
          disabled={submitting}
          className="shrink-0 rounded-lg bg-brand-red px-3 py-1.5 text-xs font-medium text-white shadow hover:opacity-90 active:scale-95 transition disabled:bg-gray-300"
        >
          {submitting ? '…' : 'Search'}
        </button>
      </div>
    );
  }

  // ───────────────────────── Panel (landing) layout ───────────────────────
  return (
    <div className="w-full rounded-3xl border border-gray-200 bg-white/90 p-4 shadow-lg backdrop-blur-sm space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Field label="Date">
          <Select value={date} onChange={setDate} options={dates} />
        </Field>
        <Field label="Time">
          <Select value={time} onChange={setTime} options={TIMES} />
        </Field>
        <Field label="Cuisine">
          <Select
            value={cuisineOther ? OTHER : cuisine}
            onChange={handleCuisineSelect}
            options={CUISINES}
          />
          {cuisineOther && (
            <TextInput value={cuisine} onChange={onCuisineChange} placeholder="Type a cuisine…" />
          )}
        </Field>
        <Field label="Price">
          <Select value={price} onChange={setPrice} options={PRICES} />
        </Field>
        <Field label="Location">
          <Select
            value={locationOther ? OTHER : location}
            onChange={handleLocationSelect}
            options={LOCATIONS}
          />
          {locationOther && (
            <TextInput value={location} onChange={setLocation} placeholder="Type a location…" />
          )}
        </Field>
        <Field label="People">
          <Select value={party} onChange={setParty} options={PARTIES} />
        </Field>
      </div>
      <button
        onClick={submit}
        disabled={submitting}
        className="w-full h-12 rounded-2xl bg-brand-red text-white font-medium shadow hover:opacity-90 active:scale-95 transition disabled:bg-gray-300"
      >
        {submitting ? 'Searching…' : 'Find restaurants'}
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-500 mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  compact = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  compact?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus
      className={
        compact
          ? 'min-w-[92px] flex-1 rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs text-gray-900 focus:border-brand-red focus:ring-2 focus:ring-brand-red/20 focus:outline-none'
          : 'mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-brand-red focus:ring-2 focus:ring-brand-red/20 focus:outline-none'
      }
    />
  );
}

function Select({
  value,
  onChange,
  options,
  compact = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  compact?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        compact
          ? 'min-w-[92px] flex-1 rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs text-gray-900 focus:border-brand-red focus:ring-2 focus:ring-brand-red/20 focus:outline-none appearance-none cursor-pointer'
          : 'w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-brand-red focus:ring-2 focus:ring-brand-red/20 focus:outline-none appearance-none cursor-pointer'
      }
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
