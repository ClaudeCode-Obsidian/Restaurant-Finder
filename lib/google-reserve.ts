/**
 * Google Maps booking-link discovery + time-slot scraping.
 *
 * TWO-STAGE FLOW per restaurant:
 *
 *   Stage A — Booking URL discovery (Playwright):
 *     Open /maps/place/?q=place_id:<id>. Find the "Reserve a table"
 *     anchor; its href is the Google Reserve universal URL
 *     /maps/reserve/v/dine/c/<token>. Cached per placeId.
 *
 *   Stage B — Slot extraction (Playwright + date-picker interaction):
 *     Open the Reserve URL, click the date picker, click the user's
 *     requested day. The slot list in the DOM updates client-side
 *     (no XHR — slots are computed from an inline schedule the page
 *     embeds), then we read the `data-bts="<unix_seconds>"` attributes
 *     for the now-selected date and filter to ±60 min of target.
 *
 * Why Stage B can't be pure HTTP: a plain fetch returns the page with
 * slots for the restaurant's NEXT available date only — May 16 even if
 * the user asked for May 30. Earlier date-param tricks (?date=, etc.)
 * are ignored by the server. The Reserve page's date picker is purely
 * client-side; selecting a different day is the only way to surface
 * its slots, and the JS that does so is too gnarly to reimplement.
 *
 * If the user's date isn't in the picker (restaurant fully booked /
 * not bookable on that day), we fall back to the slots Google shows
 * by default — flagged `nextAvailableDate: true` for the UI.
 *
 * STANDARDISED OUTPUT
 *   { time: ISO-8601, available: true, bookingUrl: <google reserve url> }
 * The `bookingUrl` deep-links into Google's flow which routes to whichever
 * underlying partner (OpenTable / Inline / OpenRice / Diningcity) the
 * restaurant uses.
 */

import type { BrowserContext, Page } from 'playwright';
import { acquire, getBrowser, newGoogleContext, release } from './playwright-pool';
import type { PriceTier, TimeSlot } from './types';

const PAGE_TIMEOUT_MS = 25_000;
// Generous ceiling for selector-based hydration waits. We resolve as
// soon as the target element appears; this is just the worst-case bail.
const HYDRATION_TIMEOUT_MS = 6000;
// Post-click settle: after a small interaction (party-size pick),
// give the widget a moment to register the change before we do the
// next thing. Used inside selectPartySize.
const POST_CLICK_MS = 750;
// After we click the date, the slot list refreshes lazily — sometimes
// up to 4–5 s on slow restaurants. Wait for at least one `data-bts`
// slot to appear, capped at this many milliseconds. If nothing
// appears in this window, the restaurant has no slots that day.
const SLOT_LOAD_TIMEOUT_MS = 6_000;
const SLOT_WINDOW_MIN = 60;       // ±60 minutes around requested time

/* ─────────── Maps-data cache (booking URL + price tier) ─────────── */

export interface MapsData {
  /** Google Reserve URL — the `/maps/reserve/v/dine/c/<token>` shape. */
  bookingUrl: string | null;
  /** 0 = unknown; 1–6 mapped from Google Maps price range. */
  priceTier: PriceTier;
}

// We cache PROMISES (not values) so concurrent callers for the same
// placeId share one Playwright fetch instead of racing two.
const _mapsDataCache = new Map<string, Promise<MapsData>>();

/* ─────────── Public API ─────────── */

export interface ReserveInput {
  placeId: string;
  dateTime: string;      // ISO 8601
  partySize: number;
}

/**
 * Read Google Maps for a placeId — single Playwright visit yields both
 * the Reserve booking URL and the price-range tier. Cached by placeId.
 *
 * Used by:
 *   - /api/restaurants price column (replaces the OpenRice scrape, which
 *     was both slow and bot-blocked)
 *   - fetchReserveSlots (below), which consumes the bookingUrl
 */
export function fetchMapsData(placeId: string): Promise<MapsData> {
  if (_mapsDataCache.has(placeId)) return _mapsDataCache.get(placeId)!;
  const p = doFetchMapsData(placeId);
  _mapsDataCache.set(placeId, p);
  return p;
}

/** Sugar: returns just the price tier (0 if unknown). */
export async function fetchGoogleMapsPrice(placeId: string): Promise<PriceTier> {
  return (await fetchMapsData(placeId)).priceTier;
}

/**
 * Outcome of a Reserve lookup. We return a STATUS alongside the slots so
 * the UI can tell the user the truth instead of a catch-all "unknown":
 *   - 'ok'       → slots holds real times (may be empty only if you ignore it)
 *   - 'no_link'  → this restaurant has no Google Reserve booking link
 *   - 'failed'   → the booking page exists but we couldn't load/read it
 *   - 'no_slots' → the page loaded fine but had no bookable times that day
 */
