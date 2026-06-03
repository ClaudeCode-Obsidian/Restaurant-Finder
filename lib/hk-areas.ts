/**
 * Hong Kong dining-area bounding boxes — used to geographically RESTRICT a
 * search to the area the user picked.
 *
 * Why this exists: the area used to travel only as words in the text query
 * ("Italian restaurant in Central, Hong Kong"). Google Places treats "in
 * Central" as a SOFT relevance hint, not a hard filter, so a "Central" search
 * leaked in Causeway Bay / Wan Chai / Kowloon restaurants — and our rating
 * re-rank then promoted the highly-reviewed out-of-area ones to the top. A
 * hard `locationRestriction` confines the candidate pool to the area at the
 * source, which both fixes the leak and neutralises the re-rank (it can only
 * reorder in-area places now).
 *
 * Shape: each entry is a rectangle (Google Places Text Search accepts ONLY a
 * rectangle for a hard locationRestriction — circles are bias-only). `low` is
 * the SW corner, `high` the NE corner. `center` is the district's MTR /
 * commercial heart, kept for an optional future distance-trim of the box's
 * far corners.
 *
 * Sizing: centres anchored on the MTR station; box half-extents ~0.5–1.0 km
 * (tighter for the small, nested western districts; wider for the larger
 * commercial ones) plus a margin for Google's geocoding wobble. Validated
 * against the live Places API — every box's results cluster in the right
 * district and none reach across the harbour.
 *
 * Keys MUST match the exact strings the FilterPanel LOCATIONS dropdown emits.
 * Areas absent here (the free-text "Others…" option, or "Any area") get no
 * restriction and fall back to the HK-wide bias.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface AreaBox {
  /** District centre (MTR / commercial heart). For optional distance trims. */
  center: LatLng;
  /** SW corner of the restriction rectangle. */
  low: LatLng;
  /** NE corner of the restriction rectangle. */
  high: LatLng;
}

export const HK_AREA_BOXES: Record<string, AreaBox> = {
  Central: {
    center: { latitude: 22.2819, longitude: 114.1578 },
    low: { latitude: 22.274, longitude: 114.148 },
    high: { latitude: 22.29, longitude: 114.168 },
  },
  // FilterPanel emits the value 'Soho' (not 'SoHo') — key must match exactly.
  Soho: {
    center: { latitude: 22.282, longitude: 114.1518 },
    low: { latitude: 22.277, longitude: 114.147 },
    high: { latitude: 22.287, longitude: 114.157 },
  },
  'Sheung Wan': {
    center: { latitude: 22.2866, longitude: 114.1515 },
    low: { latitude: 22.281, longitude: 114.146 },
    high: { latitude: 22.292, longitude: 114.157 },
  },
  Admiralty: {
    center: { latitude: 22.2785, longitude: 114.165 },
    low: { latitude: 22.274, longitude: 114.16 },
    high: { latitude: 22.283, longitude: 114.17 },
  },
  'Wan Chai': {
    center: { latitude: 22.278, longitude: 114.174 },
    low: { latitude: 22.271, longitude: 114.166 },
    high: { latitude: 22.285, longitude: 114.182 },
  },
  'Causeway Bay': {
    center: { latitude: 22.28, longitude: 114.185 },
    low: { latitude: 22.273, longitude: 114.177 },
    high: { latitude: 22.288, longitude: 114.193 },
  },
  'Tsim Sha Tsui': {
    center: { latitude: 22.2978, longitude: 114.1722 },
    low: { latitude: 22.289, longitude: 114.163 },
    high: { latitude: 22.307, longitude: 114.182 },
  },
  'Mong Kok': {
    center: { latitude: 22.3186, longitude: 114.1694 },
    low: { latitude: 22.311, longitude: 114.161 },
    high: { latitude: 22.327, longitude: 114.177 },
  },
  'Sai Ying Pun': {
    center: { latitude: 22.2856, longitude: 114.1425 },
    low: { latitude: 22.28, longitude: 114.137 },
    high: { latitude: 22.291, longitude: 114.148 },
  },
  'Kennedy Town': {
    center: { latitude: 22.2818, longitude: 114.129 },
    low: { latitude: 22.275, longitude: 114.122 },
    high: { latitude: 22.289, longitude: 114.136 },
  },
  'Quarry Bay': {
    center: { latitude: 22.2882, longitude: 114.2097 },
    low: { latitude: 22.281, longitude: 114.202 },
    high: { latitude: 22.296, longitude: 114.218 },
  },
};

/** Look up an area's box by the FilterPanel value. Returns undefined for
 *  "Any area" (''), an unknown/custom ("Others…") area, or null/undefined. */
export function areaBox(area?: string | null): AreaBox | undefined {
  if (!area) return undefined;
  return HK_AREA_BOXES[area];
}
