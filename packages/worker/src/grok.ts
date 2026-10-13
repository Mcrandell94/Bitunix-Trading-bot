// Grok (xAI) on the cards and alerts (owner 2026-10-13: "I'm sure he can be useful somehow"; the owner picked three
// jobs). Grok can search X and the web (xAI Responses API with the x_search and web_search tools), which Sonnet can't:
// - context(): per card coin at each 4H close, what X is saying (lean + one sentence), scheduled events in the next 48h,
//   and breaking news of the last few hours (the card's "X / news" line, Sonnet's read, and the breaking-news alerts);
// - why(): on a signal's entry alert, a one-sentence news check on that coin ("why is it moving").
// DISPLAY ONLY: Grok sees a coin name and the time, nothing from the account. Its answers are posts and pages from the
// internet, so they are shown as unverified, stripped of tags, links and line breaks, cut short, and dropped when no
// source backs them. XAI_API_KEY comes from the Railway variables, never the repository. A failed call, a timeout or the
// daily cap only leaves the line out: Grok never holds a card or an alert back. Every call logs its usage, so the cost
// can be read from the logs (X search is billed per post fetched).

import type { Logger } from './log';

export const GROK = {
  url: 'https://api.x.ai/v1/responses', model: 'grok-4.7', timeoutMs: 60_000, maxOutputTokens: 1500,
  /** Calls a UTC day (XAI_DAILY_CALLS overrides); the cards take 12. */
  dailyCap: 40,
  /** Breaking news older than this at the call is dropped. */
  breakingMaxAgeMs: 6 * 3_600_000,
} as const;

export type Lean = 'bullish' | 'bearish' | 'mixed' | 'quiet';
export interface GrokContext {
  lean: Lean; chatter: string;
  events: { when: string; what: string }[];
  breaking: { headline: string; url: string | null; at: number }[];
  /** Sources the answer cites (0 = no search backed it; such answers are dropped). */
  sources: number;
}
export interface Grok {
  context(coin: string, at: number): Promise<GrokContext | null>;
  why(symbol: string, side: 'long' | 'short', at: number): Promise<string | null>;
}

