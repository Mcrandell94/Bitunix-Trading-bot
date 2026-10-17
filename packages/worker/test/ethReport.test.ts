import { afterEach, describe, expect, test } from 'vitest';
import type { BitunixClient } from '@bot/bitunix';
import { loadSnapshot, migrate, saveSnapshot } from '@bot/store';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { download, resetMemory, setWanted } from '../src/candleMemory';
import { applyControl, ControlError, parseControl, type ControlDeps } from '../src/controls';
import { CARD_SENT_KEY, CARD_UPDATE, cardKey, cardStep, dueCardMessages, loadCardSwitches, resetCardMemory, updateKey } from '../src/ethReport';
import { silentLogger } from '../src/index';

const H = 3_600_000, H4 = 4 * H, DAY = 24 * H, T = Date.UTC(2026, 9, 12, 0); // a daily (and 4H) close
const card = ['<b>card</b>', '<b>part 2</b>'];

describe('ETH / BTC cards: what is due', () => {
  test('nothing while off; only the card (no change alerts since cards v3), only from the switch on, once', () => {
    expect(dueCardMessages('ETHUSDT', T, { on: false, since: null }, card, new Set())).toEqual([]);
    expect(dueCardMessages('ETHUSDT', T, { on: true, since: T - H }, card, new Set())).toEqual([
      { key: `ETHUSDT|card2|${T}|0`, text: '<b>card</b>' }, { key: `ETHUSDT|card2|${T}|1`, text: '<b>part 2</b>' },
    ]);
    // A close before the switch: no card. Already sent: not again.
    expect(dueCardMessages('ETHUSDT', T, { on: true, since: T + 1 }, card, new Set())).toEqual([]);
    expect(dueCardMessages('ETHUSDT', T, { on: true, since: T - H }, card, new Set([`ETHUSDT|card2|${T}|0`])).map((x) => x.key)).toEqual([`ETHUSDT|card2|${T}|1`]);
  });

  test('the switch takes ETHUSDT or BTCUSDT and on / off only', () => {
    expect(parseControl({ action: 'eth-report', coin: 'BTCUSDT', on: true })).toEqual({ action: 'eth-report', coin: 'BTCUSDT', on: true });
    expect(() => parseControl({ action: 'eth-report', coin: 'XRPUSDT', on: true })).toThrow(ControlError);
    expect(() => parseControl({ action: 'eth-report', coin: 'ETHUSDT', on: 'yes' })).toThrow(ControlError);
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
  test('switched on just before a 4H close: the card goes out once, and nothing else (no AI read); a failed send is retried; nothing when off', async () => {
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
      // CoinLobster (clcard.ts): the whale line, fetched once per close even when the send is retried.
      const clCalls: string[] = [];
      const clFetch = (async (u: string) => {
        clCalls.push(u);
        return new Response(JSON.stringify(u.includes('/whales/context')
          ? { data: { breadth: { elevated: 18, total: 47 }, stats: { usd_24h: 64.9e6, net_24h: -5.1e6, multiple_vs_avg: 0.39, buy_share_24h: 0.46, buy_share_7d: 0.36, highest_in_days: 0, record: false } } }
          : { data: { rows: [{ t: T - 2 * H, buyUsd: 5e6, sellUsd: 1e6 }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch;
      const step = (now: number) => cardStep({ client, db: pool, log: silentLogger, telegram: { token: 'T', chatId: '1' }, fetchFn, clKey: 'k', clFetch }, now);
      expect(await step(T + 60_000)).toBe(0); // Telegram down: nothing remembered, the close is retried
      const n = await step(T + 75_000);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(sent[0]).toMatch(/^📊 <b>ETHUSDT<\/b> · POIs · /);
      expect(sent[0]).toContain('<b>POIs</b>');
      expect(sent.some((m) => m.includes('AI read'))).toBe(false);
      expect(sent[0]).toContain('<b>Positioning</b> (CoinLobster · live)\n whales 24h $64.9M (0.39x its daily avg) · net −$5.1M · buy share 46% (7d 36%) · last 4H net +$4.0M · 18/47 coins running hot');
      expect(clCalls).toHaveLength(2); // the retry reused them
      for (const m of sent) expect(m.length).toBeLessThanOrEqual(4096);
      expect(sent.every((m) => m.startsWith('📊 <b>ETHUSDT</b> · POIs'))).toBe(true); // the card only: no change alerts
      expect(sent.every((m) => !m.includes('BTCUSDT'))).toBe(true); // BTC is off
      expect(await step(T + 90_000)).toBe(0); // once per close
      resetCardMemory();
      expect(await step(T + 95_000)).toBe(0); // after a restart: the sent list remembers
      expect(((await loadSnapshot<string[]>(pool, CARD_SENT_KEY)) ?? []).length).toBe(n);
      expect(await step(T + H + 60_000)).toBe(0); // a 1H close only: nothing new
      const before = sent.length;
      expect(await step(T + H4 + 60_000)).toBeGreaterThanOrEqual(1); // the next 4H close: the next card
      expect(sent[before]).toContain('· POIs · ');
      await applyControl({ ...deps, now: () => T + H4 + 2 * H }, { action: 'eth-report', coin: 'ETHUSDT', on: false }, 'test');
      expect(await step(T + 2 * H4 + 60_000)).toBe(0);
      expect(sent.some((m) => m.includes('Community traders'))).toBe(false); // no Grok: no line
    } finally {
      await drop();
    }
  });

  test('after a deploy: the card of a close already sent goes once more as UPDATED, once per tag; not for a coin switched on after it', async () => {
    const { pool, drop } = await freshSchema();
    try {
      await migrate(pool);
      const client = fakeExchange();
      setWanted(['ETHUSDT', 'BTCUSDT']);
      for (const s of ['ETHUSDT', 'BTCUSDT']) await download(client, s, T + 60_000);
      const ctl = (now: number) => ({ db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => now });
      await applyControl(ctl(T - 2 * H4), { action: 'eth-report', coin: 'ETHUSDT', on: true }, 'test');
      await applyControl(ctl(T + 30 * 60_000), { action: 'eth-report', coin: 'BTCUSDT', on: true }, 'test'); // after the close
      // The old code already sent ETH's card of the close T, and an earlier tag's repost of it (under the key it used then).
      await saveSnapshot(pool, CARD_SENT_KEY, [cardKey('ETHUSDT', T, 0), cardKey('ETHUSDT', T, 1), `ETHUSDT|update|${T}|0`, updateKey('ETHUSDT', T, 0, 'an earlier tag')]);
      await saveSnapshot(pool, CARD_UPDATE.key, { ETHUSDT: 'an earlier tag' });
      const sent: string[] = [];
      const fetchFn = (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body)).text); return new Response('{}'); }) as unknown as typeof fetch;
      const logged: unknown[] = [];
      const log = { ...silentLogger, info: (m: string, f?: unknown) => { if (m === 'cards: sent') logged.push(f); } };
      const step = (now: number) => cardStep({ client, db: pool, log, telegram: { token: 'T', chatId: '1' }, fetchFn }, now);
      expect(await step(T + 3 * H)).toBeGreaterThanOrEqual(1);
      expect(logged).toEqual([{ coin: 'ETHUSDT', close: new Date(T).toISOString(), kind: 'UPDATED', messages: sent.length }]);
      expect(sent.every((m) => m.startsWith('📊 <b>ETHUSDT</b> · POIs'))).toBe(true); // BTC was switched on after the close
      expect(sent[0]).toMatch(/^📊 <b>ETHUSDT<\/b> · POIs · <b>UPDATED<\/b> · /);
      expect(await loadSnapshot(pool, CARD_UPDATE.key)).toEqual({ ETHUSDT: CARD_UPDATE.tag });
      const once = sent.length;
      resetCardMemory();
      expect(await step(T + 3 * H + 15 * 60_000)).toBe(0); // after another restart: not again
      expect(await step(T + H4 + 60_000)).toBeGreaterThanOrEqual(2); // the next close: both coins' regular cards
      expect(sent.slice(once).some((m) => m.includes('UPDATED'))).toBe(false);
      expect(await loadSnapshot(pool, CARD_UPDATE.key)).toEqual({ ETHUSDT: CARD_UPDATE.tag, BTCUSDT: CARD_UPDATE.tag });
    } finally {
      await drop();
    }
  });

  test('Grok: the community traders only, #1 and #2 by label, never by handle', async () => {
    const { pool, drop } = await freshSchema();
    try {
      await migrate(pool);
      const client = fakeExchange();
      setWanted(['ETHUSDT', 'BTCUSDT']);
      await download(client, 'ETHUSDT', T + 60_000);
      await applyControl({ db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => T - 60_000 }, { action: 'eth-report', coin: 'ETHUSDT', on: true }, 'test');
      const sent: string[] = [];
      const fetchFn = (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body)).text); return new Response('{}'); }) as unknown as typeof fetch;
      const traderAsks: string[] = [];
      const grok = {
        trader: async (handle: string, coins: { coin: string; price: number }[]) => {
          traderAsks.push(`${handle} ${coins.map((c) => c.coin).join(',')}`);
          const p = coins.find((c) => c.coin === 'ETHUSDT')!.price;
          return handle === 'mrcrypt0krabs'
            ? [{ coin: 'ETHUSDT', bias: 'long' as const, levels: [{ price: Math.round(p * 0.98), kind: 'support' as const }], posted: T - 2 * H }]
            : [{ coin: 'ETHUSDT', bias: 'short' as const, levels: [{ price: Math.round(p * 1.03), kind: 'resistance' as const }], posted: T - 3 * H }];
        },
      };
      const step = (now: number) => cardStep({ client, db: pool, log: silentLogger, telegram: { token: 'T', chatId: '1' }, grok, fetchFn }, now);
      expect(await step(T + 60_000)).toBeGreaterThanOrEqual(1);
      expect(sent[0]).toContain('🗞 <b>Community traders (Grok · unverified · not advice)</b>\n Community trader #1: bias long · S ');
      expect(sent[0]).toContain('\n Community trader #2: bias short · R ');
      expect(traderAsks).toEqual(['mrcrypt0krabs ETHUSDT', 'CryptoNavi399 ETHUSDT']); // one call a trader for the card coins with candles (BTC isn't loaded here)
      expect(sent.join('\n')).not.toMatch(/krabs|navi/i); // no handle reaches the group
      expect(sent.some((m) => m.includes('🚨') || m.includes('X / news'))).toBe(false); // nothing else from Grok
      resetCardMemory();
      expect(await step(T + 90_000)).toBe(0); // after a restart: the card is remembered
      expect(traderAsks).toHaveLength(2); // and Grok is not asked again for a card already sent
    } finally {
      await drop();
    }
  });
});
