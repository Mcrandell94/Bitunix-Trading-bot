import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { frameworkSetups } from '../src/screen/rsisignals';
import { RSI_FRAMEWORK } from '../src/screen/rsilen';

// Owner 2026-10-18: "Make sure nothing you do effect the bots potential weekly divergence calls". The weekly models'
// setups are pinned to what main gave before the research RSI-length switch (b0fc22f, the same data), and two guards keep
// that switch out of the live code: no worker file mentions it, and only the research CLI (portfolio.ts) sets it.

const DAY = 86_400_000;
/** The RSI framework test's seeded walk (rsisignals.test.ts): big swings, so the weekly RSI reaches its extremes. */
function walk(n: number, step: number, seed = 7): Candle[] {
  let s = seed, px = 100;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const t0 = Date.UTC(2023, 0, 2);
  return Array.from({ length: n }, (_, i) => {
    const drift = 0.04 * Math.sin(i / 37);
    const o = px;
    px = Math.max(1, px * (1 + drift + (rnd() - 0.5) * 0.12));
    return { openTime: t0 + i * step, open: o, high: Math.max(o, px) * (1 + rnd() * 0.02), low: Math.min(o, px) * (1 - rnd() * 0.02), close: px, volume: 1 };
  });
}

/** [model, known, entry bar, stop] of every weekly setup from main (b0fc22f) on walk(1400, DAY, seed). */
const PINNED: Record<number, [string, number, number, number][]> = {
  7: [['w-reclaim', 1696809600000, 280, 211.9435915], ['w-reclaim', 1716768000000, 511, 293.6952988], ['w-reclaim', 1737936000000, 756, 838.7103173], ['w-bear-div', 1744588800000, 833, 9365.288158], ['w-top-div', 1744588800000, 836, 8613.509279], ['w-reclaim', 1759104000000, 1001, 761.9632203], ['w-high-div', 1765152000000, 1073, 3474.110132], ['w-reclaim', 1777852800000, 1218, 432.0369498]],
  5: [['w-reclaim', 1696809600000, 280, 82.17831971], ['w-reclaim', 1717977600000, 525, 67.58661553], ['w-dbl-bottom', 1734307200000, 714, 21.98438981], ['w-reclaim', 1737331200000, 749, 35.78230154], ['w-reclaim', 1758499200000, 994, 82.41765003], ['w-dbl-bottom', 1775433600000, 1190, 23.94504603], ['w-reclaim', 1777248000000, 1211, 49.59791694]],
  23: [['w-reclaim', 1696809600000, 280, 185.6363329], ['w-reclaim', 1717977600000, 525, 314.1442069], ['w-reclaim', 1736726400000, 742, 398.5429226], ['w-dbl-bottom', 1754870400000, 952, 196.0902626], ['w-reclaim', 1757894400000, 987, 355.2247835], ['w-top-div', 1763942400000, 1064, 4200.709158], ['w-reclaim', 1777852800000, 1218, 376.9232508]],
};

const tsFiles = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : []; });
const here = fileURLToPath(new URL('.', import.meta.url));

describe('the weekly divergence calls are unchanged (pinned to main b0fc22f)', () => {
  test.each([7, 5, 23])('seed %i: the weekly models give main\'s setups', (seed) => {
    expect(RSI_FRAMEWORK.len).toBe(14);
    const got = frameworkSetups(walk(1400, DAY, seed), []).filter((x) => x.model.startsWith('w-')).map((x) => [x.model, x.known, x.j, Number(x.stop!.toPrecision(10))]);
    expect(got).toEqual(PINNED[seed]);
  });

  test('no worker code mentions the research RSI length', () => {
    const files = tsFiles(join(here, '../../worker/src'));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/RSI_FRAMEWORK|rsilen|rsi-len/);
  });

  test('only the research CLI sets it', () => {
    const setters = tsFiles(join(here, '../src')).filter((f) => /RSI_FRAMEWORK\.len\s*=[^=]/.test(readFileSync(f, 'utf8')));
    expect(setters.map((f) => f.split('/').at(-1))).toEqual(['portfolio.ts']);
  });
});
