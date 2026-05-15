'use client';

/**
 * One restaurant in the results list — OpenTable-style.
 *
 * Layout: thumbnail (left) + details (right). Time-slot pills sit at the
 * bottom and either deep-link to the booking platform or show "Check"
 * if we couldn't verify the slot.
 */

import type { Restaurant } from '@/lib/types';

export function RestaurantCard({
  r,
  onHover,
}: {
  r: Restaurant;
  onHover?: (placeId: string | null) => void;
}) {
  return (
    <article
      onMouseEnter={() => onHover?.(r.placeId)}
      onMouseLeave={() => onHover?.(null)}
      className="flex gap-4 border-b border-gray-100 py-5 last:border-0 group"
    >
      <div className="relative h-32 w-44 shrink-0 overflow-hidden rounded-lg bg-gray-100">
        {r.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={r.photoUrl}
            alt={r.name}
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
        ) : (
          <div className="h-full w-full shimmer" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <header className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-900 truncate">{r.name}</h2>
        </header>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Stars rating={r.rating} />
          <span className="text-gray-600">
            {r.userRatingsTotal > 0 ? `(${r.userRatingsTotal})` : ''}
          </span>
          <span className="text-gray-400">·</span>
          <span className="text-gray-700">{r.priceLabel}</span>
          {r.cuisine && (
            <>
              <span className="text-gray-400">·</span>
              <span className="text-gray-700">{r.cuisine}</span>
            </>
          )}
          {r.neighborhood && (
            <>
              <span className="text-gray-400">·</span>
              <span className="text-gray-700">{r.neighborhood}</span>
            </>
          )}
        </div>

        {r.description && (
          <p className="mt-1 text-sm text-gray-600 line-clamp-2">{r.description}</p>
        )}

        {r.availability && r.availability.length > 0 && (() => {
          const nextDate = r.availability.find((s) => s.nextAvailableDate)?.time;
          const nextDateLabel = nextDate
            ? new Date(nextDate).toLocaleDateString('en-GB', {
                weekday: 'short', day: 'numeric', month: 'short',
              })
            : null;
          return (
            <>
              {nextDateLabel && (
                <p className="mt-2 text-xs text-amber-700 font-medium">
                  Not available at your time — earliest open: {nextDateLabel}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {r.availability.slice(0, 5).map((slot) => {
                  const time = new Date(slot.time).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                  });
                  const href = slot.bookingUrl ?? r.bookingUrl ?? r.websiteUrl;
                  const Pill = (
                    <span
                      className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium text-white transition ${
                        slot.available && !slot.nextAvailableDate
                          ? 'bg-brand-red hover:bg-red-700'
                          : slot.nextAvailableDate
                          ? 'bg-amber-600 hover:bg-amber-700'
                          : 'bg-gray-400 hover:bg-gray-500'
                      }`}
                    >
                      {time}
                      {!slot.available && <sup className="ml-0.5">*</sup>}
                    </span>
                  );
                  return href ? (
                    <a key={slot.time} href={href} target="_blank" rel="noopener noreferrer">
                      {Pill}
                    </a>
                  ) : (
                    <div key={slot.time}>{Pill}</div>
                  );
                })}
              </div>
              {r.availability.some((s) => !s.available) && (
                <p className="mt-2 text-xs text-gray-400">
                  * Live availability unknown — click to confirm on the booking site.
                </p>
              )}
            </>
          );
        })()}
      </div>
    </article>
  );
}

function Stars({ rating }: { rating: number }) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return (
    <span className="text-amber-500 text-sm" aria-label={`${rating.toFixed(1)} out of 5`}>
      {'★'.repeat(full)}
      {half ? '☆' : ''}
      <span className="ml-1 font-medium text-gray-800">{rating.toFixed(1)}</span>
    </span>
  );
}
