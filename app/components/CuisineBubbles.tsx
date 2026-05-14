'use client';

/**
 * Scrollable horizontal row of cuisine suggestion chips, mirroring the Meta AI
 * landing screen. Tapping a chip pre-fills the chatbox via the onPick callback.
 * Two rows of chips fit better on phones — we render two arrays.
 */

const ROW_1 = [
  { emoji: '🍣', label: 'Sushi & Japanese' },
  { emoji: '🥟', label: 'Dim Sum' },
  { emoji: '🍝', label: 'Italian tonight' },
  { emoji: '🥩', label: 'Steakhouse' },
  { emoji: '🌮', label: 'Mexican' },
];

const ROW_2 = [
  { emoji: '🍷', label: 'Romantic date night' },
  { emoji: '👨‍👩‍👧', label: 'Family-friendly' },
  { emoji: '🌃', label: 'Rooftop with a view' },
  { emoji: '🍜', label: 'Quick noodles nearby' },
  { emoji: '🎂', label: 'Birthday dinner' },
];

export function CuisineBubbles({ onPick }: { onPick: (label: string) => void }) {
  return (
    <div className="w-full space-y-2">
      <ChipRow items={ROW_1} onPick={onPick} />
      <ChipRow items={ROW_2} onPick={onPick} />
    </div>
  );
}

function ChipRow({
  items,
  onPick,
}: {
  items: { emoji: string; label: string }[];
  onPick: (label: string) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((c) => (
        <button
          key={c.label}
          onClick={() => onPick(c.label)}
          className="shrink-0 rounded-full border border-gray-200 bg-white px-4 py-2
                     text-sm text-gray-700 shadow-sm hover:bg-gray-50 active:scale-95
                     transition"
        >
          <span className="mr-1">{c.emoji}</span>
          {c.label}
        </button>
      ))}
    </div>
  );
}