export type ReserveStatus = 'ok' | 'no_link' | 'failed' | 'no_slots';
export interface ReserveResult {
  slots: TimeSlot[];
  status: ReserveStatus;
}

/**
 * Given a Google placeId + requested date/time, return ±1-hour TimeSlots
 * scraped from Google's Reserve flow with the date picker driven to the
 * user's requested day, PLUS a status explaining the outcome (see
 * ReserveStatus). The caller maps that status to a user-facing message.
 */
export async function fetchReserveSlots(input: ReserveInput): Promise<ReserveResult> {
  // ORDER MATTERS: read the cached Maps result FIRST, bail if there's
  // no booking URL, and only then take a concurrency slot. Otherwise
  // we'd hold a slot we never use — starving real Reserve scrapes
  // behind us in the queue for ~no reason. `fetchMapsData` is itself
  // promise-cached, so this await is free if `fetchGoogleMapsPrice`
  // for the same placeId is already in flight (which it always is —
  // the route fires both in the same `Promise.all`).
  const { bookingUrl } = await fetchMapsData(input.placeId);
  if (!bookingUrl) return { slots: [], status: 'no_link' };

  // Safe to take a slot now — we know we have real work to do.
  await acquire();
  let ctx: BrowserContext | null = null;
  // Did the Reserve widget actually render? Lets us distinguish a genuine
  // "no times that day" (widget there, zero slots) from a load failure
  // (widget never appeared) when the slot list comes back empty.
  let hydrated = false;
  try {
    const browser = await getBrowser();
    ctx = await newGoogleContext(browser);
    const page = await ctx.newPage();
    await page.goto(bookingUrl, { waitUntil: 'commit', timeout: PAGE_TIMEOUT_MS });
    // Wait for the Reserve widget to hydrate — resolves the moment we
    // see EITHER the date picker (so we can drive it) OR pre-rendered
    // slots (so we can read them). Typically fires in 200–800 ms; the
    // 6 s cap is a defensive ceiling, not the expected wait.
    hydrated = await page
      .waitForSelector('[aria-label*="reservation date" i], [data-bts]', {
        timeout: HYDRATION_TIMEOUT_MS,
      })
      .then(() => true)
      .catch(() => false);

    // Drive the date picker to the user's requested day. Falls through
    // silently if the date is unavailable — we'll harvest whatever the
    // page is currently showing and label it next-available.
    //
    // FAST PATH: when the target IS today, skip the picker entirely.
    // Reserve always loads with today as the selected date, and Google
    // labels the today option as "Today" (not "May 16"), so a date-
    // string lookup misses it and selectDate spuriously returns false.
    // Skipping is both correct (page is already on the right day) and
    // faster (~1–2 s saved on every "search for tonight" request).
    const target = new Date(input.dateTime);
    const dateMatched = isSameDayInHK(target, new Date())
      ? true
      : await selectDate(page, target);
    if (input.partySize !== 2) await selectPartySize(page, input.partySize);
    // ALWAYS set the time (not just when non-default) because Reserve's
    // default is "current clock time rounded up" — which has nothing to
    // do with the user's requested time. Without this, Reserve renders
    // the 9-pill slot list centered on its default time, not ours, and
    // our ±60 min window filter then excludes the slots the user
    // actually wants. Verified empirically against ZZURA:
    //   - No time set → slots 18:30–20:30 (centered on Reserve's 19:30 default)
    //   - Time = 18:00 → slots 17:00–19:00 (centered on 18:00) ✓
    await selectTime(page, target);

    // Wait for the slot list to actually populate before we read the
    // DOM. Reserve refreshes its slot pills lazily after the date
    // click — empirically up to 4–5 s on slower restaurants (La
    // Camionetta and similar late-service places).
    //
    // CRITICAL: when we navigated to a NON-today date, we must wait for
    // a slot ON THE TARGET DAY to appear — NOT merely for "any data-bts".
    // The page loads showing TODAY's slots, so `[data-bts]` is already
    // present the instant we arrive; a bare waitForSelector resolves
    // immediately and we then read TODAY's stale slots before the list
    // has re-rendered to the requested day. Because today's and the
    // target day's slots share identical clock times (18:00, 18:15, …)
    // and differ only in their embedded date, this misfire is invisible
    // downstream: parseSlotsFromHtml sees times ~24 h from target, finds
    // nothing in the ±60 min window, and mislabels them "next available
    // date" (or, if we happen to read during the brief empty-list moment
    // mid-refresh, returns 0 slots → placeholder "availability unknown").
    // Restaurants with several seating areas (e.g. WAKARAN: Counter /
    // High-Top / Main Dining) re-render more slowly and hit this most.
    //
    // So: drove to a specific day → wait for that day's slots. Otherwise
    // (today fast-path) the simple "any slot" wait is correct.
    const droveToOtherDay = dateMatched && !isSameDayInHK(target, new Date());
    if (droveToOtherDay) {
      await waitForSlotsOnDay(page, target).catch(() => undefined);
    } else {
      await page
        .waitForSelector('[data-bts]', { timeout: SLOT_LOAD_TIMEOUT_MS })
        .catch(() => undefined);
    }

    const html = await page.content();
    const slots = parseSlotsFromHtml(html, input.dateTime, bookingUrl, dateMatched);
    if (slots.length > 0) return { slots, status: 'ok' };
    // Empty result: if the widget hydrated, the restaurant genuinely has
    // no bookable times that day; if it never hydrated, our scrape failed.
    return { slots: [], status: hydrated ? 'no_slots' : 'failed' };
  } catch {
    return { slots: [], status: 'failed' };
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
    release();
  }
}

