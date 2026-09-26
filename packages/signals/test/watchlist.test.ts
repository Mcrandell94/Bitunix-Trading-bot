import { RRG_PRESETS } from '@bot/rrg';
import { describe, expect, test } from 'vitest';
import {
  AGREEMENT, DEFAULT_CONFIG, buildWatchlist, resolveConfig, routeSignal,
  type SymbolSeries, type Watchlist,
} from '../src/index';
import { SCENARIOS, totalBars, universe, type AssetSpec, type Segment } from './fixtures';

const RRG_PRESETS_BALANCED = { ...RRG_PRESETS.find((p) => p.key === 'balanced')!.settings };

// One shared BTC/ETH market (seed 42), 64 bars, one asset per signal. Each
// scenario is padded with flat bars in front so they all end on bar 64.
const N = 64;
const pad = (s: ReadonlyArray<Segment>): Segment[] => [{ bars: N - totalBars(s), rel: 0 }, ...s];
const ASSETS: Record<string, AssetSpec> = {
  LEADUSDT: { segments: pad(SCENARIOS.leadingEntry), noiseSeed: 43 },
  BRKUSDT: { segments: pad(SCENARIOS.laggingBreakout), noiseSeed: 81 },
  HOOKUSDT: { segments: pad(SCENARIOS.weakeningHook), noiseSeed: 45 },
  ROLLUSDT: { segments: pad(SCENARIOS.rollover), noiseSeed: 44 },
  FAILUSDT: { segments: pad(SCENARIOS.failedImprove), noiseSeed: 46 },
  XRPUSDT: { segments: pad(SCENARIOS.leadingEntry), noiseSeed: 44 },
  FLATUSDT: { segments: [{ bars: N, rel: 0.0005 }], noiseSeed: 7 },
};
const DESIGNED = {
  LEADUSDT: 'LEADING_ENTRY',
  BRKUSDT: 'LAGGING_BREAKOUT',
  HOOKUSDT: 'WEAKENING_HOOK',
  ROLLUSDT: 'SHORT_ROLLOVER',
  FAILUSDT: 'SHORT_ROLLOVER',
  XRPUSDT: 'LEADING_ENTRY',
} as const;

const signalsOf = (w: Watchlist, symbol: string) => w.entries.filter((e) => e.symbol === symbol).map((e) => e.signal);
const entryOf = (w: Watchlist, symbol: string) => w.entries.find((e) => e.symbol === symbol)!;

describe('buildWatchlist', () => {
  const series = universe({ assets: ASSETS });
  const w = buildWatchlist({ timeframe: '4h', series });

  test('finds each designed signal against both benchmarks', () => {
    for (const [symbol, signal] of Object.entries(DESIGNED)) {
      expect(signalsOf(w, symbol), symbol).toEqual([signal]);
      const e = entryOf(w, symbol);
      expect(e.firedOn).toEqual(['BTC', 'ETH']);
      expect(e.components.agreement).toBe(AGREEMENT.both);
      expect(e.direction).toBe(signal === 'SHORT_ROLLOVER' ? 'short' : 'long');
      expect(e.timeframe).toBe('4h');
      expect(e.tiers).toEqual(['MTF']);
      expect(e.reasons.length).toBeGreaterThan(0);
    }
    expect(signalsOf(w, 'FLATUSDT')).toEqual([]);
    expect(w.skipped).toEqual([]);
  });

  test('is ranked best first, scores 0-100', () => {
    expect(w.entries.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < w.entries.length; i++) expect(w.entries[i - 1]!.score).toBeGreaterThanOrEqual(w.entries[i]!.score);
    for (const e of w.entries) {
      expect(e.score).toBeGreaterThanOrEqual(0);
      expect(e.score).toBeLessThanOrEqual(100);
    }
  });

  test('flags the core symbols', () => {
    expect(entryOf(w, 'XRPUSDT').core).toBe(true);
    expect(entryOf(w, 'LEADUSDT').core).toBe(false);
    const custom = buildWatchlist({ timeframe: '4h', series, core: ['LEADUSDT'] });
    expect(entryOf(custom, 'LEADUSDT').core).toBe(true);
    expect(entryOf(custom, 'XRPUSDT').core).toBe(false);
  });

  test('does not mutate its inputs', () => {
    const frozen = Object.fromEntries(Object.entries(series).map(([k, s]) => [k, Object.freeze({
      ...s, close: Object.freeze([...s.close]), volume: s.volume && Object.freeze([...s.volume]),
    })])) as Record<string, SymbolSeries>;
    expect(buildWatchlist({ timeframe: '4h', series: frozen })).toEqual(w);
  });
});

