// Deterministic synthetic markets for the classifier tests.
//
// BTC random-walks. ETH tracks BTC with its own small noise, so an asset
// that rotates against one benchmark rotates against both unless a test
// gives ETH its own relative path. Each asset is BTC times a relative path
// built from segments: `rel` is its per-bar return relative to BTC.
//
// Every series draws from its own noise stream, so a shorter spec is an
// exact prefix of a longer one: "the same market, N bars earlier" compares.

import type { SymbolSeries } from '../src/index';

export function lcg(seed: number): () => number {
  let s = Math.imul(seed, 0x9e3779b1) >>> 0; // spread nearby seeds apart
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export interface Segment {
  bars: number;
  /** Per-bar return relative to BTC, e.g. 0.01 = outperform by 1%/bar. */
  rel: number;
}

export const totalBars = (segments: ReadonlyArray<Segment>) => segments.reduce((a, s) => a + s.bars, 0);

function relativePath(segments: ReadonlyArray<Segment>, rnd: () => number, noise: number): number[] {
  const out: number[] = [];
  let p = 1;
  for (const seg of segments) {
    for (let i = 0; i < seg.bars; i++) {
      p *= 1 + seg.rel + (rnd() - 0.5) * noise;
      out.push(p);
    }
  }
  return out;
}

export interface AssetSpec {
  segments: ReadonlyArray<Segment>;
  /** Noise stream for this asset's relative path. Defaults to market seed + 2. */
  noiseSeed?: number;
  /** Volume multiplier on the last `volumeSpikeBars` bars. */
  volumeSpike?: number;
  volumeSpikeBars?: number;
  fundingAnnualizedPct?: number | null;
}

export interface UniverseSpec {
  assets: Readonly<Record<string, AssetSpec>>;
  /** ETH vs BTC; defaults to flat (ETH ≈ BTC). */
  eth?: ReadonlyArray<Segment>;
  seed?: number;
}

/** BTCUSDT, ETHUSDT and every asset in the spec, all the same length. */
export function universe(spec: UniverseSpec): Record<string, SymbolSeries> {
  const specs = Object.values(spec.assets);
  const n = totalBars(specs[0]!.segments);
  if (specs.some((a) => totalBars(a.segments) !== n)) throw new Error('fixture assets differ in length');
  const seed = spec.seed ?? 42;

  const btcRnd = lcg(seed);
  const btc: number[] = [];
  let b = 30000;
  for (let i = 0; i < n; i++) {
    b *= 1 + 0.001 + (btcRnd() - 0.5) * 0.04;
    btc.push(b);
  }
  const ethRel = relativePath(spec.eth ?? [{ bars: n, rel: 0 }], lcg(seed + 1), 0.004);

  const out: Record<string, SymbolSeries> = {
    BTCUSDT: { close: btc, volume: btc.map(() => 5000) },
    ETHUSDT: { close: btc.map((v, i) => (v / 15) * ethRel[i]!), volume: btc.map(() => 3000) },
  };
  for (const [symbol, a] of Object.entries(spec.assets)) {
    const noiseSeed = a.noiseSeed ?? seed + 2;
    const rel = relativePath(a.segments, lcg(noiseSeed), 0.006);
    const volRnd = lcg(noiseSeed + 1000);
    const spikeFrom = n - (a.volumeSpikeBars ?? 7);
    out[symbol] = {
      close: btc.map((v, i) => (v / 50000) * rel[i]!),
      volume: Array.from({ length: n }, (_, i) => (1000 + volRnd() * 100) * (i >= spikeFrom ? a.volumeSpike ?? 1 : 1)),
      fundingAnnualizedPct: a.fundingAnnualizedPct ?? null,
    };
  }
  return out;
}

/** A universe with one asset, ASSETUSDT. */
export function market(asset: AssetSpec, opts: Omit<UniverseSpec, 'assets'> = {}) {
  const u = universe({ ...opts, assets: { ASSETUSDT: asset } });
  return { BTCUSDT: u.BTCUSDT!, ETHUSDT: u.ETHUSDT!, ASSETUSDT: u.ASSETUSDT! };
}

/**
 * The scenarios, one per signal, as relative-performance regimes. Each
 * ends on the bar its signal fires for seed 42 (checked in classify.test.ts).
 */
export const SCENARIOS = {
  // Underperforms 0.6%/bar for 40 bars, then outperforms 1.2%/bar:
  // Lagging → Improving → Leading on the 3rd bar of the turn.
  leadingEntry: [{ bars: 40, rel: -0.006 }, { bars: 3, rel: 0.012 }],
  // Flat, a 3-bar capitulation (-3.5%/bar), then a sharp V (+4.5%/bar):
  // RS-Momentum crosses 100 on the first bar of the reversal.
  laggingBreakout: [{ bars: 45, rel: 0 }, { bars: 3, rel: -0.035 }, { bars: 1, rel: 0.045 }],
  // A capitulation with no reversal yet: RS-Ratio relaxes off its floor, so
  // it reads Lagging → Improving, but on a slow tail. Not a breakout.
  slowImprove: [{ bars: 40, rel: 0 }, { bars: 5, rel: -0.03 }],
  // Outperforms 15 bars, a 3-bar pullback into Weakening, then resumes.
  weakeningHook: [{ bars: 40, rel: 0 }, { bars: 15, rel: 0.012 }, { bars: 3, rel: -0.006 }, { bars: 2, rel: 0.015 }],
  // Outperforms 20 bars, then underperforms: Leading → Weakening → Lagging.
  rollover: [{ bars: 40, rel: 0 }, { bars: 20, rel: 0.012 }, { bars: 4, rel: -0.012 }],
  // Underperforms, a 4-bar bounce into Improving, then fails back to Lagging.
  failedImprove: [{ bars: 40, rel: 0 }, { bars: 15, rel: -0.012 }, { bars: 4, rel: 0.012 }, { bars: 3, rel: -0.015 }],
} satisfies Record<string, Segment[]>;

/** The same scenario with its last `bars` bars dropped. */
export function earlier(segments: ReadonlyArray<Segment>, bars: number): Segment[] {
  const out = segments.map((s) => ({ ...s }));
  let left = bars;
  while (left > 0) {
    const last = out[out.length - 1]!;
    const take = Math.min(left, last.bars);
    last.bars -= take;
    left -= take;
    if (last.bars === 0) out.pop();
  }
  return out;
}

/** The same scenario with its last regime running `bars` bars longer. */
export function later(segments: ReadonlyArray<Segment>, bars: number): Segment[] {
  const out = segments.map((s) => ({ ...s }));
  out[out.length - 1]!.bars += bars;
  return out;
}