/**
 * Are two dates the same calendar day in Asia/Hong_Kong?
 *
 * We compare in HK time because that's what Reserve's date picker is
 * rendering against — a 23:30 UTC search "for today" is actually for
 * tomorrow in HK and shouldn't take the today fast path.
 *
 * en-CA gives a clean YYYY-MM-DD format that's safe to string-compare.
 */
function isSameDayInHK(a: Date, b: Date): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(a) === fmt.format(b);
}

/**
 * Wait until at least one slot pill (`data-bts`) on the TARGET HK calendar
 * day has rendered. Used after navigating the date picker to a non-today
 * day, to defeat the stale-slot race described at the call site.
 *
 * We compute the target HK day's bounds as a UTC-ms window and check each
 * `data-bts` (which is a unix-seconds timestamp) against it. HK = UTC+8,
 * no DST, so 00:00 HKT on day D is `Date.UTC(y, m-1, d, -8, 0)`.
 *
 * Resolves as soon as a matching slot appears; rejects on timeout, which
 * the caller swallows (a genuinely fully-booked day legitimately has no
 * slots, and parseSlotsFromHtml then handles the empty result).
 */
async function waitForSlotsOnDay(page: Page, target: Date): Promise<void> {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(target);
  const [y, mo, d] = ymd.split('-').map(Number);
  const dayStart = Date.UTC(y, mo - 1, d, -8, 0); // 00:00 HKT in UTC ms
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  await page.waitForFunction(
    ({ lo, hi }) => {
      const els = document.querySelectorAll('[data-bts]');
      for (const el of Array.from(els)) {
        const ms = parseInt(el.getAttribute('data-bts') || '0', 10) * 1000;
        if (ms >= lo && ms < hi) return true;
      }
      return false;
    },
    { lo: dayStart, hi: dayEnd },
    { timeout: SLOT_LOAD_TIMEOUT_MS },
  );
}

/**
 * Click the date selector and pick the day matching `target`.
 * Returns true if the date was actually selected, false if it wasn't
 * available (date out of range / restaurant not bookable that day /
 * picker never rendered).
 *
 * Robustness strategy — five guards layered on top of the bare flow:
 *
 *   GUARD 1 (open the picker reliably). Retry the WHOLE attempt once
 *     if anything throws. Common cause of one-shot failure: the trigger
 *     click landed before the page was interactive, so the dropdown
 *     opened then immediately closed when its own JS booted.
 *
 *   GUARD 2 (wait for the dropdown content, not a fixed timer). After
 *     clicking the trigger, wait for ANY visible date option to appear
 *     instead of sleeping 800 ms. This both confirms the dropdown
 *     opened AND survives slow renders.
 *
 *   GUARD 3 (scroll the target into view). The dropdown is a scrollable
 *     list; dates 3+ weeks out are off-screen even though they're in
 *     the DOM. A plain `waitFor({state: 'visible'})` would fail on
 *     those. Scrolling first makes the wait meaningful.
 *
 *   GUARD 4 (skip disabled dates). Reserve marks unbookable dates with
 *     `aria-disabled="true"` — clicking does nothing. Check before
 *     clicking; return false so the caller can surface "no booking".
 *
 *   GUARD 5 (verify the click actually landed). After clicking, poll
 *     for the trigger's text/aria-label to reflect the new date.
 *     If it doesn't change, the click missed and slots haven't
 *     refreshed — better to return false than silently surface
 *     wrong-date slots flagged as confirmed.
 *
 * The dropdown items have aria-labels like "Friday 1 May", "Thursday
 * 28 May" — en-GB day-first because Google bakes `hl=en-GB` into the
 * booking URL. Verified empirically by dumping the picker DOM; if
 * Google ever changes this, all of these will need re-verification.
 */
