'use client';

/**
 * Floating, high-transparency THOUGHT bubbles (cloud shape), scattered
 * around the edges of the screen so they orbit the centred filter panel
 * without covering it.
 *
 * Shape: a thought/cloud silhouette built from a cluster of overlapping
 * SVG circles plus two small trailing circles (the classic "thinking"
 * tail). The whole SVG group is rendered at low opacity for the wispy,
 * see-through look the user asked for. Filling each circle opaque and
 * dropping opacity at the GROUP level (not per-circle) keeps the overlaps
 * from stacking into dark seams.
 *
 * Positioning: a fixed, full-viewport layer behind the content (z-0,
 * pointer-events-none) with each bubble re-enabling pointer events. The
 * layout percentages hug the perimeter, leaving the central column clear.
 *
 * Deterministic per-index layout (no Math.random) keeps SSR and CSR
 * identical. Clicking a bubble pre-selects the cuisine dropdown.
 */
import { useEffect, useState } from 'react';

const CUISINES = [
  { emoji: '🍣', label: 'Japanese' },
  { emoji: '🥟', label: 'Dim Sum' },
  { emoji: '🍝', label: 'Italian' },
  { emoji: '🥩', label: 'Steakhouse' },
  { emoji: '🌮', label: 'Mexican' },
  { emoji: '🥖', label: 'French' },
  { emoji: '🍜', label: 'Vietnamese' },
  { emoji: '🌶️', label: 'Thai' },
  { emoji: '🍔', label: 'American' },
  { emoji: '🦞', label: 'Seafood' },
];

// Edge-hugging anchor points (percent of viewport). Ordered so the first
// ten cuisines spread evenly down the left side, down the right side, then
// fill the top and bottom gaps — keeping the centre clear for the panel.
const ANCHORS = [
  { left: 3, top: 16 },
  { left: 6, top: 45 },
  { left: 4, top: 73 },
  { left: 87, top: 14 },
  { left: 90, top: 42 },
  { left: 85, top: 71 },
  { left: 24, top: 6 },
  { left: 63, top: 7 },
  { left: 22, top: 84 },
  { left: 66, top: 85 },
];

interface BubbleLayout {
  left: number;
  top: number;
  size: number; // px
  duration: number; // s
  delay: number; // s
  drift: number; // px
  variant: 0 | 1 | 2 | 3;
}

function makeLayout(n: number): BubbleLayout[] {
  return Array.from({ length: n }, (_, i) => {
    const a = ANCHORS[i % ANCHORS.length];
    return {
      left: a.left,
      top: a.top,
      size: 132 + ((i * 17) % 48),
      duration: 11 + ((i * 5) % 8),
      delay: -((i * 1.7) % 9),
      drift: 16 + ((i * 9) % 20),
      variant: ((i + (i >> 1)) % 4) as 0 | 1 | 2 | 3,
    };
  });
}

export function CuisineBubbles({ onPick }: { onPick: (label: string) => void }) {
  const [layout, setLayout] = useState<BubbleLayout[]>([]);
  useEffect(() => setLayout(makeLayout(CUISINES.length)), []);

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none">
      {layout.map((b, i) => {
        const c = CUISINES[i];
        return (
          <button
            key={c.label}
            onClick={() => onPick(c.label)}
            aria-label={c.label}
            className="pointer-events-auto absolute group focus:outline-none"
            style={
              {
                left: `${b.left}%`,
                top: `${b.top}%`,
                width: b.size,
                height: b.size,
                animation: `bubble-float-${b.variant} ${b.duration}s ease-in-out ${b.delay}s infinite`,
                ['--drift' as string]: `${b.drift}px`,
              } as React.CSSProperties
            }
          >
            <ThoughtBubble index={i} />
            <span className="absolute left-1/2 top-[42%] z-10 -translate-x-1/2 -translate-y-1/2 text-3xl sm:text-4xl drop-shadow">
              {c.emoji}
            </span>
            <span className="absolute left-1/2 top-[42%] z-10 hidden -translate-x-1/2 translate-y-6 whitespace-nowrap text-xs font-medium text-gray-700 group-hover:block">
              {c.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The cloud silhouette. Six body circles form the puffy top; two small
 * circles form the thinking tail at the bottom-left. Group opacity gives
 * the see-through wash; the radial gradient adds a faint iridescent tint
 * and a top-left highlight so it still reads as a bubble, not a flat blob.
 */
function ThoughtBubble({ index }: { index: number }) {
  const gid = `irid-${index}`;
  return (
    <svg
      viewBox="0 0 120 112"
      className="absolute inset-0 h-full w-full transition-transform duration-300 group-hover:scale-110 group-active:scale-95"
      style={{ filter: 'drop-shadow(0 6px 14px rgba(150,170,220,0.25))' }}
    >
      <defs>
        <radialGradient id={gid} cx="34%" cy="28%" r="80%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="38%" stopColor="#d4e6ff" />
          <stop offset="68%" stopColor="#ecd9ff" />
          <stop offset="100%" stopColor="#d6ffec" />
        </radialGradient>
      </defs>
      {/* opacity on the group → uniform transparency, no seam stacking */}
      <g fill={`url(#${gid})`} opacity={0.34}>
        <circle cx="42" cy="46" r="24" />
        <circle cx="66" cy="36" r="28" />
        <circle cx="90" cy="48" r="22" />
        <circle cx="56" cy="62" r="26" />
        <circle cx="80" cy="64" r="22" />
        <circle cx="34" cy="62" r="18" />
        {/* thinking tail */}
        <circle cx="30" cy="88" r="9" />
        <circle cx="18" cy="100" r="5.5" />
      </g>
    </svg>
  );
}
