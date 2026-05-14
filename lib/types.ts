/**
 * Shared types used by both server (API routes) and client (pages/components).
 * Keeping one source of truth means renaming a field shows compile errors
 * everywhere it's used, not just where you remember to check.
 */

export type PriceTier = 0 | 1 | 2 | 3 | 4 | 5 | 6;
// OpenRice price mapping per spec:
// 0=N/A, 1=Under $50, 2=$51-100, 3=$101-200,
// 4=$201-400, 5=$401-800, 6=Over $801
export const PRICE_LABELS: Record<PriceTier, string> = {
  0: 'Price N/A',
  1: 'Under $50',
  2: '$51–100',
  3: '$101–200',
  4: '$201–400',
  5: '$401–800',
  6: 'Over $801',
};

export interface TimeSlot {
  /** ISO-8601 e.g. "2026-05-28T19:00:00+08:00" */
  time: string;
  /** Whether the slot is bookable right now. */
  available: boolean;
  /** Deep-link to the booking platform's reservation page for this slot. */
  bookingUrl?: string;
}

export interface Restaurant {
  /** Google Places place_id — stable unique identifier. */
  placeId: string;
  name: string;
  /** AI-generated 2-3 sentence description (formality + ambience + specialties). */
  description: string;
  rating: number;        // 0–5
  userRatingsTotal: number;
  priceTier: PriceTier;
  priceLabel: string;    // human-readable from PRICE_LABELS
  address: string;
  neighborhood?: string; // e.g. "Central", "Tsim Sha Tsui"
  location: { lat: number; lng: number };
  openingHours?: string[]; // one string per weekday
  openNow?: boolean;
  photoUrl?: string;
  cuisine?: string;
  /** Restaurant's own website (from Places). */
  websiteUrl?: string;
  /** Reservation platform URL (OpenTable, Inline, SevenRooms, etc.) if detected. */
  bookingUrl?: string;
  /** Up to ~5 time slots near the requested time. */
  availability?: TimeSlot[];
}

export interface SearchQuery {
  /** Free-text user query — e.g. "romantic sushi in Central". */
  text: string;
  /** Requested booking date/time as ISO 8601. */
  dateTime?: string;
  /** Number of diners. */
  partySize?: number;
  /** Optional geographic anchor for "near me" semantics. */
  near?: { lat: number; lng: number; label: string };
}

export interface ChatResponse {
  /** Where to redirect the user to see results. */
  searchUrl: string;
  /** Echoed parsed query for the search page to render. */
  query: SearchQuery;
}