async function selectDate(page: Page, target: Date): Promise<boolean> {
  // Build the search string ONCE, outside the retry loop.
  // Leading space stops "1 May" from substring-matching "11 May".
  const dayMonth = target.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
  });
  const needle = ` ${dayMonth}`; // " 28 May"

  // Build the list of trigger tokens that mean "the picker is showing
  // the target date". Reserve uses RELATIVE labels for the next two
  // days ("Today" / "Tomorrow") and the absolute "<day> <month>" form
  // for everything further out. So depending on how far the target is,
  // any of these should be treated as a match.
  //
  // This is the key bit that the old Guard 5 got wrong: it required
  // the absolute " 22 May" string in the trigger even when Reserve was
  // displaying "Tomorrow" there. Click landed correctly, trigger said
  // "Tomorrow", Guard 5 returned false, the retry path then re-clicked
  // the now-selected day and toggled the page back to Today. The
  // scrape then read today's residual slots and labelled them
  // nextAvailableDate. Painful.
  const targetTokens: string[] = [needle.toLowerCase().trim()];
  if (isSameDayInHK(target, new Date())) targetTokens.push('today');
  if (isTomorrowInHK(target)) targetTokens.push('tomorrow');

  const readTrigger = () =>
    page.evaluate(() => {
      const t = document.querySelector('[aria-label*="reservation date" i]');
      if (!t) return '';
      return (
        (t.getAttribute('aria-label') ?? '') +
        ' ' +
        (t.textContent ?? '')
      ).toLowerCase();
    });

  // PRE-FLIGHT — if the picker is already showing the target date
  // (Reserve auto-defaulted there because today is fully booked / past
  // last service), the click is unnecessary and the retry path below
  // would only break things. Trust the trigger and skip the dance.
  const initialTrigger = await readTrigger();
  if (targetTokens.some((tok) => initialTrigger.includes(tok))) return true;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // GUARD 1 — open the picker (first time, or after a missed retry).
      await page
        .locator('[aria-label*="reservation date" i]')
        .first()
        .click({ timeout: 4000 });

      // GUARD 2 — wait for the dropdown to actually contain date options.
      // We look for any aria-label that mentions a month name. Resolves
      // typically <200 ms when fast, <2 s under contention.
      await page.waitForSelector(
        '[aria-label*=" May" i], [aria-label*=" June" i], [aria-label*=" July" i], ' +
          '[aria-label*=" August" i], [aria-label*=" September" i], ' +
          '[aria-label*=" October" i], [aria-label*=" November" i], ' +
          '[aria-label*=" December" i], [aria-label*=" January" i], ' +
          '[aria-label*=" February" i], [aria-label*=" March" i], [aria-label*=" April" i]',
        { timeout: 3000 },
      );

      const item = page.locator(`[aria-label*="${needle}" i]`).first();

      // GUARD 3 — pull the target into the viewport before waiting on
      // visibility. The dropdown's an internal scroller; far-out dates
      // exist in DOM but are clipped until scrolled.
      await item.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
      await item.waitFor({ state: 'visible', timeout: 3000 });

      // GUARD 4 — refuse to click a disabled date. Reserve marks
      // unbookable days `aria-disabled="true"`; clicking is a no-op
      // and we'd silently mislabel slots from a different date.
      const disabled = await item.getAttribute('aria-disabled');
      if (disabled === 'true') return false;

      // Snapshot the trigger RIGHT BEFORE we click the item. The
      // dropdown is open at this point, but the trigger's text/
      // aria-label still reflects the pre-click selected date. We use
      // this as the "before" reference for Guard 5.
      const beforeTrigger = await readTrigger();

      await item.click({ timeout: 4000 });

      // GUARD 5 (revised) — confirm the click landed by waiting for the
      // trigger to either:
      //   (a) include a recognised target token (absolute "22 May",
      //       relative "Today" / "Tomorrow"), OR
      //   (b) simply change from its pre-click value (any change at
      //       all is evidence the date selection updated).
      //
      // Either signal is sufficient because we don't actually know
      // which label format Reserve will use for this particular date.
      // Asserting on ONLY the absolute form was the original bug.
      const triggerChanged = await page
        .waitForFunction(
          ({ before, tokens }) => {
            const t = document.querySelector('[aria-label*="reservation date" i]');
            if (!t) return false;
            const haystack = (
              (t.getAttribute('aria-label') ?? '') +
              ' ' +
              (t.textContent ?? '')
            ).toLowerCase();
            if (tokens.some((tok: string) => haystack.includes(tok))) return true;
            if (haystack.trim() && haystack !== before) return true;
            return false;
          },
          { before: beforeTrigger, tokens: targetTokens },
          { timeout: 2500 },
        )
        .then(() => true)
        .catch(() => false);

      if (!triggerChanged) {
        // The click resolved without throwing but the trigger didn't
        // update. Almost always means the dropdown closed before our
        // click registered. Loop around for a retry.
        if (attempt === 0) {
          await page.waitForTimeout(400);
          continue;
        }
        return false;
      }

      // Slot list refreshes client-side after the click with no visible
      // loading state — a small fixed wait is the cleanest option.
      await page.waitForTimeout(POST_CLICK_MS);
      return true;
    } catch {
      // Whole attempt failed. Brief settle then retry once; many
      // failures here are transient timing races.
      if (attempt === 0) {
        await page.waitForTimeout(400);
        continue;
      }
      return false;
    }
  }
  return false;
}

