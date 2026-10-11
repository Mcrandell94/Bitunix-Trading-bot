import { afterEach, describe, expect, test } from 'vitest';
import type { EthEvent } from '@bot/backtest';
import type { BitunixClient } from '@bot/bitunix';
import { loadSnapshot, migrate } from '@bot/store';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { download, resetMemory, setWanted } from '../src/candleMemory';
import { applyControl, ControlError, parseControl, type ControlDeps } from '../src/controls';
import { CARD_SENT_KEY, cardStep, dueCardMessages, loadCardSwitches, resetCardMemory } from '../src/ethReport';
import { silentLogger } from '../src/index';
import { MAX_ALERT_AGE_MS } from '../src/telegram';

const H = 3_600_000, H4 = 4 * H, DAY = 24 * H, T = Date.UTC(2026, 9, 12, 0); // a daily (and 4H) close
const ev = (t: number, kind = 'macd', text = 'x'): EthEvent => ({ t, tf: '4H', kind, key: `4H|${kind}|${t}`, text });
const cards = { '4H': ['<b>4H</b>'], '1D': ['<b>1D</b>'] };

describe('ETH / BTC cards: what is due', () => {
  test('nothing while off; the 1D card, then the 4H card, then the alerts oldest first (escaped); only from the switch on', () => {
    expect(dueCardMessages('ETHUSDT', T, { on: false, since: null }, cards, [ev(T)], new Set(), T)).toEqual([]);
    const m = dueCardMessages('ETHUSDT', T, { on: true, since: T - H }, cards, [ev(T, 'rsi', 'RSI <30 & falling'), ev(T - 30 * 60_000, 'kama'), ev(T - 2 * H, 'before')], new Set(), T);
    expect(m).toEqual([
      { key: `ETHUSDT|card|1D|${T}|0`, text: '<b>1D</b>' }, { key: `ETHUSDT|card|4H|${T}|0`, text: '<b>4H</b>' },
      { key: `ETHUSDT|4H|kama|${T - 30 * 60_000}`, text: 'x' }, { key: `ETHUSDT|4H|rsi|${T}`, text: 'RSI &lt;30 &amp; falling' },
    ]);
    // A close before the switch: no card. Already sent: not again.
    expect(dueCardMessages('ETHUSDT', T, { on: true, since: T + 1 }, cards, [], new Set(), T)).toEqual([]);
    expect(dueCardMessages('ETHUSDT', T, { on: true, since: T - H }, cards, [], new Set([`ETHUSDT|card|1D|${T}|0`]), T).map((x) => x.key)).toEqual([`ETHUSDT|card|4H|${T}|0`]);
    // Nothing older than 2 weeks.
    expect(dueCardMessages('ETHUSDT', T, { on: true, since: 0 }, {}, [ev(T - MAX_ALERT_AGE_MS - 1)], new Set(), T)).toEqual([]);
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
  test('switched on just before a daily close: the 1D and 4H cards and the alerts go out once; a failed send is retried; nothing when off', async () => {
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
      const step = (now: number) => cardStep({ client, db: pool, log: silentLogger, telegram: { token: 'T', chatId: '1' }, fetchFn }, now);
      expect(await step(T + 60_000)).toBe(0); // Telegram down: nothing remembered, the close is retried
      const n = await step(T + 75_000);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(sent[0]).toMatch(/^📊 <b>ETHUSDT<\/b> · 1D card · /);
      expect(sent[1]).toMatch(/^📊 <b>ETHUSDT<\/b> · 4H card · /);
      for (const m of sent) expect(m.length).toBeLessThanOrEqual(4096);
      expect(sent.every((m) => !m.includes('BTCUSDT ·'))).toBe(true); // BTC is off
      expect(await step(T + 90_000)).toBe(0); // once per close
      resetCardMemory();
      expect(await step(T + 95_000)).toBe(0); // after a restart: the sent list remembers
      expect(((await loadSnapshot<string[]>(pool, CARD_SENT_KEY)) ?? []).length).toBe(n);
      // The next 1H close (not a 4H close): no card, only new 1H DiNapoli setups if any.
      const before = sent.length;
      await step(T + H + 60_000);
      expect(sent.slice(before).every((m) => m.includes(' · 1H DiNapoli ') && m.includes('setup'))).toBe(true);
      await applyControl({ ...deps, now: () => T + 2 * H }, { action: 'eth-report', coin: 'ETHUSDT', on: false }, 'test');
      expect(await step(T + H4 + 60_000)).toBe(0);
    } finally {
      await drop();
    }
  });
});
