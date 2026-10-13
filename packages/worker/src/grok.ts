// Grok (xAI) on the cards and alerts (owner 2026-10-13: "I'm sure he can be useful somehow"; the owner picked three
// jobs). Grok can search X and the web (xAI Responses API with the x_search and web_search tools), which Sonnet can't:
// - context(): per card coin at each 4H close, what X is saying (lean + one sentence), scheduled events in the next 48h,
//   and breaking news of the last few hours (the card's "X / news" line, Sonnet's read, and the breaking-news alerts);
// - why(): on a signal's entry alert, a one-sentence news check on that coin ("why is it moving");
// - trader(): the price levels a followed X trader posted for the card coins (owner: "Let it follow mrcrypt0krabs and
//   pass along levels from his analysis, but just label him a community trader number 1"). X search is limited to his
//   posts; only numbers, his bias and the post time come back, so his handle never reaches Telegram.
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
export type LevelKind = 'support' | 'resistance' | 'target' | 'entry' | 'stop' | 'level';
/** One coin's levels from a followed trader's latest post on it. */
export interface TraderLevels { coin: string; bias: 'long' | 'short' | 'neutral' | null; levels: { price: number; kind: LevelKind }[]; posted: number }
export interface Grok {
  context(coin: string, at: number): Promise<GrokContext | null>;
  why(symbol: string, side: 'long' | 'short', at: number): Promise<string | null>;
  /** Levels the X account `handle` posted in the last 3 days for these coins (current prices for a sanity check). */
  trader(handle: string, coins: { coin: string; price: number }[], at: number): Promise<TraderLevels[] | null>;
}

/** The X traders the cards follow, in order: #1, #2, ... (GROK_TRADERS in Railway overrides; handles without @). */
export const COMMUNITY_TRADERS = ['mrcrypt0krabs'];
export const traderLabel = (k: number) => `Community trader #${k + 1}`;

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

export function traderPrompt(handle: string, coins: string[]): string {
  const list = coins.map(base);
  return [
    `Search only the X posts of @${handle} from the last 3 days. For each of ${list.join(' and ')}, take his most recent post that gives price levels for it.`,
    `Return {"coins": [{"coin": ${list.map((c) => `"${c}"`).join(' | ')}, "bias": "long" | "short" | "neutral", "levels": [{"price": number, "kind": "support" | "resistance" | "target" | "entry" | "stop" | "level"}], "posted": "YYYY-MM-DDTHH:MMZ"}]}.`,
    'Only levels he wrote himself, never levels you work out; leave a coin out if he gave none. Prices as plain numbers (2400, not 2.4k).',
  ].join('\n');
}

const KINDS: LevelKind[] = ['support', 'resistance', 'target', 'entry', 'stop', 'level'];
/** The checked levels: known coins, a post from the last 4 days, prices within half to one and a half times the price. */
export function parseTrader(j: Record<string, unknown> | null, sources: number, coins: { coin: string; price: number }[], at: number): TraderLevels[] | null {
  if (!j || sources < 1 || !Array.isArray(j.coins)) return null;
  const out: TraderLevels[] = [];
  for (const raw of j.coins as Record<string, unknown>[]) {
    const want = coins.find((c) => base(c.coin) === String(raw?.coin ?? '').toUpperCase().replace(/USDT$/, ''));
    const posted = Date.parse(String(raw?.posted ?? ''));
    if (!want || out.some((o) => o.coin === want.coin) || !Number.isFinite(posted) || posted > at + 600_000 || at - posted > 4 * 86_400_000) continue;
    const levels = (Array.isArray(raw.levels) ? raw.levels as Record<string, unknown>[] : []).map((l) => ({ price: Number(l?.price), kind: KINDS.includes(l?.kind as LevelKind) ? l.kind as LevelKind : 'level' as LevelKind }))
      .filter((l, k, all) => Number.isFinite(l.price) && l.price >= want.price * 0.5 && l.price <= want.price * 1.5 && all.findIndex((m) => m.price === l.price) === k).slice(0, 8);
    if (!levels.length) continue;
    const bias = raw.bias === 'long' || raw.bias === 'short' || raw.bias === 'neutral' ? raw.bias : null;
    out.push({ coin: want.coin, bias, levels, posted });
  }
  return out;
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

  // The X search window: from the day before up to (not including) the day after.
  const allSearch = (at: number) => [{ type: 'x_search', from_date: ymd(at - 86_400_000), to_date: ymd(at + 86_400_000) }, { type: 'web_search' }];
  async function call(job: string, prompt: string, at: number, tools: object[] = allSearch(at)): Promise<{ j: Record<string, unknown> | null; sources: number } | null> {
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
          tools,
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
    async trader(handle, coins, at) {
      if (!coins.length) return null;
      const tools = [{ type: 'x_search', allowed_x_handles: [handle.replace(/^@/, '')], from_date: ymd(at - 3 * 86_400_000), to_date: ymd(at + 86_400_000) }];
      const r = await call('community trader', traderPrompt(handle.replace(/^@/, ''), coins.map((c) => c.coin)), at, tools);
      return r ? parseTrader(r.j, r.sources, coins, at) : null;
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

const KIND_TAG: Record<LevelKind, string> = { resistance: 'R', support: 'S', target: 'T', entry: 'E', stop: 'SL', level: 'L' };
const px = (x: number) => (x >= 100 ? x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : String(Number(x.toPrecision(5))));
/** "Community trader #1: bias short · R 2,550.0 · S 2,400.0 (posted 10-12 18:00 UTC)" (plain text; the card escapes it). */
export function traderLine(label: string, t: TraderLevels): string {
  const order: LevelKind[] = ['resistance', 'target', 'entry', 'level', 'support', 'stop'];
  const lv = [...t.levels].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.price - a.price).map((l) => `${KIND_TAG[l.kind]} ${px(l.price)}`);
  return `${label}: ${t.bias ? `bias ${t.bias} · ` : ''}${lv.join(' · ')} (posted ${iso(t.posted).slice(5)})`;
}