describe('dual-benchmark agreement', () => {
  test('a benchmark is never read against itself; that slot counts as unavailable', () => {
    // ETH itself rotates up against BTC.
    const w = buildWatchlist({ timeframe: '4h', series: universe({ eth: pad(SCENARIOS.leadingEntry), assets: ASSETS }) });
    const eth = entryOf(w, 'ETHUSDT');
    expect(eth.signal).toBe('LEADING_ENTRY');
    expect(eth.firedOn).toEqual(['BTC']);
    expect(Object.keys(eth.readings)).toEqual(['BTC']);
    expect(eth.components.agreement).toBe(AGREEMENT.unavailable);
  });

  test('the other benchmark opposing drops agreement to 0 and the score with it', () => {
    const assets = { LEADUSDT: ASSETS.LEADUSDT! };
    const agreed = entryOf(buildWatchlist({ timeframe: '4h', series: universe({ assets }) }), 'LEADUSDT');
    // ETH accelerates over the same 4 bars the asset turns up on.
    const opposed = entryOf(buildWatchlist({
      timeframe: '4h', series: universe({ assets, eth: [{ bars: N - 4, rel: 0 }, { bars: 4, rel: 0.03 }] }),
    }), 'LEADUSDT');
    expect(opposed.signal).toBe('LEADING_ENTRY');
    expect(opposed.firedOn).toEqual(['BTC']);
    expect(opposed.readings.ETH!.quadrant).toBe('lagging');
    expect(opposed.components.agreement).toBe(AGREEMENT.opposed);
    expect(agreed.components.agreement).toBe(AGREEMENT.both);
    expect(opposed.score).toBeLessThan(agreed.score - 20);
  });

  test('conflicting signals across benchmarks are both listed, neither agreeing', () => {
    const w = buildWatchlist({
      timeframe: '4h',
      series: universe({ assets: { LEADUSDT: ASSETS.LEADUSDT! }, eth: [{ bars: N - 3, rel: 0 }, { bars: 3, rel: 0.03 }] }),
    });
    const lead = w.entries.filter((e) => e.symbol === 'LEADUSDT');
    expect(lead.map((e) => [e.signal, e.firedOn])).toEqual(expect.arrayContaining([
      ['LEADING_ENTRY', ['BTC']],
      ['SHORT_ROLLOVER', ['ETH']],
    ]));
    for (const e of lead) expect(e.components.agreement).toBe(AGREEMENT.opposed);
  });
});

