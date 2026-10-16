// The AI read on the ETH / BTC cards (owner 2026-10-13, cards v2: "Is it possible for an ai interpreted read to come from
// the data?"; model picked by the owner: Claude Haiku 5.5, then Claude Sonnet 5.5 on 2026-10-13 with "give a better
// idea of where short and long poi's sit"; cards v3 on 2026-10-16: "AI read on the POIs"). The model gets the card's own
// POI lines (aiInput in @bot/backtest coincard.ts) and nothing else: no account, orders or positions. It writes 2-3
// plain sentences that go at the top of the card, marked "not advice": where the strongest long and short POIs sit. ANTHROPIC_API_KEY
// comes from the Railway variables (or a GitHub Actions secret for the preview), never the repository. Without a key,
// or when a call fails or is refused, the card goes out without the read: the read never holds a card back.

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from './log';

export const AI_READ = { model: 'claude-sonnet-5-5', maxTokens: 2000, maxChars: 650, timeoutMs: 60_000 } as const;

export const AI_SYSTEM = [
  'You read a crypto card that lists points of interest (POIs): price zones where several chart scripts agree on the weekly, daily and 4H timeframes, short POIs above the price and long POIs below it, each with its distance from the price, how many different scripts back it and which ones. Write a short plain-English read of it for a trader.',
  'Write 2 or 3 short sentences, under 500 characters in all, as plain text: no markdown, no lists, no emojis, no headings.',
  'Say where the strongest long POI and the strongest short POI sit: the price range, the distance from the price, how many scripts back it and the main kinds (order blocks, FVGs, S/R, Fib, liquidity, levels). Say so when the price is within 1% of a POI or inside one, and when a side has none.',
  'If a Community traders section is given, you may add one short clause on whether their levels sit in a POI, calling them unverified; they never outweigh the POIs.',
  'Use only the data given and quote prices exactly as written. Do not predict prices and do not give advice: no buy or sell calls, entries, stops, targets or position sizes.',
].join(' ');

/** Cuts a long read at its last full sentence within `max` characters. Pure. */
export function clipRead(text: string, max: number = AI_READ.maxChars): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max), end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 0 ? cut.slice(0, end + 1) : `${cut.slice(0, max - 1).trimEnd()}…`;
}

export type AiReader = (input: string) => Promise<string | null>;

/** A reader with the key, or null without one. Each call returns the read, or null when it failed or was refused. */
export function aiReader(apiKey: string | null | undefined, log: Logger, fetchFn?: typeof fetch): AiReader | null {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: AI_READ.timeoutMs, ...(fetchFn ? { fetch: fetchFn } : {}) });
  return async (input) => {
    try {
      const r = await client.messages.create({
        model: AI_READ.model, max_tokens: AI_READ.maxTokens, system: AI_SYSTEM, output_config: { effort: 'low' },
        messages: [{ role: 'user', content: input }],
      });
      if (r.stop_reason === 'refusal') { log.warn('cards: AI read refused (card sent without it)'); return null; }
      const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
      // Cut off at max_tokens: keep the full sentences only.
      const read = clipRead(r.stop_reason === 'max_tokens' ? text.slice(0, Math.max(0, text.lastIndexOf('.') + 1)) : text);
      return read || null;
    } catch (err) {
      log.warn('cards: AI read failed (card sent without it)', { error: (err as Error).message.split(apiKey).join('***') });
      return null;
    }
  };
}