/** Is `target` the next calendar day after today, in Asia/Hong_Kong? */
function isTomorrowInHK(target: Date): boolean {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return isSameDayInHK(target, tomorrow);
}

/**
 * Pick the time-of-day dropdown.
 *
 * Reserve's coarse time selector is the same MDC Mat-Select pattern as
 * party size:
 *
 *   <div role="combobox" aria-haspopup="listbox">19:30</div>   ← trigger
 *   <ul aria-label="Select reservation time" role="listbox" HIDDEN>
 *     <li role="option" data-value="00:00">00:00</li>
 *     <li role="option" data-value="00:30">00:30</li>
 *     …
 *     <li role="option" data-value="23:30">23:30</li>
 *
 * 49 options in 30-minute increments. This is NOT the slot list — it's
 * the coarse "what time do you roughly want" picker. Reserve uses
 * whatever's selected here to centre the 9 fine-grained slot pills
 * (15-min granularity) shown below.
 *
 * Why this is critical: Reserve's default time is "current clock time
 * rounded up to the next half-hour", not anything related to the
 * user's request. So a search "tomorrow at 18:00" run at 19:15 HKT
 * would land Reserve on 19:30 by default, slot pills would centre on
 * 19:30 (showing ~18:30–20:30), and our ±60 min filter around the
 * requested 18:00 would miss everything before 18:30 — including the
 * 18:00 slot itself, which is exactly the regression you screenshotted.
 *
 * The dropdown only steps by 30 min, so we FLOOR the request (round
 * down). Flooring guarantees the user's exact requested minute is
 * inside the 60-min window Reserve renders to the right of the picked
 * coarse time, which is what we want for the ±60 min slot filter
 * downstream.
 */
async function selectTime(page: Page, target: Date): Promise<void> {
  try {
    const hkHM = target.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Hong_Kong',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const [h, mRaw] = hkHM.split(':').map(Number);
    const m = mRaw >= 30 ? 30 : 0;
    const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

    // The time trigger is the only visible combobox whose current text
    // matches HH:MM. (Party trigger shows a bare digit; date trigger
    // uses a different DOM pattern.)
    const trigger = page
      .locator('[role="combobox"][aria-haspopup="listbox"]')
      .filter({ hasText: /^\d{1,2}:\d{2}$/ })
      .first();
    await trigger.click({ timeout: 3000 });

    const listbox = page.locator('ul[aria-label="Select reservation time"]');
    await listbox.waitFor({ state: 'visible', timeout: 2000 });

    await listbox.locator(`[data-value="${hhmm}"]`).first().click({ timeout: 3000 });
    // Slot list refreshes client-side after the time change; give it a
    // moment to settle before the outer scrape reads data-bts.
    await page.waitForTimeout(POST_CLICK_MS);
  } catch {
    /* leave default */
  }
}

/**
 * Pick the party-size dropdown.
 *
 * Reserve's MDC Mat-Select widget structure is:
 *
 *   <div class="wSASue">          ← visible trigger (click target)
 *     <ul aria-label="Select party size" role="listbox" HIDDEN>
 *       <li role="option" data-value="2">2</li>
 *       <li role="option" data-value="3">3</li>
 *       <li role="option" data-value="4">4</li>
 *       …
 *     </ul>
 *   </div>
 *
 * The listbox carries the only stable identifier (aria-label) but is
 * `display: none` until the wrapper is clicked. Earlier code tried to
 * click `[aria-label*="party size" i]` directly — that resolved to the
 * hidden listbox; Playwright's auto-wait for visibility then timed out,
 * the surrounding try/catch swallowed the error, and the function
 * silently returned with party-size unchanged.
 *
 * Net effect of that bug: every search was scraping slots for the
 * default party-of-2 list. Restaurants like ZZURA, whose party-4 slot
 * set is wider (17:00 onwards) than their party-2 set (18:30 onwards),
 * came back missing exactly the early-evening slots the user wanted.
 *
 * Fix: anchor on the hidden listbox (stable aria-label), walk up to
 * its first visible ancestor, click that to open the dropdown, then
 * click the option by `data-value` — which is locale-independent
 * (won't break if Reserve ever localises option text).
 */