const NAMES: Record<string, string> = { BTC: 'Bitcoin', ETH: 'Ethereum' };
const base = (symbol: string) => symbol.replace(/USDT$/, '');
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const iso = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** Plain text from the internet: no tags, links, handles' markup or line breaks, at most `max` characters. */
export function clean(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  const t = s.replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
const httpUrl = (s: unknown) => (typeof s === 'string' && /^https?:\/\/[^\s<>"]+$/.test(s.trim()) ? s.trim() : null);

/** The text and the number of cited sources of a Responses API reply (output_text, url_citation annotations, citations). */
export function replyText(data: unknown): { text: string; sources: number } {
  const d = (data ?? {}) as { output_text?: unknown; output?: unknown; citations?: unknown };
  const parts: string[] = [];
  let notes = 0;
  if (Array.isArray(d.output)) {
    for (const item of d.output as { type?: string; content?: unknown }[]) {
      if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const c of item.content as { type?: string; text?: unknown; annotations?: unknown }[]) {
        if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
        if (Array.isArray(c?.annotations)) notes += (c.annotations as { type?: string }[]).filter((a) => a?.type === 'url_citation').length;
      }
    }
  }
  const text = parts.length ? parts.join('\n') : typeof d.output_text === 'string' ? d.output_text : '';
  return { text, sources: Math.max(notes, Array.isArray(d.citations) ? d.citations.length : 0) };
}

/** The first JSON object in a reply (models sometimes wrap it in a code fence), or null. */
export function jsonIn(text: string): Record<string, unknown> | null {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(text.slice(a, b + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

const SYSTEM = [
  'You scan X and the web for a crypto trading group.',
  'Always search before answering, and report only what your search results show: never invent posts, numbers, dates or events.',
  'Give no advice and no price predictions.',
  'Answer with one JSON object and nothing else.',
].join(' ');

export function contextPrompt(coin: string, at: number): string {
  const b = base(coin), name = NAMES[b] ? `${NAMES[b]} (${b})` : b;
  return [
    `Coin: ${name}. Time now: ${iso(at)}.`,
    'Return {"lean": "bullish" | "bearish" | "mixed" | "quiet", "chatter": string, "events": [...], "breaking": [...]} where:',
    `- lean and chatter: what traders on X have said about ${b} in the last 24 hours; chatter is one plain sentence under 200 characters naming the main themes, with no links or @handles.`,
    `- events: up to 3 scheduled events in the next 48 hours that can move ${b} (US macro data such as CPI or FOMC, token unlocks, network upgrades, ETF decisions), each {"when": "YYYY-MM-DD HH:MM UTC" or "YYYY-MM-DD", "what": under 80 characters}; [] if none found.`,
    `- breaking: up to 2 major news items published in the last 4 hours that could move ${b} sharply (hacks or exploits, large ETF flows, regulation, exchange outages, liquidation cascades), each {"headline": under 120 characters, "published": "YYYY-MM-DDTHH:MMZ", "url": the source link}; [] if none. Leave out routine price commentary.`,
  ].join('\n');
}

export function whyPrompt(symbol: string, side: 'long' | 'short', at: number): string {
  const b = base(symbol);
  return [
    `${b} (perpetual ${symbol}) just gave a ${side} signal from price action at ${iso(at)}.`,
    `Search X and news for the last 24 hours. In one plain sentence under 220 characters, say whether news or X chatter explains a move in ${b} (listing or delisting, token unlock, hack, partnership, rumour, whale moves), and name the kind of source (X posts or a news site). If nothing relevant turns up, the note is exactly "nothing notable found".`,
    'Return {"note": string}.',
  ].join('\n');
}

const LEANS: Lean[] = ['bullish', 'bearish', 'mixed', 'quiet'];

/** The checked context from a parsed reply, or null when it is unusable. Breaking items need a recent time. */
export function parseContext(j: Record<string, unknown> | null, sources: number, at: number): GrokContext | null {
  if (!j || sources < 1) return null;
  const lean = LEANS.includes(j.lean as Lean) ? (j.lean as Lean) : 'mixed', chatter = clean(j.chatter, 200);
  const events = (Array.isArray(j.events) ? j.events : []).slice(0, 3).map((e) => ({ when: clean((e as Record<string, unknown>)?.when, 24), what: clean((e as Record<string, unknown>)?.what, 80) })).filter((e) => e.when && e.what);
  const breaking = (Array.isArray(j.breaking) ? j.breaking : []).slice(0, 2).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>, t = Date.parse(String(r.published ?? ''));
    return { headline: clean(r.headline, 120), url: httpUrl(r.url), at: t };
  }).filter((x) => x.headline && Number.isFinite(x.at) && x.at <= at + 600_000 && at - x.at <= GROK.breakingMaxAgeMs);
  if (!chatter && !events.length && !breaking.length) return null;
  return { lean, chatter, events, breaking, sources };
}

/** A Grok client with the key, or null without one. Every method returns null on any failure. */
export function grokClient(apiKey: string | null | undefined, log: Logger, opts: { model?: string; dailyCap?: number; fetchFn?: typeof fetch } = {}): Grok | null {
  if (!apiKey) return null;
  const key: string = apiKey;
  const fetchFn = opts.fetchFn ?? fetch, model = opts.model || GROK.model, cap = opts.dailyCap ?? GROK.dailyCap;
  let day = '', used = 0;
  const whyMemo = new Map<string, { at: number; note: string | null }>();

  async function call(job: string, prompt: string, at: number): Promise<{ j: Record<string, unknown> | null; sources: number } | null> {
    const today = ymd(Date.now());
    if (today !== day) { day = today; used = 0; }
    if (used >= cap) { log.warn('grok: daily cap reached, line left out', { job, cap }); return null; }
    used++;
    const t0 = Date.now();
    try {
      const res = await fetchFn(GROK.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model, max_output_tokens: GROK.maxOutputTokens, store: false,
          input: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
          // The X search window: from the day before up to (not including) the day after.
          tools: [{ type: 'x_search', from_date: ymd(at - 86_400_000), to_date: ymd(at + 86_400_000) }, { type: 'web_search' }],
        }),
        signal: AbortSignal.timeout(GROK.timeoutMs),
      });
      const body = await res.text();
      if (!res.ok) { log.warn('grok: call failed (line left out)', { job, status: res.status, body: body.slice(0, 300).split(key).join('***') }); return null; }
      const data = JSON.parse(body) as { usage?: unknown; server_side_tool_usage?: unknown };
      const { text, sources } = replyText(data);
      log.info('grok: call', { job, model, ms: Date.now() - t0, sources, usage: data.usage ?? null, tools: data.server_side_tool_usage ?? null, callsToday: used });
      return { j: jsonIn(text), sources };
    } catch (err) {
      log.warn('grok: call failed (line left out)', { job, error: (err as Error).message.split(key).join('***') });
      return null;
    }
  }

  return {
    async context(coin, at) {
      const r = await call(`context ${coin}`, contextPrompt(coin, at), at);
      return r ? parseContext(r.j, r.sources, at) : null;
    },
    async why(symbol, side, at) {
      // One check a coin per 4 hours: several alerts on one coin share it.
      const m = whyMemo.get(symbol);
      if (m && at - m.at < 4 * 3_600_000) return m.note;
      const r = await call(`why ${symbol}`, whyPrompt(symbol, side, at), at);
      const note = r && r.sources >= 1 ? clean(r.j?.note, 220) || null : null;
      if (r) whyMemo.set(symbol, { at, note });
      return note;
    },
  };
}

/** The card's "X / news" section (plain text; the card escapes it). */
export function contextNote(c: GrokContext): { title: string; lines: string[] } {
  const lines: string[] = [];
  if (c.chatter) lines.push(`X lean ${c.lean}: ${c.chatter}`);
  if (c.events.length) lines.push(`Events: ${c.events.map((e) => `${e.when} ${e.what}`).join(' · ')}`);
  if (c.breaking.length) lines.push(`Breaking: ${c.breaking.map((b) => b.headline).join(' · ')}`);
  return { title: 'X / news (Grok · unverified · not advice)', lines };
}

/** One key per news item (its link, else its headline's words), so a story is alerted once however it is reworded. */
export const breakingKey = (coin: string, b: { headline: string; url: string | null }) =>
  `${coin}|grok|${b.url ?? b.headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60)}`;
