import { describe, expect, test } from 'vitest';
import type { RsiSignalRow } from '@bot/backtest';
import type { Candle } from '@bot/marketdata';
import { smcLine, smcNotes, type SmcNote } from '../src/smcInfo';
import { alertText } from '../src/telegram';

const H4 = 4 * 3_600_000;
const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: t * H4, open: o, high: h, low: l, close: c, volume: 1 });
// 30 flat bars, then a jump that leaves a bullish fair value gap 100.5-101 (the smclux.ts test case), then price holds above it.
const gap: Candle[] = [
  ...Array.from({ length: 30 }, (_, i) => bar(i, 100, 100.5, 99.5, 100)),
  bar(30, 100, 104.5, 99.8, 104), bar(31, 104, 105, 101, 104),
  ...Array.from({ length: 6 }, (_, i) => bar(32 + i, 104, 104.6, 101.2, 104)),
];
const fvg = (ns: SmcNote[]) => ns.filter((n) => n.kind === 'FVG');

describe('SMC info line (information only)', () => {
  test('in a bullish zone, on top of it within 1 ATR, nothing further away; a short looks at bearish zones only', () => {
    expect(fvg(smcNotes(gap, '4H', 1, 100.8))).toEqual([{ tf: '4H', kind: 'FVG', where: 'in', bottom: 100.5, top: 101 }]);
    expect(fvg(smcNotes(gap, '4H', 1, 101.5))).toEqual([{ tf: '4H', kind: 'FVG', where: 'on top of', bottom: 100.5, top: 101 }]);
    expect(fvg(smcNotes(gap, '4H', 1, 110))).toEqual([]);
    expect(fvg(smcNotes(gap, '4H', -1, 100.8))).toEqual([]);
    expect(smcNotes(gap.slice(0, 20), '4H', 1, 100)).toEqual([]); // too little history
  });

  test('the line: inside first, 4H before 1D, order blocks before FVGs, duplicates once, at most 3', () => {
    const n = (o: Partial<SmcNote>): SmcNote => ({ tf: '4H', kind: 'order block', where: 'in', bottom: 1, top: 2, ...o });
    expect(smcLine([])).toBe('no 4H / 1D order block or FVG at the price');
    expect(smcLine([n({ where: 'on top of', tf: '1D', kind: 'FVG', bottom: 0.5, top: 0.9 }), n({}), n({}), n({ tf: '1D' })]))
      .toBe('in a 4H order block 1–2 · in a 1D order block 1–2 · on top of a 1D FVG 0.5–0.9');
    expect(smcLine([n({}), n({ tf: '1D' }), n({ kind: 'FVG' }), n({ tf: '1D', kind: 'FVG' })]).split(' · ')).toHaveLength(3);
  });

  test('in the Telegram message under setups, entries and open trades; never on a close', () => {
    const row = (o: Partial<RsiSignalRow>): RsiSignalRow => ({
      symbol: 'ETHUSDT', model: 'triple-div', variant: 1, exitName: '20R target, 90 days', side: 'long', signalAt: 1_000, status: 'enter',
      entry: 2500, enteredAt: null, stop: 2300, target: null, lastPrice: 2500, r: null, exit: null, until: null, closedAt: null, stopPct: 8, plans: ['option 1'], ...o,
    });
    const line = 'SMC (info only, not used for entry): in a 4H order block 2367.7–2429.7';
    expect(alertText(row({}), 'in a 4H order block 2367.7–2429.7')).toContain(line);
    expect(alertText(row({ status: 'waiting', entry: null, stop: null }), 'in a 4H order block 2367.7–2429.7')).toContain(line);
    expect(alertText(row({ status: 'open', enteredAt: 2_000 }), 'in a 4H order block 2367.7–2429.7')).toContain(line);
    expect(alertText(row({ status: 'closed', closedAt: 3_000, exit: 'target', r: 3 }), 'in a 4H order block 2367.7–2429.7')).not.toContain('SMC');
    expect(alertText(row({}))).not.toContain('SMC');
  });
});
