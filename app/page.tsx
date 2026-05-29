'use client';

/**
 * Landing page.
 *
 * Layout:
 *   - Brand header
 *   - Headline + tagline
 *   - FilterPanel (5 dropdowns: cuisine, price, location, time, party)
 *   - Floating cuisine bubbles — click one to pre-select the cuisine dropdown
 *
 * The chatbox-driven flow has been retired in favour of structured dropdowns.
 * We lift only `cuisine` into this page so the bubbles can drop their label
 * into the FilterPanel; the other four dropdowns stay local to FilterPanel.
 */

import { useState } from 'react';
import { FilterPanel } from './components/FilterPanel';
import { CuisineBubbles } from './components/CuisineBubbles';

const HEADLINES = [
  'Restaurant availabilities, one tap away.',
  'What are you in the mood for?',
];

export default function Home() {
  const [cuisine, setCuisine] = useState('');
  const headline = HEADLINES[Math.floor(Date.now() / 60_000) % HEADLINES.length];

  return (
    <main className="relative min-h-screen flex flex-col bg-gradient-to-b from-orange-50 via-white to-white">
      {/* Full-screen floating thought bubbles, layered behind everything. */}
      <CuisineBubbles onPick={setCuisine} />

      <header className="relative z-10 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-full bg-brand-red" />
          <span className="font-semibold text-gray-900">Restaurant Finder</span>
        </div>
        <a
          href="https://github.com"
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          About
        </a>
      </header>

      {/* Centred both axes: this section fills the space between header and
          footer and centres its single column vertically + horizontally. */}
      <section className="relative z-10 flex-1 flex flex-col justify-center items-center px-4 py-8">
        <div className="w-full max-w-4xl space-y-8">
          <div className="text-center space-y-2">
            <div className="mx-auto h-14 w-14 rounded-full bg-gradient-to-br from-brand-red via-orange-400 to-pink-500" />
            <h1 className="text-2xl sm:text-3xl font-semibold text-gray-900">
              {headline}
            </h1>
            <p className="text-sm text-gray-500">
              Filter by date, time, cuisine, price, location, and party size — or tap a bubble.
            </p>
          </div>

          <FilterPanel cuisine={cuisine} onCuisineChange={setCuisine} />
        </div>
      </section>

      <footer className="relative z-10 px-6 py-3 text-center text-xs text-gray-400">
        Powered by Google Places · OpenRice · Claude
      </footer>
    </main>
  );
}