/**
 * Pick the party-size dropdown.
 *
 * Reserve's party widget is an MDC Mat-Select. The DOM:
 *
 *   <div role="combobox" aria-haspopup="listbox">2</div>    ← visible trigger
 *   <ul aria-label="Select party size" role="listbox" HIDDEN>
 *     <li role="option" data-value="2">2</li>
 *     <li role="option" data-value="3">3</li>
 *     <li role="option" data-value="4">4</li>
 *     …
 *
 * Two non-obvious gotchas, both burned earlier attempts:
 *
 *   1. The listbox is the only element with a stable aria-label, but it
 *      is `display:none` until opened. A naive `[aria-label*="party"]`
 *      locator resolves to the hidden listbox, then Playwright's
 *      auto-wait-for-visibility times out and the surrounding try/catch
 *      swallows it. The dropdown is never opened, party stays at 2,
 *      and the slot scrape silently uses the default-party slot list.
 *
 *   2. MDC widgets listen for native pointer events (mousedown / focus),
 *      not synthetic `HTMLElement.click()`. A `page.evaluate(() => el.click())`
 *      on the trigger fires `click` but doesn't trigger MDC's open. Must
 *      use Playwright's `locator.click()` which simulates real mouse
 *      events including the mousedown MDC actually subscribes to.
 *
 * Identification trick: the party trigger is the only visible
 * `[role="combobox"][aria-haspopup="listbox"]` whose current text is a
 * bare digit 1–9 (it shows the currently-selected size). The time
 * combobox shows "HH:MM"; the date combobox uses a different pattern.
 *
 * Why this matters for accuracy: restaurants stage their availability
 * by party size. ZZURA has 9 party-of-2 slots tomorrow (18:30–20:30)
 * but 9 party-of-4 slots (17:00–19:00, partially overlapping). A user
 * asking "table for 4 at 18:00" with the old broken party path got
 * back the party-of-2 list, with no 18:00 slot, and the closest match
 * (18:30) labelled confirmed — confidently wrong.
 */
async function selectPartySize(page: Page, size: number): Promise<void> {
  try {
    const trigger = page
      .locator('[role="combobox"][aria-haspopup="listbox"]')
      .filter({ hasText: /^[1-9]$/ })
      .first();
    await trigger.click({ timeout: 3000 });

    // Wait for the listbox to actually paint.
    const listbox = page.locator('ul[aria-label="Select party size"]');
    await listbox.waitFor({ state: 'visible', timeout: 2000 });

    // Click the option by `data-value` — locale-independent, won't
    // break if Reserve ever localises option text.
    await listbox.locator(`[data-value="${size}"]`).first().click({ timeout: 3000 });
    await page.waitForTimeout(POST_CLICK_MS);
  } catch {
    /* leave at default of 2 */
  }
}

/* ─────────── Step 1: scrape the Maps place page (URL + price) ─────────── */

/**
 * Single Playwright visit to the Maps place page that pulls:
 *   - The Reserve "table" anchor href (Google's universal booking URL)
 *   - The price-range tier, read from the "Price range histogram" widget
 *     (or its short summary like "$100–350" / "$500+ per person")
 *
 * Returns `{ bookingUrl: null, priceTier: 0 }` on any failure so callers
 * can fall through to their next-best source.
 */
