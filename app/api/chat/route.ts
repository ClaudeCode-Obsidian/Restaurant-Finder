/**
 * POST /api/chat
 *
 * Takes the user's free-text message from the landing-page chatbox and
 * converts it into a structured SearchQuery + redirect URL.
 *
 * We split "parse query" from "fetch restaurants" so the chat endpoint
 * returns instantly (just a Claude call), the browser navigates to /search,
 * and the heavier restaurant fetch is its own request (better UX — the user
 * sees a results-page skeleton immediately).
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseQuery } from '@/lib/claude';

export async function POST(req: NextRequest) {
  let body: { message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const message = (body.message ?? '').trim();
  if (!message) return NextResponse.json({ error: 'Empty message' }, { status: 400 });

  const query = await parseQuery(message);

  const params = new URLSearchParams({
    q: query.text,
    dateTime: query.dateTime ?? '',
    partySize: String(query.partySize ?? 2),
  });

  return NextResponse.json({
    searchUrl: `/search?${params.toString()}`,
    query,
  });
}