describe('confirmation filters only ever move the score', () => {
  const base = universe({ assets: ASSETS });
  const loud = universe({
    assets: Object.fromEntries(Object.entries(ASSETS).map(([k, a]) => [k, { ...a, volumeSpike: 3, fundingAnnualizedPct: 60 }])),
  });
  const wBase = buildWatchlist({ timeframe: '4h', series: base });
  const wLoud = buildWatchlist({ timeframe: '4h', series: loud });

  test('same closes, very different volume and funding: identical RS readings and signals', () => {
    const key = (w: Watchlist) => w.entries
      .map((e) => ({ id: `${e.symbol}:${e.signal}`, firedOn: e.firedOn, readings: e.readings }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(key(wLoud)).toEqual(key(wBase));
  });

  test('...but the scores respond', () => {
    const lead = [entryOf(wBase, 'LEADUSDT'), entryOf(wLoud, 'LEADUSDT')] as const;
    expect(lead[0].components.relativeVolume).toBeLessThan(lead[1].components.relativeVolume);
    expect(lead[1].components.relativeVolume).toBe(1);
    expect(lead[1].filters.funding).toBe('crowded-long');
    expect(lead[1].components.funding).toBe(0); // crowded longs: bad for a long
    const roll = entryOf(wLoud, 'ROLLUSDT');
    expect(roll.components.funding).toBe(1); // ...good for a short
    expect(lead[0].score).not.toBe(lead[1].score);
  });
});

describe('windows are bars: the timeframe only changes routing', () => {
  const series = universe({ assets: ASSETS });
  const h1 = buildWatchlist({ timeframe: '1h', series });
  const d1 = buildWatchlist({ timeframe: '1d', series });
  const strip = (w: Watchlist) => w.entries.map(({ timeframe: _t, tiers: _r, ...rest }) => rest);

  test('the same bars give the same readings, signals and scores on 1H and daily', () => {
    expect(strip(h1)).toEqual(strip(d1));
  });

  test('1H signals go to LTF, except breakouts, which go mainly to MTF', () => {
    expect(entryOf(h1, 'LEADUSDT').tiers).toEqual(['LTF']);
    expect(entryOf(h1, 'BRKUSDT').tiers).toEqual(['MTF', 'LTF']);
    expect(entryOf(d1, 'LEADUSDT').tiers).toEqual(['MTF']);
    expect(entryOf(d1, 'BRKUSDT').tiers).toEqual(['MTF']);
    expect(routeSignal('SHORT_ROLLOVER', '4h')).toEqual(['MTF']);
  });

  test('the default windows are the dashboard Balanced preset, in bars', () => {
    expect({
      trendWindow: DEFAULT_CONFIG.trendWindow,
      momentumWindow: DEFAULT_CONFIG.momentumWindow,
      smoothing: DEFAULT_CONFIG.smoothing,
      tailLength: DEFAULT_CONFIG.tailLength,
    }).toEqual(RRG_PRESETS_BALANCED);
  });
});

describe('input checks', () => {
  const series = universe({ assets: { LEADUSDT: ASSETS.LEADUSDT!, FLATUSDT: ASSETS.FLATUSDT! } });

  test('the benchmarks are required and must be clean', () => {
    const { ETHUSDT: _, ...noEth } = series;
    expect(() => buildWatchlist({ timeframe: '4h', series: noEth })).toThrow(/ETHUSDT/);
    const badBtc = { ...series, BTCUSDT: { close: [...series.BTCUSDT!.close.slice(0, -1), Number.NaN] } };
    expect(() => buildWatchlist({ timeframe: '4h', series: badBtc })).toThrow(/BTCUSDT/);
    const shortEth = { ...series, ETHUSDT: { close: series.ETHUSDT!.close.slice(1) } };
    expect(() => buildWatchlist({ timeframe: '4h', series: shortEth })).toThrow(/same length/);
  });

  test('bad symbols are skipped with a reason, the rest still scan', () => {
    const w = buildWatchlist({
      timeframe: '4h',
      series: {
        ...series,
        SHORTUSDT: { close: series.LEADUSDT!.close.slice(1) },
        VOLUSDT: { close: series.LEADUSDT!.close, volume: [1, 2, 3] },
        ZEROUSDT: { close: series.LEADUSDT!.close.map((c, i) => (i === 10 ? 0 : c)) },
      },
    });
    expect(w.skipped).toEqual([
      { symbol: 'SHORTUSDT', reason: 'length-mismatch' },
      { symbol: 'VOLUSDT', reason: 'length-mismatch' },
      { symbol: 'ZEROUSDT', reason: 'bad-data' },
    ]);
    expect(signalsOf(w, 'LEADUSDT')).toEqual(['LEADING_ENTRY']);
  });

  test('too little history skips every symbol', () => {
    const short = Object.fromEntries(Object.entries(series).map(([k, s]) => [k, { ...s, close: s.close.slice(0, 20), volume: s.volume?.slice(0, 20) }]));
    const w = buildWatchlist({ timeframe: '4h', series: short });
    expect(w.entries).toEqual([]);
    expect(w.skipped.map((s) => s.reason)).toEqual(Object.keys(short).map(() => 'insufficient-history'));
  });

  test('config: windows must be whole bars; overrides merge', () => {
    expect(() => resolveConfig({ trendWindow: 2.5 })).toThrow(RangeError);
    expect(() => resolveConfig({ freshBars: 0 })).toThrow(RangeError);
    expect(() => resolveConfig({ relVolShortBars: 40 })).toThrow(RangeError);
    expect(() => resolveConfig({ weights: { ...DEFAULT_CONFIG.weights, funding: -1 } })).toThrow(RangeError);
    const c = resolveConfig({ weights: { ...DEFAULT_CONFIG.weights, agreement: 0.5 } });
    expect(c.weights.agreement).toBe(0.5);
    expect(c.weights.velocity).toBe(DEFAULT_CONFIG.weights.velocity);
  });
});