async function doFetchMapsData(placeId: string): Promise<MapsData> {
  await acquire();
  let ctx: BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    ctx = await newGoogleContext(browser);
    const page = await ctx.newPage();
    const url = `https://www.google.com/maps/place/?q=place_id:${placeId}`;
    await page.goto(url, { waitUntil: 'commit', timeout: PAGE_TIMEOUT_MS });
    // Wait for either signal we care about to render:
    //   - the "Reserve a table" anchor (so we can read its href), OR
    //   - the price-range histogram / summary (so we can read the tier).
    // Whichever lands first ends the wait. A place with neither — e.g. a
    // dai pai dong with no price data and no booking — will time out at
    // 6 s and we'll fall through with `{bookingUrl: null, priceTier: 0}`,
    // which is the correct degraded result anyway.
    await page
      .waitForSelector('a[href*="/maps/reserve/v/"], [aria-label*="Price range" i]', {
        timeout: HYDRATION_TIMEOUT_MS,
      })
      .catch(() => undefined);
    // After the first signal lands, poll for the Reserve anchor
    // specifically for up to 8 s more.
    //
    // 8 s (was 4 s) because measurements showed that on heavy-traffic
    // pages (Pici Central, ~10 k reviews) under our parallel load the
    // Reserve anchor can take 5–7 s to inject — Google fetches the
    // partner info async and the 4 s ceiling was clipping that. With
    // Google Reserve demoted to SECONDARY behind OpenRice's HTTP API,
    // we only reach this code for restaurants OpenRice doesn't cover,
    // so the larger ceiling rarely fires in practice; it just makes
    // the fallback path more reliable when we do hit it.
    //
    // If the anchor is already there, this resolves instantly — pay
    // no penalty on fast pages. Worst case (anchor never comes) we
    // wait the full 8 s.
    await page
      .waitForSelector('a[href*="/maps/reserve/v/"]', { timeout: 8000 })
      .catch(() => undefined);

    const scraped = await page.evaluate(() => {
      // Booking URL — the Google Reserve anchor.
      let reserveHref: string | null = null;
      for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        if (/\/maps\/reserve\/v\//.test(a.href || '')) {
          reserveHref = a.href;
          break;
        }
      }
      // Price — prefer the histogram (full distribution); fall back to
      // the inline summary text. We return the *text* of whichever we
      // find; tier mapping happens in TS so it's testable.
      //
      // Observed Google Maps shapes:
      //   Histogram aria-label "Price range histogram"
      //     + text       "$1–50$50–100$100–150"  (HKD ranges)
      //                  "$400–450$450–500$500+" (capped at $500+ in HK)
      //                  "$10–20$20–30$30–40"    (USD for US places)
      //   Inline summary "$10–20"  "$100–350"
      //   "Per person"   "$50–100 per person"  "$500+ per person"
      //   Open-ended     "·$500+"
      //   Word label     "Inexpensive"  "Moderate"  "Expensive"  "Very Expensive"
      let priceText: string | null = null;
      const hist = document.querySelector('[aria-label*="Price range" i]');
      if (hist) {
        priceText = (hist.getAttribute('aria-label') || '') + ' ' + (hist.textContent || '');
      } else {
        const body = document.body.innerText;
        // Try numeric patterns first; fall back to word labels.
        const r =
          body.match(/\$\d[\d,]*\+\s*per person/i) ||
          body.match(/\$\d[\d,]*[–\-—]\$?\d[\d,]*\s*per person/i) ||
          body.match(/\$\d[\d,]*[–\-—]\$?\d[\d,]*/) ||
          body.match(/[·•]\s*\$\d[\d,]*\+/) ||
          // Word label — must be surrounded by separators to avoid
          // matching a review sentence like "the food is moderate".
          body.match(/[·•]\s*(Very Expensive|Expensive|Moderate|Inexpensive)\b/);
        if (r) priceText = r[0];
      }
      return { reserveHref, priceText };
    });

    return {
      bookingUrl: scraped.reserveHref,
      priceTier: priceTierFromText(scraped.priceText),
    };
  } catch {
    return { bookingUrl: null, priceTier: 0 };
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
    release();
  }
}

/**
 * Map a Google Maps price string to our 0–6 PriceTier (OpenRice scale).
 *
 * Every format Google Maps surfaces, with examples:
 *
 *   Range w/ midpoint                    → tier from midpoint
 *     "$50–100 per person"               → mid 75   → 2 ($51-100)
 *     "$100–350"                         → mid 225  → 4 ($201-400)
 *     histogram "$1–50$50–100$100–150"   → mid ≈75  → 2
 *
 *   Open-ended ("$N+") — we bias UP one tier vs the lower-bound rule
 *   because Google caps HK histograms at $500+ so genuine tier-6
 *   restaurants look identical to tier-5 ones in the raw bucket text.
 *     "·$500+ per person"                → 5  (could be 6; we round up)
 *     "·$100+ per person" (USD)          → 3
 *
 *   Word labels (rare; only when user-report data is thin)
 *     "Inexpensive"  → 1
 *     "Moderate"     → 3
 *     "Expensive"    → 4
 *     "Very Expensive" → 6
 *
 * Currency assumption: Google reports prices in the LOCAL currency for
 * the place. For HK places that's HKD, which maps directly onto the
 * OpenRice tier ladder. The few US/EU restaurants that show in HK
 * queries (rare) will be undervalued — acceptable.
 */
