/**
 * Claude AI agent — turns free-text user requests into structured search queries
 * AND writes the short descriptions ("casual/upscale + ambience + specialties")
 * once we have the raw restaurant data.
 *
 * Two distinct calls so we can cache/batch each independently:
 *   1. parseQuery()       — Natural language ➜ {textQuery, dateTime, partySize}
 *   2. describeRestaurant — Raw place data ➜ 2-3 sentence editorial.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Restaurant, SearchQuery } from './types';

const MODEL = 'claude-haiku-4-5-20251001';
// Haiku 4.5: fast, cheap, and plenty smart for parsing + short summaries.
// Switch to claude-sonnet-4-6 if you need higher-quality prose.

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  _client = new Anthropic({ apiKey });
  return _client;
}

/* ─────────── 1. Parse free-text query ─────────── */

export async function parseQuery(text: string): Promise<SearchQuery> {
  const today = new Date().toISOString().slice(0, 10);
  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 400,
    system:
      'You convert restaurant search requests into structured JSON. ' +
      `Today is ${today}. The user is in Hong Kong unless stated otherwise. ` +
      'Default partySize = 2 when not specified. Default dateTime = today 19:00 HKT. ' +
      'Respond with ONLY a JSON object — no prose, no markdown fences.',
    messages: [
      {
        role: 'user',
        content:
          `Parse this request and return JSON with keys:\n` +
          `  text         (string, what to search for, e.g. "romantic sushi Central Hong Kong")\n` +
          `  dateTime     (ISO 8601 string with +08:00 offset)\n` +
          `  partySize    (integer)\n\n` +
          `Request: """${text}"""`,
      },
    ],
  });
  const raw = textOf(msg);
  return safeParseQuery(raw, text);
}

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

function safeParseQuery(raw: string, fallbackText: string): SearchQuery {
  try {
    // Strip markdown fences if Claude adds them despite instructions.
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const obj = JSON.parse(cleaned) as Partial<SearchQuery>;
    return {
      text: obj.text ?? fallbackText,
      dateTime: obj.dateTime ?? defaultDateTime(),
      partySize: obj.partySize ?? 2,
    };
  } catch {
    return { text: fallbackText, dateTime: defaultDateTime(), partySize: 2 };
  }
}

function defaultDateTime(): string {
  const d = new Date();
  d.setHours(19, 0, 0, 0);
  return d.toISOString();
}

/* ─────────── 2. Describe restaurant ─────────── */

export interface DescribeInput {
  name: string;
  rating: number;
  priceLabel: string;
  cuisine?: string;
  editorial?: string; // Google's own "editorialSummary" if present
}

/**
 * Generate the 3-part description: formality, ambience, specialties.
 * We pass whatever Google gives us (rating, price tier, primary type) as
 * grounding so Claude doesn't hallucinate. If data is thin, the output is
 * conservative ("a [cuisine] restaurant in [area]") rather than invented.
 */
export async function describeRestaurant(input: DescribeInput): Promise<string> {
  try {
    const msg = await client().messages.create({
      model: MODEL,
      max_tokens: 180,
      system:
        'You write concise restaurant blurbs. EXACTLY one paragraph, ' +
        '2–3 short sentences total, covering in order: ' +
        '(1) formality — pick one of: casual / upscale / fine dining, ' +
        '(2) ambience & decor in 4–8 words, ' +
        '(3) signature specialties or dish category. ' +
        'Use only the grounding provided. If unsure, stay general. ' +
        'Do not invent specific dish names you were not given.',
      messages: [
        {
          role: 'user',
          content: JSON.stringify(input),
        },
      ],
    });
    return textOf(msg).trim() || fallbackBlurb(input);
  } catch {
    return fallbackBlurb(input);
  }
}

function fallbackBlurb(i: DescribeInput): string {
  const tier =
    i.priceLabel.includes('Over') || i.priceLabel.includes('401')
      ? 'upscale'
      : i.priceLabel.includes('Under') || i.priceLabel.includes('51')
      ? 'casual'
      : 'mid-range';
  return `A ${tier} ${i.cuisine?.toLowerCase() ?? 'restaurant'} popular with locals.`;
}
