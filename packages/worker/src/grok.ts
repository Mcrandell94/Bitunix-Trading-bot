// Grok (xAI): the community traders on the ETH / BTC cards, and nothing else (owner 2026-10-13: "Let's house grok
// function strictly around the community traders 1 and 2 and nothing else"; the X chatter, events, breaking-news alerts
// and the news check on signal entries were dropped the same day, after the first live calls cost about $0.2-0.3 each).
// trader(): the price levels a followed X trader posted for the card coins (owner: "Let it follow mrcrypt0krabs and pass
// along levels from his analysis, but just label him a community trader number 1"; #2 CryptoNavi399). X search is
// limited to that trader's posts; only numbers, the bias and the post time come back, so no handle reaches Telegram.
// DISPLAY ONLY: Grok sees the handle, the coin names, their prices and the time, nothing from the account. Its answers
// are dropped when no source backs them. XAI_API_KEY comes from the Railway variables, never the repository. A failed
// call, a timeout or the daily cap only leaves the line out: Grok never holds a card back. Every call logs its usage
// (cost_in_usd_ticks: 10^10 ticks = $1), so the cost can be read from the logs.

import type { Logger } from './log';

export const GROK = {
  /** 2 minutes (owner 2026-10-13: "Raise the time limit"): at 60 s two of the first three live calls timed out. */
  url: 'https://api.x.ai/v1/responses', model: 'grok-4.7', timeoutMs: 120_000, maxOutputTokens: 1500,
  /** Calls a UTC day (XAI_DAILY_CALLS overrides); the cards take 12 (2 traders x 6 closes). */
  dailyCap: 40,
} as const;

export type LevelKind = 'support' | 'resistance' | 'target' | 'entry' | 'stop' | 'level';
/** One coin's levels from a followed trader's latest post on it. */
export interface TraderLevels { coin: string; bias: 'long' | 'short' | 'neutral' | null; levels: { price: number; kind: LevelKind }[]; posted: number }
export interface Grok {
  /** Levels the X account `handle` posted in the last 3 days for these coins (current prices for a sanity check). */
  trader(handle: string, coins: { coin: string; price: number }[], at: number): Promise<TraderLevels[] | null>;
}

/** The X traders the cards follow, in order: #1, #2, ... (GROK_TRADERS in Railway overrides; handles without @). */
export const COMMUNITY_TRADERS = ['mrcrypt0krabs', 'CryptoNavi399'];
export const traderLabel = (k: number) => `Community trader #${k + 1}`;

const base = (symbol: string) => symbol.replace(/USDT$/, '');
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const iso = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

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
  'You read X posts for a crypto trading group.',
  'Always search before answering, and report only what your search results show: never invent posts, numbers, dates or events.',
  'Give no advice and no price predictions.',
  'Answer with one JSON object and nothing else.',
].join(' ');

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

/** A Grok client with the key, or null without one. Every method returns null on any failure. */
export function grokClient(apiKey: string | null | undefined, log: Logger, opts: { model?: string; dailyCap?: number; fetchFn?: typeof fetch } = {}): Grok | null {
  if (!apiKey) return null;
  const key: string = apiKey;
  const fetchFn = opts.fetchFn ?? fetch, model = opts.model || GROK.model, cap = opts.dailyCap ?? GROK.dailyCap;
  let day = '', used = 0;

  async function call(job: string, prompt: string, tools: object[]): Promise<{ j: Record<string, unknown> | null; sources: number } | null> {
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
    async trader(handle, coins, at) {
      if (!coins.length) return null;
      const h = handle.replace(/^@/, '');
      // X search on this trader's posts only, from 3 days back up to (not including) the day after.
      const tools = [{ type: 'x_search', allowed_x_handles: [h], from_date: ymd(at - 3 * 86_400_000), to_date: ymd(at + 86_400_000) }];
      const r = await call('community trader', traderPrompt(h, coins.map((c) => c.coin)), tools);
      return r ? parseTrader(r.j, r.sources, coins, at) : null;
    },
  };
}

const KIND_TAG: Record<LevelKind, string> = { resistance: 'R', support: 'S', target: 'T', entry: 'E', stop: 'SL', level: 'L' };
const px = (x: number) => (x >= 100 ? x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : String(Number(x.toPrecision(5))));
/** "Community trader #1: bias short · R 2,550.0 · S 2,400.0 (posted 10-12 18:00 UTC)" (plain text; the card escapes it). */
export function traderLine(label: string, t: TraderLevels): string {
  const order: LevelKind[] = ['resistance', 'target', 'entry', 'level', 'support', 'stop'];
  const lv = [...t.levels].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.price - a.price).map((l) => `${KIND_TAG[l.kind]} ${px(l.price)}`);
  return `${label}: ${t.bias ? `bias ${t.bias} · ` : ''}${lv.join(' · ')} (posted ${iso(t.posted).slice(5)})`;
}
