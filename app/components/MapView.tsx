'use client';

/**
 * Google Map with one marker per restaurant.
 *
 * We load the Maps JS API via @googlemaps/js-api-loader rather than dropping
 * a <script> tag — the loader memoises so React StrictMode's double-mount in
 * dev doesn't load the script twice.
 *
 * Hovering a card on the left highlights the matching marker (controlled
 * via the highlightId prop coming from the parent page).
 */

import { useEffect, useRef } from 'react';
import { Loader } from '@googlemaps/js-api-loader';
import type { Restaurant } from '@/lib/types';

interface Props {
  restaurants: Restaurant[];
  highlightId?: string | null;
}

export function MapView({ restaurants, highlightId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map());

  // Initial load.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.warn('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY missing — map will not render');
      return;
    }
    const loader = new Loader({ apiKey, version: 'weekly' });
    void loader.load().then(() => {
      mapRef.current = new google.maps.Map(containerRef.current!, {
        center: { lat: 22.302711, lng: 114.177216 }, // HK Central default
        zoom: 13,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
      });
      renderMarkers();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render markers whenever restaurants change.
  useEffect(() => {
    if (mapRef.current) renderMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurants]);

  // Visually highlight one marker when the user hovers a card.
  useEffect(() => {
    markersRef.current.forEach((marker, id) => {
      marker.setAnimation(
        id === highlightId ? google.maps.Animation.BOUNCE : null
      );
    });
  }, [highlightId]);

  function renderMarkers() {
    const map = mapRef.current;
    if (!map) return;
    // Clear old markers.
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current.clear();

    if (restaurants.length === 0) return;
    const bounds = new google.maps.LatLngBounds();

    restaurants.forEach((r) => {
      if (!r.location.lat) return;
      const marker = new google.maps.Marker({
        position: r.location,
        map,
        title: r.name,
        label: {
          text: '🍽',
          fontSize: '14px',
        },
      });
      markersRef.current.set(r.placeId, marker);
      bounds.extend(r.location);
    });

    if (!bounds.isEmpty()) map.fitBounds(bounds, 60);
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
