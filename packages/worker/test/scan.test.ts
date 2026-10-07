import { describe, expect, test } from 'vitest';
import type { Ticker } from '@bot/bitunix';
import { CORE_SYMBOLS } from '@bot/signals';
import { stickyList } from '../src/scan';

const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 7);
const t = (symbol: string, vol: number) => ({ symbol, quoteVolume24h: vol } as Ticker);
const opts = { joinVolume: 350_000, maxExtra: 300 };
const extras = (list: string[]) => list.filter((s) => !(CORE_SYMBOLS as readonly string[]).includes(s));

describe('sticky coin list', () => {
  test('joins at $0.35M; stays while above $0.2M; leaves after 3 quiet days; gone or untradable leaves at once', () => {
    const day0 = stickyList([t('AUSDT', 400_000), t('BUSDT', 300_000)], undefined, {}, NOW, opts);
    expect(extras(day0.list)).toEqual(['AUSDT']); // B never joined
    // A drops to $0.25M: still above the stay floor, kept.
    const day1 = stickyList([t('AUSDT', 250_000)], undefined, day0.state, NOW + DAY, opts);
    expect(extras(day1.list)).toEqual(['AUSDT']);
    expect(day1.state.AUSDT).toEqual({ lowSince: null });
    // Under $0.2M: the clock starts; kept for 3 days.
    const day2 = stickyList([t('AUSDT', 150_000)], undefined, day1.state, NOW + 2 * DAY, opts);
    expect(day2.state.AUSDT).toEqual({ lowSince: NOW + 2 * DAY });
    expect(extras(stickyList([t('AUSDT', 150_000)], undefined, day2.state, NOW + 4 * DAY, opts).list)).toEqual(['AUSDT']);
    expect(extras(stickyList([t('AUSDT', 150_000)], undefined, day2.state, NOW + 5 * DAY, opts).list)).toEqual([]);
    // A recovery resets the clock.
    expect(stickyList([t('AUSDT', 210_000)], undefined, day2.state, NOW + 4 * DAY, opts).state.AUSDT).toEqual({ lowSince: null });
    // Delisted or no longer API-tradable: out now.
    expect(extras(stickyList([], undefined, day1.state, NOW + 2 * DAY, opts).list)).toEqual([]);
    expect(extras(stickyList([t('AUSDT', 250_000)], new Set(['BTCUSDT']), day1.state, NOW + 2 * DAY, opts).list)).toEqual([]);
  });
});
