import { afterEach, describe, expect, test } from 'vitest';
import type { CoinEvent } from '@bot/backtest';
import type { BitunixClient } from '@bot/bitunix';
import { loadSnapshot, migrate } from '@bot/store';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { AI_READ, aiReader, clipRead } from '../src/aiRead';
import { download, resetMemory, setWanted } from '../src/candleMemory';
import { applyControl, ControlError, parseControl, type ControlDeps } from '../src/controls';
import { CARD_SENT_KEY, cardStep, dueCardMessages, loadCardSwitches, resetCardMemory } from '../src/ethReport';
import { silentLogger } from '../src/index';
import { MAX_ALERT_AGE_MS } from '../src/telegram';

const H = 3_600_000, H4 = 4 * H, DAY = 24 * H, T = Date.UTC(2026, 9, 12, 0); // a daily (and 4H) close
const ev = (t: number, kind = 'macd', text = 'x'): CoinEvent => ({ t, tf: '4H', kind, key: `v2|4H|${kind}|${t}`, text });
const card = ['<b>card</b>', '<b>part 2</b>'];

describe('ETH / BTC cards: what is due', () => {
  test('nothing while off; the card, then the alerts oldest first (escaped); only from the switch on', () => {
    expect(dueCardMessages('ETHUSDT', T, { on: false, since: null }, card, [ev(T)], new Set(), T)).toEqual([]);
    const m = dueCardMessages('ETHUSDT', T, { on: true, since: T - H }, card, [ev(T, 'rsi', 'RSI <30 & falling'), ev(T - 30 * 60_000, 'mm-new'), ev(T - 2 * H, 'before')], new Set(), T);
    expect(m).toEqual([
      { key: `ETHUSDT|card2|${T}|0`, text: '<b>card</b>' }, { key: `ETHUSDT|card2|${T}|1`, text: '<b>part 2</b>' },
      { key: `ETHUSDT|v2|4H|mm-new|${T - 30 * 60_000}`, text: 'x' }, { key: `ETHUSDT|v2|4H|rsi|${T}`, text: 'RSI &lt;30 &amp; falling' },
    ]);
    // A close before the switch: no card. Already sent: not again.
    expect(dueCardMessages('ETHUSDT', T, { on: true, since: T + 1 }, card, [], new Set(), T)).toEqual([]);
    expect(dueCardMessages('ETHUSDT', T, { on: true, since: T - H }, card, [], new Set([`ETHUSDT|card2|${T}|0`]), T).map((x) => x.key)).toEqual([`ETHUSDT|card2|${T}|1`]);
    // Nothing older than 2 weeks.
    expect(dueCardMessages('ETHUSDT', T, { on: true, since: 0 }, [], [ev(T - MAX_ALERT_AGE_MS - 1)], new Set(), T)).toEqual([]);
  });

  test('the switch takes ETHUSDT or BTCUSDT and on / off only', () => {
    expect(parseControl({ action: 'eth-report', coin: 'BTCUSDT', on: true })).toEqual({ action: 'eth-report', coin: 'BTCUSDT', on: true });
    expect(() => parseControl({ action: 'eth-report', coin: 'XRPUSDT', on: true })).toThrow(ControlError);
    expect(() => parseControl({ action: 'eth-report', coin: 'ETHUSDT', on: 'yes' })).toThrow(ControlError);
  });
});

/** A fake Messages API: answers each call with `text` (and `stop`), and keeps the request bodies. */
function fakeClaude(text: string, stop = 'end_turn', status = 200) {
  const calls: Record<string, unknown>[] = [];
  const fetchFn = (async (_u: unknown, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    if (status !== 200) return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'down' } }), { status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: AI_READ.model, content: text ? [{ type: 'text', text }] : [], stop_reason: stop, stop_sequence: null,
      usage: { input_tokens: 500, output_tokens: 80 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe('the AI read (Claude Sonnet 5.5)', () => {
  test('off without a key; the card text in, low effort, no advice asked for; the read out', async () => {
    expect(aiReader(null, silentLogger)).toBeNull();
    expect(aiReader('', silentLogger)).toBeNull();
    const f = fakeClaude('Weekly and daily trend are up.  The 4H sits in chop under resistance 2,369.9.');
    const read = await aiReader('k', silentLogger, f.fetchFn)!('ETHUSDT at the 10-13 00:00 close. Price 2,300.0');
    expect(read).toBe('Weekly and daily trend are up. The 4H sits in chop under resistance 2,369.9.');
    expect(f.calls).toHaveLength(1);
    const body = f.calls[0] as { model: string; output_config: unknown; system: string; messages: { content: string }[] };
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.system).toContain('long POIs');
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.system).toContain('do not give advice');
    expect(body.messages[0]!.content).toBe('ETHUSDT at the 10-13 00:00 close. Price 2,300.0');
  });

  test('a refusal, an empty answer or a failed call gives no read (the card goes out without it); long reads are cut at a sentence', async () => {
    expect(await aiReader('k', silentLogger, fakeClaude('', 'refusal').fetchFn)!('x')).toBeNull();
    expect(await aiReader('k', silentLogger, fakeClaude('').fetchFn)!('x')).toBeNull();
    const warned: unknown[] = [];
    const down = fakeClaude('x', 'end_turn', 400);
    expect(await aiReader('secret-key', { ...silentLogger, warn: (_m, f) => warned.push(f) }, down.fetchFn)!('x')).toBeNull();
    expect(JSON.stringify(warned)).not.toContain('secret-key');
    expect(await aiReader('k', silentLogger, fakeClaude('One full sentence. Two cut sent', 'max_tokens').fetchFn)!('x')).toBe('One full sentence.');
    const long = `${'Word '.repeat(80).trim()}. ${'More '.repeat(80).trim()}.`;
    expect(clipRead(long).length).toBeLessThanOrEqual(AI_READ.maxChars);
    expect(clipRead(long).endsWith('Word.')).toBe(true);
  });
});

