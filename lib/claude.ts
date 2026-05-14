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
import type { PriceTier, Restaurant, SearchQuery } from './types';

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

export interface DescribeResult {
  description: string;
  /**
   * Best-effort estimate of HK price tier (OpenRice scale 0–6) based on the
   * restaurant's name, cuisine, rating, and any editorial summary. 0 = unsure.
   * Used as fallback when OpenRice scraping and Google's priceLevel both fail.
   */
  estimatedPriceTier: PriceTier;
}

/**
 * Generate the 3-part description (formality, ambience, specialties) AND a
 * best-effort price-tier estimate, in a single Claude call.
 *
 * Bundling means we only pay for one round-trip per restaurant. The model is
 * asked to ground both outputs in the inputs and to return 0 for price when
 * it has no signal — never to invent a number.
 */
export async function describeRestaurant(input: DescribeInput): Promise<DescribeResult> {
  try {
    const msg = await client().messages.create({
      model: MODEL,
      max_tokens: 260,
      system:
        'You write concise restaurant blurbs AND estimate HK price tiers. ' +
        'Return ONLY a JSON object — no prose, no markdown fences — with keys:\n' +
        '  description (string): EXACTLY one paragraph, 2–3 short sentences, in order: ' +
        '(1) formality (casual / upscale / fine dining), ' +
        '(2) ambience & decor in 4–8 words, ' +
        '(3) signature specialties or dish category. ' +
        'Use ONLY the grounding provided; do not invent dish names.\n' +
        '  estimatedPriceTier (integer 1–6, NOT 0): typical dinner price per person in HKD. ' +
        '1=Under $50, 2=$51-100, 3=$101-200, 4=$201-400, 5=$401-800, 6=Over $801. ' +
        'Algorithm: ' +
        '(a) If you recognize the specific restaurant, use that knowledge. ' +
        '(b) Else default by cuisine in HK: ' +
        'fast-food/noodle shop = 1; cha chaan teng / casual local = 2; ' +
        'mid-range Japanese / Italian / Western = 3; upscale Japanese / steakhouse = 4; ' +
        'fine dining / omakase / Michelin = 5–6. ' +
        '(c) Adjust UP one tier if rating > 4.7 (likely upscale niche). ' +
        '(d) Adjust UP one tier if name suggests omakase, kaiseki, Michelin, or chef-led. ' +
        'You MUST output 1–6; never 0. When uncertain, pick the cuisine default in (b).',
      messages: [{ role: 'user', content: JSON.stringify(input) }],
    });
    const raw = textOf(msg).trim();
    return safeParseDescribe(raw, input);
  } catch {
    return { description: fallbackBlurb(input), estimatedPriceTier: 0 };
  }
}

function safeParseDescribe(raw: string, input: DescribeInput): DescribeResult {
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const obj = JSON.parse(cleaned) as Partial<DescribeResult>;
    const tier = Number(obj.estimatedPriceTier);
    return {
      description: typeof obj.description === 'string' && obj.description
        ? obj.description
        : fallbackBlurb(input),
      estimatedPriceTier: tier >= 0 && tier <= 6 ? (tier as PriceTier) : 0,
    };
  } catch {
    return { description: fallbackBlurb(input), estimatedPriceTier: 0 };
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