function priceTierFromText(text: string | null): PriceTier {
  if (!text) return 0;

  // Word labels first — use `\b` so "Inexpensive" doesn't also match
  // "Expensive". Check more-specific ones first.
  if (/\bvery expensive\b/i.test(text)) return 6;
  if (/\binexpensive\b/i.test(text)) return 1;
  if (/\bexpensive\b/i.test(text)) return 4;
  if (/\bmoderate\b/i.test(text)) return 3;

  // Strip commas inside numbers ("$1,500" → "$1500") so the int parse
  // doesn't split a single price into two separate digits.
  const clean = text.replace(/(\$\d{1,3}(?:,\d{3})+)/g, (m) => m.replace(/,/g, ''));

  // Each dollar token may be a range "$50–100" or a single value "$500".
  // We need BOTH ends of any range — Google's histogram texts are bucket
  // boundaries like "$1–50$50–100", so the actual upper bound only
  // appears AFTER the en-dash.
  const matches = [...clean.matchAll(/\$(\d+)(?:[–\-—](\d+))?/g)];
  const nums = matches.flatMap((m) =>
    m[2] ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [parseInt(m[1], 10)]
  );
  if (nums.length === 0) return 0;

  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  // "+" anywhere in the relevant range portion means an open upper bound.
  const isOpenEnded = /\$\d[\d,]*\+/.test(clean);

  // For open-ended values, treat the cap as the LOW edge of the next
  // bucket up — Google's "$500+" really means "we don't know, could be
  // way more". Closed ranges use the midpoint.
  const point = isOpenEnded ? Math.max(hi, lo) * 1.25 : Math.round((lo + hi) / 2);

  if (point <= 50) return 1;
  if (point <= 100) return 2;
  if (point <= 200) return 3;
  if (point <= 400) return 4;
  if (point <= 800) return 5;
  return 6;
}

/* ─────────── Step 2: parse time slots from HTML ─────────── */

/**
 * The Reserve page embeds slot data as `data-bts="<unix_seconds>"` on
 * each <li> in the time picker. After Playwright drives the date picker
 * to the user's requested day, the DOM updates client-side and the
 * `data-bts` attributes reflect that day's slot times.
 *
 * Behaviour:
 *   - `dateMatched` true + slots within ±SLOT_WINDOW_MIN of target →
 *     confirmed slots (green pills).
 *   - `dateMatched` true + no slots near target time → same-day-other-time
 *     slots flagged `nextAvailableTime` (banner: "Other times on <date>").
 *     Happens often on Google Reserve because the page defaults to the
 *     restaurant's earliest service of the day (e.g. lunch) and doesn't
 *     accept a time parameter — so a dinner request lands on lunch slots.
 *   - `dateMatched` false → page is on a different date entirely; flag
 *     `nextAvailableDate` (banner: "Earliest open: <date>").
 */
function parseSlotsFromHtml(
  html: string,
  isoTarget: string,
  bookingUrl: string,
  dateMatched: boolean
): TimeSlot[] {
  const targetMs = new Date(isoTarget).getTime();
  const windowMs = SLOT_WINDOW_MIN * 60_000;

  const seen = new Set<number>();
  const allSlots: number[] = [];
  const re = /data-bts="(\d{10})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const ms = parseInt(m[1], 10) * 1000;
    if (seen.has(ms)) continue;
    seen.add(ms);
    allSlots.push(ms);
  }
  if (allSlots.length === 0) return [];

  allSlots.sort((a, b) => a - b);
  const inWindow = allSlots.filter((ms) => Math.abs(ms - targetMs) <= windowMs);

  // CASE A — perfect match: right date AND slots near requested time.
  if (dateMatched && inWindow.length > 0) {
    return inWindow.slice(0, 5).map((ms) => ({
      time: new Date(ms).toISOString(),
      available: true,
      bookingUrl,
    }));
  }

  // No nearby slots. Distinguish "same date, wrong service" from
  // "wrong date entirely" by comparing the slot calendar day to the
  // requested calendar day in HK time.
  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const targetDay = dayFmt.format(targetMs);
  const slotDay = dayFmt.format(allSlots[0]);
  const sameDay = dateMatched && targetDay === slotDay;

  return allSlots.slice(0, 5).map((ms) => ({
    time: new Date(ms).toISOString(),
    available: true,
    bookingUrl,
    // CASE B (sameDay=true): right date, wrong time of day.
    // CASE C (sameDay=false): wrong date entirely.
    ...(sameDay ? { nextAvailableTime: true } : { nextAvailableDate: true }),
  }));
}
