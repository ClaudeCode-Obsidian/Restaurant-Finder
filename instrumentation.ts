/**
 * Next.js instrumentation hook — runs ONCE per server process at startup,
 * before any route handler executes.
 *
 * Why this exists: on networks without a working IPv6 path to Google,
 * Node's built-in fetch (undici) resolves hosts like `places.googleapis.com`
 * to BOTH IPv4 and IPv6 addresses, attaches to the unreachable IPv6 ones,
 * and fails to fail over to IPv4 fast enough — every Places API call then
 * dies with `ETIMEDOUT` and the /api/restaurants route 500s before it can
 * stream anything. (curl works because it does proper Happy-Eyeballs and
 * falls back to IPv4.)
 *
 * Forcing undici's global dispatcher to `family: 4` makes every server-side
 * fetch use IPv4 only, which is reachable. This is a no-op on machines that
 * do have IPv6 connectivity, so it's safe to leave on everywhere.
 *
 * Scoped to the Node.js runtime — the Edge runtime has no undici Agent and
 * doesn't hit this code path.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { setGlobalDispatcher, Agent } = await import('undici');
    setGlobalDispatcher(new Agent({ connect: { family: 4 } }));
  }
}
