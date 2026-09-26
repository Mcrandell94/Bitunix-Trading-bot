// Types for rrgMath.js, which is vendored byte-for-byte from the dashboard
// (see README.md). The .js file must stay unchanged; describe it here.
//
// Every window and count below is in BARS. The dashboard's comments say
// "days" because it only feeds it daily closes; the math itself indexes
// the arrays and never looks at timestamps.

export type Quadrant = 'leading' | 'weakening' | 'lagging' | 'improving';

export interface RrgPoint {
  /** RS-Ratio */
  x: number;
  /** RS-Momentum */
  y: number;
}

export interface RrgSettings {
  trendWindow: number;
  momentumWindow: number;
  zscore?: boolean;
  smoothing?: number;
}

export interface Heading {
  deg: number;
  arrow: string;
  dx: number;
  dy: number;
}

export interface RrgPreset {
  key: 'fast' | 'balanced' | 'steady';
  label: string;
  blurb: string;
  settings: { trendWindow: number; momentumWindow: number; smoothing: number; tailLength: number };
}

export const QUADRANT_ORDER: Quadrant[];
export function ema(arr: ReadonlyArray<number>, span: number): number[];
export function firstValidIndex(settings: { trendWindow: number; momentumWindow: number; smoothing?: number }): number;
export function computeSeries(asset: ReadonlyArray<number>, bench: ReadonlyArray<number>, settings: RrgSettings): RrgPoint[];
export function quadrantOf(x: number, y: number): Quadrant;
export function countFlips(pts: ReadonlyArray<RrgPoint>): number;
/** `days` is a count of points, i.e. bars on whatever timeframe was fed in. */
export function quadrantStreak(pts: ReadonlyArray<RrgPoint>): { days: number; from: Quadrant | null };
export function heading(pts: ReadonlyArray<RrgPoint>, lookback?: number): Heading | null;
export const RRG_PRESETS: RrgPreset[];
