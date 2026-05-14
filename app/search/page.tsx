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
import { ChatBox } from '../components/ChatBox';
import type { Restaurant } from '@/lib/types';

function SearchPageInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const q = sp.get('q') ?? '';
  const dateTime = sp.get('dateTime') ?? '';
  const partySize = sp.get('partySize') ?? '2';

  const [restaurants, setRestaurants] = useState<Restaurant[] | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRestaurants(null);
    setError(null);
    const params = new URLSearchParams({ q, dateTime, partySize });
    fetch(`/api/restaurants?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setRestaurants(data.restaurants ?? []);
      })
      .catch(() => !cancelled && setError('Failed to load results'));
    return () => {
      cancelled = true;
    };
  }, [q, dateTime, partySize]);

  const niceDate = useMemo(() => {
    if (!dateTime) return '';
    const d = new Date(dateTime);
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [dateTime]);

  return (
    <main className="h-screen flex flex-col">
      {/* Top bar */}
      <header className="border-b border-gray-200 bg-white px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => router.push('/')}
          className="flex items-center gap-2 text-gray-900 font-semibold"
        >
          <span className="h-6 w-6 rounded-full bg-brand-red inline-block" />
          Restaurant Finder
        </button>
        <span className="hidden md:inline-block text-sm text-gray-500 mx-2">|</span>
        <div className="hidden md:flex gap-4 text-sm text-gray-700">
          <Pill>{niceDate || 'Any time'}</Pill>
          <Pill>{partySize} people</Pill>
          <Pill className="max-w-[220px] truncate">{q}</Pill>
        </div>
        <div className="ml-auto w-full max-w-md">
          <ChatBox initialValue={q} />
        </div>
      </header>

      {/* Body */}
      <section className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2">
        <div className="overflow-y-auto px-4 lg:px-6">
          <div className="py-3 text-sm text-gray-500">
            {restaurants
              ? `${restaurants.length} restaurants match '${q}'`
              : 'Searching…'}
          </div>
          {error && <div className="text-red-600 py-4">{error}</div>}
          {restaurants === null && <SkeletonList />}
          {restaurants?.map((r) => (
            <RestaurantCard key={r.placeId} r={r} onHover={setHovered} />
          ))}
        </div>
        <div className="hidden lg:block border-l border-gray-200">
          <MapView restaurants={restaurants ?? []} highlightId={hovered} />
        </div>
      </section>
    </main>
  );
}

function Pill({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-gray-200 px-3 py-1 ${className}`}
    >
      {children}
    </span>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-5 py-3">
      {Array.from({ length: 5 }).map((_, i) => (
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
