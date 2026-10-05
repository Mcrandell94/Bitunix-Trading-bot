import { describe, expect, test } from 'vitest';
import { fngIndexAt, fngLines, parseFng } from '../src/screen/fng';

const DAY = 86_400_000;
describe('fear & greed factor', () => {
  test('parses alternative.me rows oldest first', () => {
    const p = parseFng({ data: [{ value: '30', timestamp: String(2 * 86_400) }, { value: '70', timestamp: String(86_400) }] });
    expect(p).toEqual([{ t: DAY, v: 70 }, { t: 2 * DAY, v: 30 }]);
  });

  test('uses only a day that has ended by the entry (no lookahead)', () => {
    const fng = [{ t: 0, v: 10 }, { t: DAY, v: 20 }, { t: 2 * DAY, v: 30 }];
    expect(fngIndexAt(fng, 2 * DAY + 5)).toBe(1); // day 2 is still running
    expect(fngIndexAt(fng, 3 * DAY)).toBe(2);
    expect(fngIndexAt(fng, DAY - 1)).toBe(-1);
  });

  test('buckets and the 7-day change', () => {
    const t = (v: number, r: number, chg: number | null) => ({ sym: 'A', t: Date.UTC(2025, 0, 1), r, model: 'bottom-div' as const, v, chg });
    const l = fngLines('X', [t(10, 2, 5), t(80, -1, -3), t(50, 1, null)], 0).join('\n');
    expect(l).toMatch(/extreme fear \(<25\)\s+\+2\.00 \(1, 100% win/);
    expect(l).toMatch(/extreme greed \(>75\)\s+-1\.00 \(1, 0% win/);
    expect(l).toMatch(/index rising \(7d\)\s+\+2\.00 \(1,/);
  });
});
