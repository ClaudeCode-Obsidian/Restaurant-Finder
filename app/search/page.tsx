'use client';

/**
 * Search results page.
 *
 * URL: /search?q=...&dateTime=...&partySize=...
 *
 * On mount, fetches /api/restaurants and renders:
 *   - Top sticky bar: date / time / party size / query (mirrors OpenTable header)
 *   - Left half (or full width on mobile): list of RestaurantCards
 *   - Right half (desktop only): MapView
 *
 * We deliberately keep the loading state simple — show a skeleton row count
 * so the layout doesn't jump when results arrive.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RestaurantCard } from '../components/RestaurantCard';
import { MapView } from '../components/MapView';
import { FilterPanel, filtersFromSearch } from '../components/FilterPanel';
import type { Restaurant } from '@/lib/types';

// How many "available near your time" results we aim to show at the top.
const TARGET = 8;

/** True when a restaurant has a bookable slot at/near the requested time
 *  (green) — i.e. a real slot that isn't flagged as an alternative time/date. */
function isNearTime(r: Restaurant): boolean {
  return (r.availability ?? []).some(
    (s) => s.available && !s.nextAvailableDate && !s.nextAvailableTime,
  );
}

/** Results we never show: no booking link, or a confirmed no-table-near-time.
 *  (The server already drops these, but we guard here too.) */
function isHiddenResult(r: Restaurant): boolean {
  const hasBookable = (r.availability ?? []).some((s) => s.available);
  if (hasBookable) return false;
  const status = r.availabilityStatus ?? 'no_slots';
  return status === 'no_booking_link' || status === 'no_slots';
}

function SearchPageInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const q = sp.get('q') ?? '';
  const dateTime = sp.get('dateTime') ?? '';
  const partySize = sp.get('partySize') ?? '2';
  const price = sp.get('price') ?? '';
  const area = sp.get('area') ?? '';

  // Reconstruct the dropdown selections from the current search URL so the
  // header's compact FilterPanel reflects what the user is looking at.
  const seed = useMemo(
    () => filtersFromSearch(q, dateTime, partySize, price),
    [q, dateTime, partySize, price],
  );
  const [cuisine, setCuisine] = useState(seed.cuisine);

  const [restaurants, setRestaurants] = useState<Restaurant[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stream NDJSON from the API. Each line is one event:
  //   { type: 'meta',       count, dateTime, partySize, q }
  //   { type: 'restaurant', restaurant: Restaurant }
  //   { type: 'done' }
  // We append `restaurant` events to state as soon as they arrive so cards
  // render incrementally instead of all at once after ~15s.
  useEffect(() => {
    let cancelled = false;
    const ctl = new AbortController();
    setRestaurants(null);
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const params = new URLSearchParams({ q, dateTime, partySize, price, area });
        const res = await fetch(`/api/restaurants?${params}`, {
          signal: ctl.signal,
        });
        if (!res.ok || !res.body) {
          if (!cancelled) setError('Failed to load results');
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (cancelled) return;
          buffer += decoder.decode(value, { stream: true });

          // Drain complete lines from the buffer; keep any partial tail
          // for the next chunk.
          let nl: number;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let evt: { type?: string; count?: number; restaurant?: Restaurant; error?: string };
            try {
              evt = JSON.parse(line);
            } catch {
              continue; // malformed — skip rather than blow up the stream
            }
            if (evt.error) {
              setError(evt.error);
              continue;
            }
            if (evt.type === 'meta') {
              setRestaurants([]); // switch from skeleton-only to incremental
            } else if (evt.type === 'restaurant' && evt.restaurant) {
              const r = evt.restaurant;
              setRestaurants((cur) => [...(cur ?? []), r]);
            } else if (evt.type === 'done') {
              setLoading(false);
            }
          }
        }
      } catch (err: unknown) {
        // AbortError is expected on unmount — don't surface it.
        if (!cancelled && (err as { name?: string })?.name !== 'AbortError') {
          setError('Failed to load results');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      ctl.abort();
    };
  }, [q, dateTime, partySize, price, area]);

  // Split the streamed results into two sections:
  //   • near  — a bookable table close to the requested date & time. Shown
  //             first, capped at TARGET (we aim for 8).
  //   • other — bookable only at another time/date, or a booking link we
  //             couldn't read. Shown below, under a "Not available at your
  //             time" heading.
  // Dead ends (no booking link, or nothing free near the time) are dropped
  // on the server, so they don't arrive here at all.
  const { near, other } = useMemo(() => {
    const vis = (restaurants ?? []).filter((r) => !isHiddenResult(r));
    return {
      near: vis.filter(isNearTime).slice(0, TARGET),
      other: vis.filter((r) => !isNearTime(r)),
    };
  }, [restaurants]);

  return (
    <main className="h-screen flex flex-col">
      {/* Top bar: brand + inline compact filters (no search box / mic). */}
      <header className="border-b border-gray-200 bg-white px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => router.push('/')}
          className="flex items-center gap-2 text-gray-900 font-semibold shrink-0"
        >
          <span className="h-6 w-6 rounded-full bg-brand-red inline-block" />
          <span className="hidden sm:inline">Restaurant Finder</span>
        </button>
        <span className="text-gray-300 shrink-0">|</span>
        <div className="min-w-0 flex-1">
          <FilterPanel
            variant="compact"
            cuisine={cuisine}
            onCuisineChange={setCuisine}
            initial={seed.initial}
          />
        </div>
      </header>

      {/* Body */}
      <section className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2">
        <div className="overflow-y-auto px-4 lg:px-6">
          <div className="py-3 text-sm text-gray-500">
            {restaurants === null
              ? 'Searching…'
              : loading
                ? `Finding tables near your time… ${near.length} of ${TARGET} found`
                : `${near.length} ${near.length === 1 ? 'restaurant' : 'restaurants'} with a table near your time`}
          </div>
          {error && <div className="text-red-600 py-4">{error}</div>}

          {/* Before the first result arrives, show a full set of placeholders. */}
          {restaurants === null && <SkeletonList count={TARGET} />}

          {/* Section 1 — available at/near the requested date & time. */}
          {near.map((r) => (
            <RestaurantCard key={r.placeId} r={r} onHover={setHovered} />
          ))}
          {/* Keep filling toward TARGET with placeholders while results stream
              in, so the layout doesn't jump as cards trickle in. */}
          {restaurants !== null && loading && (
            <SkeletonList count={Math.max(0, TARGET - near.length)} />
          )}

          {/* Section 2 — bookable, but not at the requested time. */}
          {other.length > 0 && (
            <div className="mt-8 border-t border-gray-200 pt-4">
              <h2 className="text-base font-semibold text-gray-900">
                Not available at your time
              </h2>
              <p className="mt-1 text-xs text-gray-500">
                No open table at your selected date &amp; time for these — they’re
                listed in case you can adjust. Tap a slot or the booking link to
                see what else is open.
              </p>
              <div className="mt-2">
                {other.map((r) => (
                  <RestaurantCard key={r.placeId} r={r} onHover={setHovered} />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="hidden lg:block border-l border-gray-200">
          <MapView restaurants={[...near, ...other]} highlightId={hovered} />
        </div>
      </section>
    </main>
  );
}


function SkeletonList({ count = 5 }: { count?: number }) {
  if (count <= 0) return null;
  return (
    <div className="space-y-5 py-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex gap-4">
          <div className="h-24 w-28 sm:h-32 sm:w-44 rounded-lg shimmer" />
          <div className="flex-1 space-y-2">
            <div className="h-5 w-2/3 rounded shimmer" />
            <div className="h-4 w-1/2 rounded shimmer" />
            <div className="h-4 w-5/6 rounded shimmer" />
            <div className="flex gap-2 mt-3">
              <div className="h-8 w-16 rounded shimmer" />
              <div className="h-8 w-16 rounded shimmer" />
              <div className="h-8 w-16 rounded shimmer" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SearchPage() {
  // useSearchParams must be inside a Suspense boundary in App Router.
  return (
    <Suspense fallback={<div className="p-6 text-gray-500">Loading…</div>}>
      <SearchPageInner />
    </Suspense>
  );
}
