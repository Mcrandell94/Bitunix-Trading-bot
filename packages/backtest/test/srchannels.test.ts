// The S/R channels port (LonesomeTheBlue's SRchannel): pivots, channel levels, the break alerts, no look-ahead,
// and the bot's three entry styles built on it.
import type { Candle } from '@bot/marketdata';
import { describe, expect, test } from 'vitest';
import { nearestChannels, pivotAt, srChannels } from '../src/screen/srchannels';
import { SIGNALS, type SignalContext } from '../src/screen/signals';

const H4 = 4 * 3_600_000;
/** A 40-bar wave between 100 and 110 (highs 0.5 above the close, lows 0.5 below), then a climb to 130 and a hold. */
function wave(): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < 360; i++) closes.push(105 + 5 * Math.sin((2 * Math.PI * i) / 40));
  const last = closes.at(-1)!;
  for (let k = 1; k <= 20; k++) closes.push(last + (130 - last) * (k / 20));
  for (let k = 0; k < 30; k++) closes.push(130);
  return closes.map((c, i) => ({ openTime: i * H4, open: i ? closes[i - 1]! : c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 }));
}

describe('SRchannel port', () => {
  const c = wave();
  const sr = srChannels(c);

  test('a pivot is confirmed prd bars after it, and only if it is the extreme of the window', () => {
    const highs = c.map((x) => x.high);
    // The wave peaks at bar 10 (sin = 1): confirmed at bar 20, not before.
    expect(pivotAt(highs, 19, 10, true)).toBeNull();
    expect(pivotAt(highs, 20, 10, true)).toBeCloseTo(110.5, 10);
    expect(pivotAt(highs, 21, 10, true)).toBeNull();
  });

  test('no channel and no alert before 300 bars (Pine: ta.highest(300) is na)', () => {
    for (let i = 0; i < 299; i++) expect(sr.channels[i]).toEqual([]);
    expect([...sr.resBroken.slice(0, 300)].every((v) => v < 0)).toBe(true);
  });

  test('the wave tops and bottoms become the strongest channels', () => {
    const chs = sr.channels[350]!;
    expect(chs.length).toBeGreaterThanOrEqual(2);
    expect(chs.some((ch) => Math.abs(ch.hi - 110.5) < 0.6 && ch.hi >= ch.lo)).toBe(true);
    expect(chs.some((ch) => Math.abs(ch.lo - 99.5) < 0.6)).toBe(true);
    const nc = nearestChannels(chs, 105);
    expect(nc.above).not.toBeNull();
    expect(nc.below).not.toBeNull();
  });

  test('the climb breaks resistance once, on the first close above the top channel', () => {
    const top = Math.max(...sr.channels[360]!.map((ch) => ch.hi));
    const fired = [...sr.resBroken.keys()].filter((i) => i >= 360 && sr.resBroken[i]! >= 0);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    const first = fired[0]!;
    expect(c[first]!.close).toBeGreaterThan(top);
    expect(c[first - 1]!.close).toBeLessThanOrEqual(top);
    expect([...sr.supBroken.slice(360)].every((v) => v < 0)).toBe(true);
  });

  test('no look-ahead: a shorter history gives the same channels and alerts on every bar it has', () => {
    for (const k of [305, 340, 371, 390]) {
      const part = srChannels(c.slice(0, k));
      for (let i = 0; i < k; i++) {
        expect(part.channels[i], `bar ${i} of ${k}`).toEqual(sr.channels[i]);
        expect(part.resBroken[i]).toBe(sr.resBroken[i]);
        expect(part.supBroken[i]).toBe(sr.supBroken[i]);
      }
    }
  });
});

describe('S/R bot entry styles', () => {
  const c = wave();
  const x = { symbol: 'TESTUSDT', tf: '4h', candles: c } as unknown as SignalContext;
  const def = (id: string) => SIGNALS.find((d) => d.id === id)!;

  test('break: long on the alert bar; stop 1-3 ATR beyond the channel; open space ahead = no target', () => {
    const sr = srChannels(c);
    const sig = def('src_brk_4h').build(x);
    const longs = [...sig.keys()].filter((i) => sig[i] === 1);
    expect(longs).toContain([...sr.resBroken.keys()].find((i) => sr.resBroken[i]! >= 0)!);
    const i = longs.at(-1)!;
    const stop = def('src_brk_4h').stop!(x, sig)[i]!;
    expect(stop).toBeGreaterThan(0);
    expect(def('src_brk_4h').target!(x, sig)[i]).toBeNull(); // nothing above 130
    expect(def('src_brk_4h').invalidate!(x, sig)[i]).toBeGreaterThan(100);
  });

  test('bounce: dips into the support channel and closes back above it on the wave', () => {
    const sig = def('src_bnc_4h').build(x);
    const n = [...sig].filter((v) => v !== 0).length;
    expect(n).toBeGreaterThan(0);
    for (const [i, v] of sig.entries()) if (v) expect(i).toBeGreaterThanOrEqual(299);
  });

  test('every style and timeframe is registered, with and without the room filter', () => {
    for (const st of ['brk', 'rt', 'bnc']) for (const r of ['', '_room15']) for (const tf of ['1h', '4h', '1d']) {
      expect(SIGNALS.some((d) => d.id === `src_${st}${r}_${tf}`), `src_${st}${r}_${tf}`).toBe(true);
    }
  });
});
