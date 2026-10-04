import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { proEvents, proState } from '../src/screen/rsipro';

const flat = (n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ openTime: i, open: 100, high: 101, low: 99, close: 100, volume: 1 }));

describe('RSI Pro+ Suite', () => {
  test('regime: bull when RSI held >= 40 and went over 60 in the last 50 bars; bear mirrored', () => {
    const up = Array.from({ length: 60 }, (_, i) => (i === 30 ? 65 : 45));
    expect(proState(up).regime[59]).toBe(1);
    const dn = Array.from({ length: 60 }, (_, i) => (i === 30 ? 35 : 55));
    expect(proState(dn).regime[59]).toBe(-1);
    expect(proState(Array.from({ length: 60 }, () => 50)).regime[59]).toBe(0);
  });
  test('a cross over the signal line above 50 is "flip aligned"; below 50 "flip counter"; shorts mirror', () => {
    const r: (number | null)[] = Array.from({ length: 80 }, () => 55);
    r[60] = 50.5; r[61] = 58; // dips under its SMA14 (55), then crosses back over at 61, above 50
    r[70] = 45; r[71] = 40; r[72] = 48; // under 50: crosses over the signal (about 54) ? no: stays under -> no long flip
    const e = proEvents(flat(80), r, Array.from({ length: 80 }, () => 1));
    expect(e.some((x) => x.d === 1 && x.pat === 'flip aligned' && x.i === 61)).toBe(true);
    expect(e.some((x) => x.d === -1 && x.pat === 'flip aligned' && x.i === 60)).toBe(false); // 50.5 is >= 50: a short flip there is counter-trend
    expect(e.some((x) => x.d === -1 && x.pat === 'flip counter' && x.i === 60)).toBe(true);
  });
});
