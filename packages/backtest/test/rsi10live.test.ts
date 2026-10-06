import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { rowsFromSetups, type Setup } from '../src/screen/rsisignals';
import { rsi10LiveSetups } from '../src/screen/rsi10live';

const M15 = 15 * 60_000;
const bars = (n: number, px: (k: number) => number = () => 100): Candle[] =>
  Array.from({ length: n }, (_, k) => ({ openTime: k * M15, open: px(k), high: px(k) + 0.5, low: px(k) - 0.5, close: px(k), volume: 1 }));
const setup = (c: Candle[], j: number): Setup => ({
  model: '15m-rsi10', d: 1, known: c[Math.min(j, c.length) - 1]!.openTime + M15, c, atr: c.map(() => 1), j, stop: 90, cap: 0, exit: 'hold', waitUntil: null, bar: M15,
  support: ['bullish order block 4H'],
});

describe('15M-RSI10 live rows', () => {
  test('a setup on the last closed 15m bar is "enter at the next open"; option 1 has no breakeven, 10R and 5R targets', () => {
    const c = bars(200), now = c.at(-1)!.openTime + M15;
    const rows = rowsFromSetups('XUSDT', [setup(c, 200)], [], now);
    const a = rows.find((r) => r.variant === 0 && r.plans.includes('option 1'))!;
    expect(a).toMatchObject({ model: '15m-rsi10', status: 'enter', entry: 100, stop: 90, target: 200, exitName: '10R target, no time stop', support: ['bullish order block 4H'] });
    expect(rows.find((r) => r.variant === 1 && r.plans.includes('option 1'))).toMatchObject({ target: 150, exitName: '5R target, no time stop' });
    expect(rows.find((r) => r.plans.includes('no exceptions'))!.exitName).toMatch(/breakeven/);
  });

  test('a filled setup is followed with no time stop until its target', () => {
    const c = bars(400, (k) => (k < 100 ? 100 : 100 + (k - 100) * 0.4)), now = c.at(-1)!.openTime + M15; // +1R every 25 bars
    const rows = rowsFromSetups('XUSDT', [setup(c, 100)], [], now, 10_000).filter((r) => r.plans.includes('option 1'));
    expect(rows.find((r) => r.variant === 1)).toMatchObject({ status: 'closed', exit: 'target' }); // 5R
    expect(rows.find((r) => r.variant === 0)).toMatchObject({ status: 'closed', exit: 'target' }); // 10R at bar ~350
  });

  test('not enough history: no setups', () => {
    expect(rsi10LiveSetups(bars(100), bars(10), bars(10), bars(10), 0)).toEqual([]);
  });
});
