import { afterEach, describe, expect, test } from 'vitest';
import type { FvSignalRow } from '@bot/backtest';
import { PATHS, type BitunixClient } from '@bot/bitunix';
import type { Candle } from '@bot/marketdata';
import { loadSnapshot, migrate, saveSnapshot } from '@bot/store';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { download, resetMemory, setWanted } from '../src/candleMemory';
import { applyControl, parseControl, type ControlDeps } from '../src/controls';
import { FV_SIGNALS_KEY, last1hClose, newestSpike, refreshFvSignals, resetFundingMemory, type FvSignalsSnapshot } from '../src/fvSignals';
import { silentLogger } from '../src/index';
import { RSI_SIGNALS_KEY, wantCoins } from '../src/rsiSignals';
import { dueFvAlerts, fvAlertStep, fvAlertText, fvEventKey, loadFvAlert } from '../src/telegram';

const M15 = 15 * 60_000, H = 3_600_000, H4 = 4 * H, DAY = 86_400_000;
const MS: Record<string, number> = { '15m': M15, '1h': H, '4h': H4, '1d': DAY };
// The squeeze candle: 4H from 08:00, closing at T = 12:00 UTC, up 10% on 5x volume while shorts pay 0.1% a settlement.
const SQ = Date.UTC(2026, 9, 6, 8), T = SQ + H4;

/** OHLC + quote volume of one candle: flat at 100 except the squeeze candle and the 1H candles after it. */
function kline(interval: string, t: number) {
  if (interval === '4h' && t === SQ) return { open: 100, high: 110.5, low: 99.5, close: 110, quoteVol: 5000 };
  if (interval === '1h' && t === T) return { open: 110, high: 110.2, low: 108.8, close: 109, quoteVol: 250 }; // closes down: confirms the short
  if (interval === '1h' && t === T + H) return { open: 109, high: 109.2, low: 108.3, close: 108.5, quoteVol: 250 };
  if (interval === '1h' && t === T + 2 * H) return { open: 108.5, high: 108.6, low: 101, close: 102, quoteVol: 250 }; // through the 2R target
  return { open: 100, high: 100.5, low: 99.5, close: 100, quoteVol: interval === '4h' ? 1000 : 250 };
}

/** A fake exchange: candles from `kline`, funding -0.1% every 8h; counts funding reads. */
function fakeClient() {
  const fundingReads: string[] = [];
  const client: BitunixClient = {
    get: async <X,>(path: string, q?: Record<string, unknown>) => {
      const { symbol, interval, startTime, endTime } = q as { symbol: string; interval: string; startTime: number; endTime: number };
      if (path === PATHS.fundingRateHistory) {
        fundingReads.push(symbol);
        const out = [];
        for (let t = Math.ceil(startTime / (8 * H)) * 8 * H; t <= endTime; t += 8 * H) out.push({ fundingRate: '-0.001', fundingTime: t });
        return out as X;
      }
      const out = [];
      for (let t = Math.ceil(startTime / MS[interval]!) * MS[interval]!; t <= endTime; t += MS[interval]!) out.push({ time: t, ...kline(interval, t) });
      return out as X;
    },
  };
  return { client, fundingReads };
}

const fvRow = (o: Partial<FvSignalRow> = {}): FvSignalRow => ({
  symbol: 'KAIAUSDT', side: 'short', signalAt: T, status: 'enter', until: null, confirmedAt: T + H, entry: 0.05487, enteredAt: null,
  stop: 0.060445, target: 0.043719, lastPrice: 0.05487, r: null, exit: null, closedAt: null, stopPct: 10.2, crowd: 'short', rate8: -0.00658,
  move: 0.449, rvol: 221.6, fundingR: null, ...o,
});

afterEach(() => { resetMemory(); resetFundingMemory(); });

