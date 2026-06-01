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
  /**
   * True when this slot is real but for a DIFFERENT day than the user
   * asked for — e.g. the user searched "May 30" but the restaurant's
   * earliest opening is "May 16". The UI shows these with a
   * "Next available: <date>" badge instead of pretending they match.
   */
  nextAvailableDate?: boolean;
  /**
   * True when this slot IS on the user's requested day, but at a
   * different time of day than they asked for — e.g. they searched
   * "May 28 at 19:00" but only the lunch service (11:00–13:00) is
   * visible on Google Reserve's default view. The UI shows these
   * with an "Other times on <date>" banner so the user understands
   * the date is right but the time isn't.
   */
  nextAvailableTime?: boolean;
}

/**
 * Why a restaurant's availability looks the way it does. Drives which
 * message the card shows when there are no directly-bookable (green) slots:
 *   - 'available'       → we found real slots (green and/or amber alternatives)
 *   - 'no_booking_link' → no reservation system found (walk-in only) → message 1
 *   - 'check_failed'    → a booking system exists but we couldn't read it → message 2
 *   - 'no_slots'        → checked OK, nothing available near the request → message 3
 */
export type AvailabilityStatus =
  | 'available'
  | 'no_booking_link'
  | 'check_failed'
  | 'no_slots';

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
  /** True when priceTier came from a real source (Places / Maps / OpenRice);
   *  false when it's an estimate (Claude or cuisine default). Lets price
   *  filtering keep "unconfirmed" places instead of dropping them. */
  priceConfirmed?: boolean;
  address: string;
  neighborhood?: string; // e.g. "Central", "Tsim Sha Tsui"
  location: { lat: number; lng: number };
  openingHours?: string[]; // one string per weekday
  openNow?: boolean;
  photoUrl?: string;
  cuisine?: string;
  /** Restaurant's own website (from Places). */
  websiteUrl?: string;
  /** Google flags restaurant as reservable (signal for trying booking lookups). */
  reservable?: boolean;
  /** Reservation platform URL (OpenTable, Inline, SevenRooms, etc.) if detected. */
  bookingUrl?: string;
  /** Up to ~5 time slots near the requested time. */
  availability?: TimeSlot[];
  /** Why availability looks the way it does — picks the card's message. */
  availabilityStatus?: AvailabilityStatus;
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
