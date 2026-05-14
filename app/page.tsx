'use client';

/**
 * Landing page.
 *
 * Minimalist single-screen layout matching the Meta AI screenshot:
 *   - Brand at top
 *   - Big rotating prompt above the chatbox
 *   - Chatbox (text + voice)
 *   - Two rows of horizontally-scrolling cuisine chips
 *
 * State is intentionally tiny — just the input value, lifted up so the chips
 * can push their label into the chatbox.
 */

import { useState } from 'react';
import { ChatBox } from './components/ChatBox';
import { CuisineBubbles } from './components/CuisineBubbles';

const HEADLINES = [
  'What are you in the mood for?',
  'Hungry? Just describe what you want.',
  'Find your next meal in one sentence.',
];

export default function Home() {
  const [input, setInput] = useState('');
  const headline = HEADLINES[Math.floor(Date.now() / 60_000) % HEADLINES.length];

  return (
    <main className="min-h-screen flex flex-col bg-gradient-to-b from-orange-50 via-white to-white">
      <header className="px-6 py-4 flex items-center justify-between">
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

      <section className="flex-1 flex flex-col justify-center items-center px-4">
        <div className="w-full max-w-2xl space-y-8">
          <div className="text-center space-y-2">
            <div className="mx-auto h-14 w-14 rounded-full bg-gradient-to-br from-brand-red via-orange-400 to-pink-500" />
            <h1 className="text-2xl font-semibold text-gray-900">{headline}</h1>
            <p className="text-sm text-gray-500">
              Tell me a cuisine, vibe, neighborhood, or just say it aloud.
            </p>
          </div>

          <ChatBox initialValue={input} />

          <CuisineBubbles onPick={(label) => setInput(label)} />
        </div>
      </section>

      <footer className="px-6 py-3 text-center text-xs text-gray-400">
        Powered by Google Places · OpenRice · Claude
      </footer>
    </main>
  );
}