describe('funding squeeze alerts', () => {
  test('the entry signal, the opening only if the entry was not posted, the close only of a trade posted', () => {
    const on = { on: true, since: T }, enter = fvRow(), open = fvRow({ status: 'open', enteredAt: T + H, entry: 0.0549 });
    const closed = fvRow({ status: 'closed', enteredAt: T + H, closedAt: T + 5 * H, exit: 'target', r: 1.98 });
    expect(dueFvAlerts([enter], on, new Set(), T + 2 * H)).toEqual([enter]);
    expect(dueFvAlerts([enter], { on: false, since: null }, new Set(), T + 2 * H)).toEqual([]);
    expect(dueFvAlerts([enter], { on: true, since: T + 2 * H }, new Set(), T + 3 * H)).toEqual([]); // before the switch
    expect(dueFvAlerts([open], on, new Set([fvEventKey(enter, 'enter')]), T + 2 * H)).toEqual([]);
    expect(dueFvAlerts([open], on, new Set(), T + 2 * H)).toEqual([open]); // the worker was down at the entry
    expect(dueFvAlerts([closed], on, new Set(), T + 6 * H)).toEqual([]); // nobody was told about this trade
    expect(dueFvAlerts([closed], on, new Set([fvEventKey(enter, 'enter')]), T + 6 * H)).toEqual([closed]);
    expect(dueFvAlerts([closed], on, new Set([fvEventKey(enter, 'enter'), fvEventKey(closed, 'closed')]), T + 6 * H)).toEqual([]);
    expect(dueFvAlerts([fvRow({ status: 'waiting', until: T + 4 * H })], on, new Set(), T + H)).toEqual([]); // waiting setups are not posted
    expect(dueFvAlerts([enter], on, new Set(), T + H + 14 * DAY + 1)).toEqual([]); // nothing older than 2 weeks
  });

  test('message text (the 2026-10-10 mockup)', () => {
    const t = fvAlertText(fvRow());
    expect(t).toContain('📣 🔴 SHORT <b>KAIAUSDT</b> · 4H funding squeeze');
    expect(t).toContain('Entry signal: a 1H candle closed down after the squeeze; enter at the next 1H open (about 0.05487).');
    expect(t).toContain('Stop 0.060445 (10.2%) · Target 0.043719');
    expect(t).toContain('Exit: 2R target, no time limit');
    expect(t).toContain('Why: Shorts crowded (funding −0.658% per 8h over the last 24h); the 4H candle moved +44.9% on 221.6× normal volume against them.');
    expect(t).toContain('Funding: shorts pay about 0.658% per 8h, so this trade pays it while open.');
    expect(t).toContain('Signal only: the bot does not trade this model.');
    expect(fvAlertText(fvRow({ status: 'closed', exit: 'target', r: 1.98, fundingR: -0.15 }))).toContain('Closed (🎯 target 0.043719): +1.98R (funding paid -0.15R)');
    expect(fvAlertText(fvRow({ status: 'closed', exit: 'stop', r: -1.02, fundingR: 0 }))).toContain('Closed (❌ stop 0.060445): -1.02R');
    expect(fvAlertText(fvRow({ side: 'long', crowd: 'long', rate8: 0.0007, move: -0.3 }))).toContain('🟢 LONG');
    expect(fvAlertText(fvRow({ symbol: 'A<B' }))).toContain('A&lt;B');
  });

  test('the dashboard switch: on / off only', () => {
    expect(parseControl({ action: 'fv-alert', on: true })).toEqual({ action: 'fv-alert', on: true });
    expect(() => parseControl({ action: 'fv-alert' })).toThrow();
    expect(() => parseControl({ action: 'fv-alert', on: 'yes' })).toThrow();
  });

  test('newestSpike: the close of the newest 4H candle on 3x+ volume in the funding window', () => {
    const c = (i: number, v: number): Candle => ({ openTime: SQ - (40 - i) * H4, open: 1, high: 1, low: 1, close: 1, volume: v });
    const c4 = Array.from({ length: 41 }, (_, i) => c(i, i === 30 ? 3000 : i === 40 ? 2999 : 1000));
    expect(newestSpike(c4, T)).toBe(c4[30]!.openTime + H4);
    expect(newestSpike(c4.slice(0, 30), T)).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('funding squeeze signals (Postgres)', { timeout: 60_000 }, () => {
  test('squeeze, 1H confirmation, entry, trade, close: rows, Telegram, and the RSI snapshot untouched', async () => {
    const { pool, drop } = await freshSchema();
    try {
      await migrate(pool);
      const { client, fundingReads } = fakeClient();
      const deps = { client, db: pool, log: silentLogger };
      // A coin with an open trade whose candles are not downloaded keeps its row; an old entry signal does not.
      await saveSnapshot(pool, FV_SIGNALS_KEY, { time: 0, coins: 0, pending: 0, rows: [fvRow({ symbol: 'GONEUSDT', status: 'open', enteredAt: T - DAY }), fvRow({ symbol: 'OLDUSDT', status: 'enter' })] });
      expect(await wantCoins({ db: pool }, ['AUSDT'])).toEqual(expect.arrayContaining(['GONEUSDT', 'AUSDT']));
      const now1 = T + H + 20_000;
      setWanted(['SQZUSDT', 'THINUSDT']);
      await download(client, 'SQZUSDT', now1);
      await download(client, 'THINUSDT', now1);
      // THINUSDT is under $0.5M (not in the list) and has no rows: not checked, though its candles squeeze too.
      const s1 = await refreshFvSignals(deps, now1, ['SQZUSDT']);
      expect(s1).toMatchObject({ time: last1hClose(now1), coins: 1, pending: 0 });
      expect(s1.rows.map((r) => [r.symbol, r.status])).toEqual([['SQZUSDT', 'enter'], ['GONEUSDT', 'open']]);
      expect(s1.rows[0]).toMatchObject({ side: 'short', crowd: 'short', entry: 109, signalAt: T, confirmedAt: T + H, rvol: 5 });
      expect([...new Set(fundingReads)]).toEqual(['SQZUSDT']); // one read: fetchFundingHistory pages until a page adds nothing (2 requests)
      const firstRead = fundingReads.length;
      expect(await loadSnapshot(pool, RSI_SIGNALS_KEY)).toBeNull(); // the live executor's input is never written

      // Telegram: switched on at T; the entry is posted once.
      const controls: ControlDeps = { db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => T };
      await applyControl(controls, { action: 'fv-alert', on: true }, 'test');
      expect(await loadFvAlert(pool)).toEqual({ on: true, since: T });
      const sent: string[] = [];
      const fetchFn = (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body)).text); return new Response('{}'); }) as unknown as typeof fetch;
      const tg = (snap: FvSignalsSnapshot, now: number) => fvAlertStep({ db: pool, log: silentLogger, telegram: { token: 'T', chatId: '1' }, fetchFn, now: () => now }, snap);
      expect(await tg(s1, now1)).toBe(1);
      expect(await tg(s1, now1)).toBe(0);
      expect(sent[0]).toContain('📣 🔴 SHORT <b>SQZUSDT</b> · 4H funding squeeze');

      // The next 1H close: the trade is open at that candle's open; nothing new to post. Funding is not read again.
      const now2 = T + 2 * H + 20_000, s2 = await refreshFvSignals(deps, now2, ['SQZUSDT']);
      expect(s2.rows[0]).toMatchObject({ symbol: 'SQZUSDT', status: 'open', entry: 109, enteredAt: T + H });
      expect(await tg(s2, now2)).toBe(0);
      // Then the 2R target: closed, and the close is posted.
      const now3 = T + 3 * H + 20_000, s3 = await refreshFvSignals(deps, now3, ['SQZUSDT']);
      expect(s3.rows[0]).toMatchObject({ symbol: 'SQZUSDT', status: 'closed', exit: 'target', closedAt: T + 3 * H });
      expect(s3.rows[0]!.r).toBeGreaterThan(1.9);
      expect(await tg(s3, now3)).toBe(1);
      expect(sent[1]).toMatch(/Closed \(🎯 target [\d.]+\): \+1\.9\dR/);
      expect(fundingReads.length).toBeLessThanOrEqual(3 * firstRead); // read again only while the trade was on, hourly at most
      expect(new Set(fundingReads)).toEqual(new Set(['SQZUSDT']));
      expect(await loadSnapshot(pool, RSI_SIGNALS_KEY)).toBeNull();
    } finally {
      await drop();
    }
  });
});
