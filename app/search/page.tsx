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

function SearchPageInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const q = sp.get('q') ?? '';
  const dateTime = sp.get('dateTime') ?? '';
  const partySize = sp.get('partySize') ?? '2';

  // Reconstruct the dropdown selections from the current search URL so the
  // header's compact FilterPanel reflects what the user is looking at.
  const seed = useMemo(() => filtersFromSearch(q, dateTime, partySize), [q, dateTime, partySize]);
  const [cuisine, setCuisine] = useState(seed.cuisine);

  const [restaurants, setRestaurants] = useState<Restaurant[] | null>(null);
  const [expectedCount, setExpectedCount] = useState<number | null>(null);
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
    setExpectedCount(null);
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const params = new URLSearchParams({ q, dateTime, partySize });
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
            if (evt.type === 'meta' && typeof evt.count === 'number') {
              setExpectedCount(evt.count);
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
  }, [q, dateTime, partySize]);

  // Hide restaurants we couldn't find any booking link for — they're dead
  // ends for someone trying to reserve a table, so they only add noise.
  // `check_failed` (link exists but we couldn't read live slots) and
  // `no_slots` stay visible, since the user can still act on those.
  const visible = useMemo(
    () => restaurants?.filter((r) => r.availabilityStatus !== 'no_booking_link') ?? null,
    [restaurants],
  );

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
            {visible === null
              ? 'Searching…'
              : loading
                ? `${visible.length} restaurants loaded for '${q}'…`
                : `${visible.length} restaurants match '${q}'`}
          </div>
          {error && <div className="text-red-600 py-4">{error}</div>}
          {visible === null && <SkeletonList />}
          {visible?.map((r) => (
            <RestaurantCard key={r.placeId} r={r} onHover={setHovered} />
          ))}
          {/* Fill the gap with skeleton rows for restaurants still
              enriching — keeps layout stable as cards trickle in. */}
          {restaurants !== null && loading && expectedCount !== null && (
            <SkeletonList
              count={Math.max(0, expectedCount - restaurants.length)}
            />
          )}
        </div>
        <div className="hidden lg:block border-l border-gray-200">
          <MapView restaurants={visible ?? []} highlightId={hovered} />
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
          <div className="h-32 w-44 rounded-lg shimmer" />
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