/** A fake exchange: a deterministic wavy price for ETH and BTC on every timeframe, and their funding. */
function fakeExchange(): BitunixClient {
  const price = (sym: string, t: number) => (sym === 'BTCUSDT' ? 30 : 1) * (2500 + 300 * Math.sin(t / (9 * DAY)) + 80 * Math.sin(t / (13 * H)) + 20 * Math.sin(t / (2.3 * H)));
  const MS: Record<string, number> = { '15m': 15 * 60_000, '1h': H, '4h': H4, '1d': DAY };
  return {
    get: async <T,>(path: string, q?: Record<string, unknown>) => {
      if (path.includes('funding_rate/batch')) return [{ symbol: 'ETHUSDT', fundingRate: '0.01', fundingInterval: 8 }, { symbol: 'BTCUSDT', fundingRate: '0.005', fundingInterval: 8 }] as T;
      if (path.includes('funding_rate_history')) return [] as T;
      const { symbol, interval, startTime, endTime } = q as { symbol: string; interval: string; startTime: number; endTime: number };
      const ms = MS[interval]!, out = [];
      for (let t = Math.ceil(startTime / ms) * ms; t <= endTime; t += ms) {
        const o = price(symbol, t), c = price(symbol, t + ms);
        out.push({ time: t, open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c, quoteVol: 1e6 * (1 + Math.abs(Math.sin(t / H))) });
      }
      return out as T;
    },
  };
}

afterEach(() => { resetMemory(); resetCardMemory(); });

describe.skipIf(!TEST_DATABASE_URL)('ETH / BTC cards to Telegram (Postgres)', { timeout: 120_000 }, () => {
  test('switched on just before a 4H close: the card (AI read on top) and the alerts go out once; a failed send is retried with the same read; nothing when off', async () => {
    const { pool, drop } = await freshSchema();
    try {
      await migrate(pool);
      const client = fakeExchange();
      setWanted(['ETHUSDT', 'BTCUSDT']);
      for (const s of ['ETHUSDT', 'BTCUSDT']) await download(client, s, T + 60_000);
      const deps: ControlDeps = { db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => T - 60_000 };
      await applyControl(deps, { action: 'eth-report', coin: 'ETHUSDT', on: true }, 'test');
      expect((await loadCardSwitches(pool)).ETHUSDT).toEqual({ on: true, since: T - 60_000 });
      expect((await loadCardSwitches(pool)).BTCUSDT).toEqual({ on: false, since: null });
      const sent: string[] = [];
      let fail = true;
      const fetchFn = (async (_u: string, init: RequestInit) => {
        if (fail) { fail = false; return new Response('down', { status: 502 }); }
        sent.push(JSON.parse(String(init.body)).text); return new Response('{}');
      }) as unknown as typeof fetch;
      const claude = fakeClaude('Weekly and daily trend are up while the 4H pulls back.'), ai = aiReader('k', silentLogger, claude.fetchFn);
      const step = (now: number) => cardStep({ client, db: pool, log: silentLogger, telegram: { token: 'T', chatId: '1' }, ai, fetchFn }, now);
      expect(await step(T + 60_000)).toBe(0); // Telegram down: nothing remembered, the close is retried
      const n = await step(T + 75_000);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(sent[0]).toMatch(/^📊 <b>ETHUSDT<\/b> · W \/ D \/ 4H card · /);
      expect(sent[0]).toContain('🤖 <b>AI read</b> (Claude Sonnet 5.5 · not advice)\n Weekly and daily trend are up while the 4H pulls back.');
      expect(sent[0]).toContain('<b>POIs</b>');
      expect(claude.calls).toHaveLength(1); // the retry reused the read
      expect((claude.calls[0] as { messages: { content: string }[] }).messages[0]!.content).toMatch(/^ETHUSDT at the /);
      for (const m of sent) expect(m.length).toBeLessThanOrEqual(4096);
      expect(sent.every((m) => !m.includes('BTCUSDT'))).toBe(true); // BTC is off
      expect(await step(T + 90_000)).toBe(0); // once per close
      resetCardMemory();
      expect(await step(T + 95_000)).toBe(0); // after a restart: the sent list remembers, and the read is not bought again
      expect(claude.calls).toHaveLength(1);
      expect(((await loadSnapshot<string[]>(pool, CARD_SENT_KEY)) ?? []).length).toBe(n);
      expect(await step(T + H + 60_000)).toBe(0); // a 1H close only: nothing new
      const before = sent.length;
      expect(await step(T + H4 + 60_000)).toBeGreaterThanOrEqual(1); // the next 4H close: the next card
      expect(sent[before]).toContain(`W / D / 4H card · `);
      expect(claude.calls).toHaveLength(2);
      await applyControl({ ...deps, now: () => T + H4 + 2 * H }, { action: 'eth-report', coin: 'ETHUSDT', on: false }, 'test');
      expect(await step(T + 2 * H4 + 60_000)).toBe(0);
    } finally {
      await drop();
    }
  });
});
