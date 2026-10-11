// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// TypeScript port of the campaign engine of "Wyckoff [theUltimator5]" (Pine Script v6). The copy the owner gave has no
// licence header; open TradingView scripts default to MPL-2.0, which this file follows. Ported for the owner's ETH card
// (2026-10-11). Only `f_engine` (the structure state machine) on one timeframe, with its hard-coded settings and the
// default "Standard" entry strictness. Left out: every drawing, the reference schematics, historical overlays and the
// higher-timeframe override (the card shows 4H and 1D side by side instead).
//
// Bar-for-bar notes (Pine semantics kept):
// - All ta.* series are computed on every bar, as the script does (f_engine runs at global scope each bar). NaN = na;
//   `nz` as Pine. Comparisons with NaN are false, as with na.
// - Pivots: ta.pivothigh / ta.pivotlow with the campaign's swing length (the ATR-adaptive length 2-10 while no
//   campaign is active), evaluated on each bar with that bar's length (pine.ts taPivot).
// - `time` is the bar's open time; pivots carry the pivot bar's open time. Bars are closed bars (commit = true).
// - Volume: Bitunix quote volume turned into coin units with each bar's typical price (TradingView's crypto volume).
// - syminfo.mintick = `tick` (0.01 for ETHUSDT).
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, nz, taAtr, taHighest, taLowest, taPivot, taSma, taSum } from './pine';

const na = Number.isNaN;
export const W = {
  pivotLen: 4, adaptiveSwingMin: 2, adaptiveSwingMax: 10, adaptiveSwingVolLen: 50, trendLen: 25, priorTrendMaxBars: 200, priorTrendPivotFactor: 8.0,
  priorTrendStrong: 35.0, priorTrendNeutral: 15.0, continuationTrendLen: 200, oppositeCycleMinBars: 25, extremeLen: 30,
  phaseAMinBars: 6, phaseAAfterArMaxBars: 45, phaseBIdleMaxBars: 125, phaseCIdleMaxBars: 50, phaseAPrematureDepartureBars: 3, phaseAPrematureDepartureTRFrac: 0.30,
  phaseAPrematureDepartureATR: 0.75, structureInvalidationATR: 0.50, structureInvalidationBars: 2, phaseBDepartureBars: 3, phaseBDepartureTRFrac: 0.35, phaseBDepartureATR: 0.75,
  phaseDFailBars: 3, phaseEMaxBars: 300, volLen: 50, atrLen: 14, climaxVolMult: 1.8, climaxSpreadMult: 1.5, relaxedClimaxFactor: 0.80, prelimVolMult: 1.25,
  prelimExtremeATR: 0.75, prelimEfficiencyLookback: 10, prelimEfficiencyRatio: 0.80, prelimMinScore: 4, scCloseMin: 0.35, bcCloseMax: 0.65, climaxMinScore: 5,
  climaxAbsorptionMinBars: 3, climaxAbsorptionMaxBars: 8, climaxAbsorptionExtremeATR: 0.50, climaxAbsorptionReboundATR: 0.35, climaxAbsorptionVolFloor: 0.90,
  minARATR: 2.0, maxARBars: 30, arMaxExtensionATR: 15.0, boundaryTolATR: 0.75, stMaxVolRatio: 0.90, stMaxSpreadRatio: 0.90, stMinScore: 4, minPhaseBBars: 30,
  minPhaseBTests: 2, minPhaseBOppositeTests: 1, minPhaseBTraversals: 2, phaseBZoneFrac: 0.25, phaseBRangeMinATR: 1.5, phaseBRangeMaxATR: 8.0,
  phaseBBadTestCooldownFactor: 2.0, phaseBEdgeExpansionCap: 0.15, terminalTestMinBarsAfterST: 3, terminalTestVolRatio: 0.85, terminalTestSpreadRatio: 0.85,
  terminalTestOtherMaxRatio: 1.05, excursionRecoveryBars: 3, springMinPenATR: 0.15, springMaxPenATR: 2.5, springCloseMin: 0.55, utadCloseMax: 0.45,
  springEffortMaxMult: 1.50, excursionMinScore: 3, testTolATR: 1.25, testMaxVolRatio: 0.80, testMaxSpreadRatio: 0.80, testExtremeToleranceATR: 0.15, testMinScore: 2,
  phaseCToDMinBars: 3, phaseDMinBars: 4, phaseDValidationMin: 60, phaseDDominanceFrac: 0.65, breakATR: 0.15, strengthVolMult: 1.15, strengthSpreadATR: 1.15,
  sosCloseMin: 0.65, sowCloseMax: 0.35, strengthMinScore: 3, sosMultiBarLen: 5, sosMultiBarATR: 2.0, sosMultiBarEffort: 1.10, lpsBoundaryATR: 1.50, lpsVolMult: 1.00,
  lpsSpreadATR: 1.00, lpsMinScore: 2, confirmBars: 3, directAcceptanceBars: 5, directAcceptanceConfidence: 75, minConfidencePhaseC: 45, minConfidencePhaseD: 55,
  entryMinConfidenceStandard: 60, entryMinTestsStandard: 6,
} as const;

export const DIR_NONE = 0, DIR_ACCUM = 1, DIR_DIST = -1;
export const TYPE_NONE = 0, TYPE_ACCUM = 1, TYPE_REACCUM = 2, TYPE_DIST = -1, TYPE_REDIST = -2;
const REGIME_NONE = 0, REGIME_MARKUP = 1, REGIME_MARKDOWN = -1;
export const PHASE_NONE = 0, PHASE_A = 1, PHASE_B = 2, PHASE_C = 3, PHASE_D = 4, PHASE_E = 5;
export const EV = { NONE: 0, SC: 1, BC: 2, AR: 3, ST: 4, SPRING: 5, UTAD: 6, TEST: 7, SOS: 8, SOW: 9, LPS: 10, LPSY: 11, CTEST_ACC: 12, CTEST_DST: 13, MARKUP: 14, MARKDOWN: 15 } as const;
const TEST_NONE = 0, TEST_GOOD = 1, TEST_POOR = 2, TEST_FAILED = 3;
export const ENTRY_NONE = 0, ENTRY_TEST = 1, ENTRY_STRENGTH = 2, ENTRY_LPS = 3;
export const BIT = { PS: 1, SC: 2, BC: 4, AR: 8, ST: 16, SPRING: 32, UTAD: 64, TEST: 128, SOS: 256, SOW: 512, LPS: 1024, LPSY: 2048, E: 4096, CTEST: 16384 } as const;

interface Triplet { b1: number; t1: number; p1: number; b2: number; t2: number; p2: number; b3: number; t3: number; p3: number }
const triplet = (): Triplet => ({ b1: NaN, t1: NaN, p1: NaN, b2: NaN, t2: NaN, p2: NaN, b3: NaN, t3: NaN, p3: NaN });

/** The campaign state (the script's `WS` type); NaN = na. */
export class WS {
  stopSide = 0; outcome = 0; phase = 0; ev = 0; startBar = NaN; pivLen = NaN; birthTrend = NaN; ctxBull = false; ctxBear = false;
  climaxBar = NaN; climaxTime = NaN; climaxPrice = NaN; climaxEff = NaN; climaxSpr = NaN; climaxATR = NaN; climaxScore = 0; absorbed = false;
  psTime = NaN; psPrice = NaN; psScore = 0; origHigh = NaN; origLow = NaN; rangeHigh = NaN; rangeLow = NaN;
  arRunPrice = NaN; arRunBar = NaN; arRunTime = NaN; arOK = false; arBar = NaN; arTime = NaN; arPrice = NaN;
  stCount = 0; stN = 0; stEffSum = 0; stSprSum = 0; lastGoodEff = NaN; lastGoodSpr = NaN; stBar = NaN; stTime = NaN; stPrice = NaN; stHist = triplet(); stScore = 0;
  edge1 = NaN; edge2 = NaN; edge3 = NaN; oppCount = 0; opN = 0; opEffSum = 0; opSprSum = 0; opLastBar = NaN; opLastPrice = NaN; opHist = triplet();
  travCount = 0; lastZone = 0; lastZoneBar = NaN; lastBadBar = NaN; bStartBar = NaN; bStartTime = NaN; cStartTime = NaN; cReadyBar = NaN;
  dStartBar = NaN; dStartTime = NaN; eStartBar = NaN; eStartTime = NaN;
  pend = false; pendEdge = 0; pendStartBar = NaN; pendExtBar = NaN; pendExt = NaN; pendExtTime = NaN; pendEff = NaN; pendSpr = NaN; pendCoolBar = NaN;
  provEdge = 0; provBar = NaN; provPrice = NaN; provTime = NaN; provEff = NaN; provSpr = NaN; provScore = 0;
  exc = false; excTested = false; excBar = NaN; excPrice = NaN; excTime = NaN; excEff = NaN; excSpr = NaN; excScore = 0;
  testTime = NaN; testPrice = NaN; testScore = 0; strBar = NaN; strTime = NaN; strPrice = NaN; strScore = 0;
  lpsTime = NaN; lpsPrice = NaN; lpsBar = NaN; lpsScore = 0;
  entryTime = NaN; entryPrice = NaN; entryKind = 0; outCount = 0; lastEventBar = NaN; lastEventTime = NaN; lastEventPrice = NaN; lastActBar = NaN;
  cfPrior = false; cfClimax = false; cfAR = false; cfST = false; cfExc = false; cfTest = false; cfStrength = false; cfLPS = false; cfAccept = false;
}

/** The engine's output after one bar. */
export interface WyckoffBar {
  stop: number; outcome: number; wdir: number; type: number; phase: number; ev: number; conf: number; val: number;
  rangeHigh: number; rangeLow: number; sig: number; entryTime: number; entryPrice: number; entryKind: number; lastEventTime: number; lastEventPrice: number;
  /** The Spring / UTAD extreme while one is on file (NaN otherwise). */
  exc: number;
}
export type ResetWhy = 'invalid' | 'no absorption' | 'no range' | 'left range' | 'stale' | 'phase E ended';
export interface WyckoffResult {
  bars: WyckoffBar[];
  /** The campaign at the last bar (its events with times and prices) and the script's "Next" text. */
  state: WS;
  next: string;
  /** Every entry label the engine confirmed, in order (the chart keeps them after resets). */
  entries: { time: number; price: number; dir: number; kind: number }[];
  /** Campaign resets by reason (the script's diagnostics), demotions from D to B, and the last reset. */
  resets: Record<ResetWhy | 'demoted', number>;
  lastReset: ResetWhy | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const hasBit = (mask: number, bit: number) => Math.floor(mask / bit) % 2 === 1;
const addBit = (mask: number, bit: number) => (hasBit(mask, bit) ? mask : mask + bit);
const round = (x: number) => Math.round(x);

export function phaseName(p: number): string {
  return p === PHASE_A ? 'A - Stopping action' : p === PHASE_B ? 'B - Building cause' : p === PHASE_C ? 'C - Test' : p === PHASE_D ? 'D - Trend within range' : p === PHASE_E ? 'E - Trend out of range' : 'None';
}
export function eventName(e: number): string {
  const n: Record<number, string> = { 1: 'SC', 2: 'BC', 3: 'AR', 4: 'ST', 5: 'Spring', 6: 'UTAD', 7: 'Test', 8: 'SOS', 9: 'SOW', 10: 'LPS', 11: 'LPSY', 12: 'Terminal test (support)', 13: 'Terminal test (resistance)', 14: 'Markup', 15: 'Markdown' };
  return n[e] ?? '-';
}
export function typeName(t: number): string {
  return t === TYPE_REACCUM ? 'Reaccumulation' : t === TYPE_REDIST ? 'Redistribution' : t === TYPE_ACCUM ? 'Accumulation' : t === TYPE_DIST ? 'Distribution' : 'Searching';
}
export const entryKindName = (k: number) => (k === ENTRY_TEST ? 'Phase C Test' : k === ENTRY_STRENGTH ? 'SOS/SOW' : k === ENTRY_LPS ? 'LPS/LPSY' : 'Entry');

/** The engine over closed bars `c` (oldest first) of a timeframe `barMs` long. */
export function wyckoff(c: ReadonlyArray<Candle>, barMs: number, tick = 0.01): WyckoffResult {
  const n = c.length, K = W;
  const high = c.map((b) => b.high), low = c.map((b) => b.low), close = c.map((b) => b.close), open = c.map((b) => b.open), time = c.map((b) => b.openTime);
  const vol = coinVolume(c).map((v) => nz(v));
  let cum = 0;
  const noVol = vol.map((v) => (cum += v) <= 0);
  const spr = c.map((b) => Math.max(b.high - b.low, tick));
  const eff = vol.map((v, i) => (noVol[i] ? spr[i]! : v));
  const avgEffRaw = taSma(eff, K.volLen), atrRaw = taAtr(c, K.atrLen);
  const aS = atrRaw.map((x, i) => nz(x, spr[i]!));
  const aBase = taSma(aS, K.adaptiveSwingVolLen);
  const liveLenS = aS.map((a, i) => { const r = nz(aBase[i]!) > 0 ? a / aBase[i]! : 1.0; return Math.max(K.adaptiveSwingMin, Math.min(K.adaptiveSwingMax, round(K.pivotLen * r))); });
  const recentEffS = taSma(eff, K.climaxAbsorptionMinBars), recentLowS = taLowest(low, K.climaxAbsorptionMinBars), recentHighS = taHighest(high, K.climaxAbsorptionMinBars);
  const lo30 = taLowest(low, K.extremeLen), hi30 = taHighest(high, K.extremeLen), effHi30 = taHighest(eff, K.extremeLen);
  const longSmaS = taSma(close, K.continuationTrendLen);
  const unitS = aS.map((a) => Math.max(a, tick));
  const avgEffS = avgEffRaw.map((x, i) => nz(x, eff[i]!));
  const relES = eff.map((e, i) => e / Math.max(avgEffS[i]!, 1e-10));
  const sprATRS = spr.map((s, i) => s / unitS[i]!);
  const effort2 = relES.map((r, i) => Math.max(r, 0.01) * Math.max(sprATRS[i]!, 0.01));
  const dnEffc = close.map((cl, i) => Math.max(nz(i > 0 ? close[i - 1]! : NaN, cl) - cl, 0) / unitS[i]! / effort2[i]!);
  const upEffc = close.map((cl, i) => Math.max(cl - nz(i > 0 ? close[i - 1]! : NaN, cl), 0) / unitS[i]! / effort2[i]!);
  const dnBaseS = taSma(dnEffc, K.prelimEfficiencyLookback), upBaseS = taSma(upEffc, K.prelimEfficiencyLookback);
  const hiCInvS = taHighest(close, K.structureInvalidationBars), loCInvS = taLowest(close, K.structureInvalidationBars);
  const hiCDepS = taHighest(close, K.phaseBDepartureBars), loCDepS = taLowest(close, K.phaseBDepartureBars);
  const hiCAS = taHighest(close, K.phaseAPrematureDepartureBars), loCAS = taLowest(close, K.phaseAPrematureDepartureBars);
  const hiCConfS = taHighest(close, K.confirmBars), loCConfS = taLowest(close, K.confirmBars);
  const hiCDirS = taHighest(close, K.directAcceptanceBars), loCDirS = taLowest(close, K.directAcceptanceBars);
  const hiCFailS = taHighest(close, K.phaseDFailBars), loCFailS = taLowest(close, K.phaseDFailBars);
  const mbLowS = taLowest(low, K.sosMultiBarLen), mbHighS = taHighest(high, K.sosMultiBarLen), effSum5 = taSum(eff, K.sosMultiBarLen);
  const phS = new Array<number>(n).fill(NaN), plS = new Array<number>(n).fill(NaN);
  const at = (xs: ReadonlyArray<number>, i: number) => (i >= 0 && i < n ? xs[i]! : NaN);

  let s = new WS();
  let regime = REGIME_NONE, regimeBar = NaN, prelimBar = NaN, prelimTime = NaN, prelimPrice = NaN, prelimDir = DIR_NONE, prelimScore = 0, lastPLBar = NaN, lastPHBar = NaN;
  const bars: WyckoffBar[] = [], entries: WyckoffResult['entries'] = [];
  const resets: Record<ResetWhy | 'demoted', number> = { invalid: 0, 'no absorption': 0, 'no range': 0, 'left range': 0, stale: 0, 'phase E ended': 0, demoted: 0 };
  let lastReset: ResetWhy | null = null;
  let i = 0;

  // ---- helpers bound to the current bar i ----
  const setEvent = (ev: number) => { s.ev = ev; s.lastEventBar = i; s.lastEventTime = time[i]!; s.lastEventPrice = close[i]!; s.lastActBar = i; };
  const biasDir = (w: WS) => (w.stopSide === DIR_ACCUM ? (w.ctxBear ? DIR_DIST : DIR_ACCUM) : w.stopSide === DIR_DIST ? (w.ctxBull ? DIR_ACCUM : DIR_DIST) : DIR_NONE);
  const typeFrom = (stop: number, out: number, bull: boolean, bear: boolean) =>
    out === DIR_ACCUM ? (stop === DIR_DIST || bull ? TYPE_REACCUM : TYPE_ACCUM) : out === DIR_DIST ? (stop === DIR_ACCUM || bear ? TYPE_REDIST : TYPE_DIST) : TYPE_NONE;
  const typeWS = (w: WS) => { const o = w.outcome !== DIR_NONE ? w.outcome : biasDir(w); return w.stopSide === DIR_NONE ? TYPE_NONE : typeFrom(w.stopSide, o, w.ctxBull, w.ctxBear); };
  const rangeATR = (w: WS, atrNow: number) => (!na(w.rangeHigh) && !na(w.rangeLow) ? Math.abs(w.rangeHigh - w.rangeLow) / Math.max(nz(w.climaxATR, atrNow), tick) : 0.0);
  const hardLevel = (w: WS, side: number) => side === DIR_ACCUM
    ? (w.exc && w.outcome === DIR_ACCUM && !na(w.excPrice) ? w.excPrice : na(w.origLow) ? w.rangeLow : Math.min(w.origLow, nz(w.rangeLow, w.origLow)))
    : (w.exc && w.outcome === DIR_DIST && !na(w.excPrice) ? w.excPrice : na(w.origHigh) ? w.rangeHigh : Math.max(w.origHigh, nz(w.rangeHigh, w.origHigh)));
  const robustEdge = (e1: number, e2: number, e3: number, orig: number, isLow: boolean) => {
    let med = NaN;
    if (!na(e1) && !na(e2) && !na(e3)) med = e1 + e2 + e3 - Math.max(e1, e2, e3) - Math.min(e1, e2, e3);
    else if (!na(e1) && !na(e2)) med = ((e1 + e2) / 2 + orig) / 2;
    else if (!na(e1)) med = (e1 + orig) / 2;
    return na(med) ? orig : isLow ? Math.max(orig, med) : Math.min(orig, med);
  };
  const pushTriplet = (h: Triplet, pb: number, t: number, p: number) => {
    if (na(h.t1)) { h.b1 = pb; h.t1 = t; h.p1 = p; }
    else if (na(h.t2) && pb > nz(h.b1, -1)) { h.b2 = pb; h.t2 = t; h.p2 = p; }
    else if (na(h.t3) && pb > nz(h.b2, nz(h.b1, -1))) { h.b3 = pb; h.t3 = t; h.p3 = p; }
  };
  const seed = (side: number, score: number, pLen: number, trend: number, bull: boolean, bear: boolean, atrNow: number, effNow: number, sprNow: number) => {
    s.stopSide = side; s.phase = PHASE_A; s.startBar = i; s.pivLen = pLen; s.birthTrend = trend; s.ctxBull = bull; s.ctxBear = bear;
    s.climaxBar = i; s.climaxTime = time[i]!; s.climaxPrice = side === DIR_ACCUM ? low[i]! : high[i]!; s.climaxEff = effNow; s.climaxSpr = sprNow; s.climaxATR = atrNow; s.climaxScore = score;
    if (side === DIR_ACCUM) { s.origLow = low[i]!; s.rangeLow = low[i]!; } else { s.origHigh = high[i]!; s.rangeHigh = high[i]!; }
    s.cfPrior = true;
    setEvent(side === DIR_ACCUM ? EV.SC : EV.BC);
  };
  const freezeAR = () => {
    s.arBar = s.arRunBar; s.arTime = s.arRunTime; s.arPrice = s.arRunPrice; s.cfAR = true;
    if (s.stopSide === DIR_ACCUM) { s.origHigh = s.arRunPrice; s.rangeHigh = s.arRunPrice; } else { s.origLow = s.arRunPrice; s.rangeLow = s.arRunPrice; }
  };
  const registerST = (price: number, t: number, pb: number, e: number, sp: number, score: number) => {
    s.stCount++; s.stN++; s.stEffSum += e; s.stSprSum += sp; s.lastGoodEff = e; s.lastGoodSpr = sp; s.stBar = pb; s.stTime = t; s.stPrice = price;
    pushTriplet(s.stHist, pb, t, price);
    s.stScore = score; s.edge3 = s.edge2; s.edge2 = s.edge1; s.edge1 = price;
    if (s.stopSide === DIR_ACCUM) s.rangeLow = robustEdge(s.edge1, s.edge2, s.edge3, s.origLow, true);
    else s.rangeHigh = robustEdge(s.edge1, s.edge2, s.edge3, s.origHigh, false);
    s.cfST = true;
    setEvent(EV.ST);
  };
  const registerOpp = (price: number, t: number, pb: number, e: number, sp: number) => {
    s.oppCount++; s.opN++; s.opEffSum += e; s.opSprSum += sp; s.opLastBar = pb; s.opLastPrice = price;
    pushTriplet(s.opHist, pb, t, price);
    s.lastActBar = i;
  };
  const clearTerminal = () => {
    s.exc = false; s.excTested = false; s.excBar = NaN; s.excPrice = NaN; s.excTime = NaN; s.excEff = NaN; s.excSpr = NaN; s.excScore = 0;
    s.testTime = NaN; s.testPrice = NaN; s.testScore = 0; s.cfExc = false; s.cfTest = false; s.cReadyBar = NaN; s.cStartTime = NaN;
  };
  const excFromPend = (score: number) => {
    s.exc = true; s.excTested = false; s.excBar = s.pendExtBar; s.excPrice = s.pendExt; s.excTime = s.pendExtTime; s.excEff = s.pendEff; s.excSpr = s.pendSpr; s.excScore = score;
    s.cfExc = true; s.outcome = s.pendEdge; s.cStartTime = s.pendExtTime; s.phase = PHASE_C; s.cReadyBar = NaN; s.pend = false; s.provEdge = 0;
    setEvent(s.outcome === DIR_ACCUM ? EV.SPRING : EV.UTAD);
  };
  const adoptProv = () => {
    s.exc = true; s.excTested = false; s.excBar = s.provBar; s.excPrice = s.provPrice; s.excTime = s.provTime; s.excEff = s.provEff; s.excSpr = s.provSpr; s.excScore = s.provScore;
    s.cfExc = true; s.outcome = s.provEdge; s.cStartTime = s.provTime; s.provEdge = 0;
  };
  const enterCTest = (outc: number, t: number, price: number, score: number) => {
    s.phase = PHASE_C; s.outcome = outc; s.cStartTime = t; s.cReadyBar = i; s.testTime = t; s.testPrice = price; s.testScore = score; s.cfTest = true; s.pend = false;
    setEvent(outc === DIR_ACCUM ? EV.CTEST_ACC : EV.CTEST_DST);
  };
  const promoteD = (outc: number, score: number, price: number) => {
    s.outcome = outc; s.phase = PHASE_D; s.dStartBar = i; s.dStartTime = time[i]!; s.strBar = i; s.strTime = time[i]!; s.strPrice = price; s.strScore = score;
    s.cfStrength = true; s.pend = false; s.outCount = 0;
    setEvent(outc === DIR_ACCUM ? EV.SOS : EV.SOW);
  };
  const demoteToB = () => {
    clearTerminal();
    s.outcome = DIR_NONE; s.phase = PHASE_B; s.strBar = NaN; s.strTime = NaN; s.strPrice = NaN; s.strScore = 0; s.lpsTime = NaN; s.lpsPrice = NaN; s.lpsBar = NaN; s.lpsScore = 0;
    s.dStartBar = NaN; s.dStartTime = NaN; s.cfStrength = false; s.cfLPS = false; s.provEdge = 0; s.pend = false; s.outCount = 0; s.lastBadBar = i; s.lastActBar = i;
  };
  const confWS = (w: WS) => {
    const cDone = w.cfTest || (w.cfExc && w.cfStrength);
    return (w.cfPrior ? 10 : 0) + (w.cfClimax ? 15 : 0) + (w.cfAR ? 10 : 0) + (w.cfST ? 15 : 0) + (cDone ? 15 : 0) + (w.cfStrength ? 15 : 0) + (w.cfLPS ? 10 : 0) + (w.cfAccept ? 10 : 0);
  };
  const validationScore = (trend: number, absorbed: boolean, rATR: number, st: number, opp: number, trav: number, clean: boolean, cause: number, terminal: boolean, strength: boolean, lps: boolean) => {
    let v = 0;
    v += Math.abs(trend) >= K.priorTrendStrong ? 10 : Math.abs(trend) >= K.priorTrendNeutral ? 5 : 0;
    v += absorbed ? 15 : 0;
    if (rATR >= K.phaseBRangeMinATR && rATR <= K.phaseBRangeMaxATR) v += 10;
    else if (rATR >= K.phaseBRangeMinATR * 0.75 && rATR <= K.phaseBRangeMaxATR * 1.5) v += 5;
    v += st >= K.minPhaseBTests ? 15 : st >= 1 ? 8 : 0;
    v += opp >= 1 && trav >= 2 ? 15 : opp >= 1 || trav >= 1 ? 8 : 0;
    v += clean ? 10 : 0;
    v += cause >= 3.0 ? 10 : cause >= 1.5 ? 5 : 0;
    v += terminal ? 10 : 0;
    v += strength ? 3 : 0;
    v += lps ? 2 : 0;
    return Math.min(v, 100);
  };
  const causeUnits = (trav: number, bAge: number, p: number, rATR: number) => bAge / Math.max(p * 6.0, 1.0) + trav * 0.5 + (rATR >= K.phaseBRangeMinATR ? 0.5 : 0.0);
  const testClass = (near: boolean, holds: boolean, closeOK: boolean, e: number, sp: number, cE: number, cS: number) =>
    !near ? TEST_NONE : !holds ? TEST_FAILED : closeOK && e <= cE * K.stMaxVolRatio && sp <= cS * K.stMaxSpreadRatio ? TEST_GOOD : TEST_POOR;
  const phaseAMin = (p: number) => Math.max(K.phaseAMinBars, Math.max(p, 1) * 2);
  const phaseBMin = (p: number, rATR: number) => { const q = Math.max(p, 1); const raw = Math.trunc(round(Math.max(q * 6, rATR * q * 1.0))); return Math.max(K.minPhaseBBars, Math.min(raw, K.minPhaseBBars * 2)); };
  const phaseCToDMin = (p: number) => Math.max(K.phaseCToDMinBars, Math.trunc(Math.max(p, 1) / 2));
  const phaseDMin = (p: number) => Math.max(K.phaseDMinBars, Math.max(p, 1));
  const excRecLimit = (p: number) => Math.max(K.excursionRecoveryBars, Math.trunc(round(Math.max(p, 1) * 0.75)));
  const idleLimit = (phase: number, hasAR: boolean, p: number) => {
    const q = Math.max(p, 1);
    return phase === PHASE_A ? (hasAR ? Math.max(K.phaseAAfterArMaxBars, q * 6) : Math.max(K.maxARBars, q * 4))
      : phase === PHASE_B ? Math.max(K.phaseBIdleMaxBars, q * 20) : phase === PHASE_C ? Math.max(K.phaseCIdleMaxBars, q * 8) : phase === PHASE_D ? Math.max(K.phaseCIdleMaxBars * 2, q * 16) : NaN;
  };
  const characterImproving = (cnt: number, effSum: number, sprSum: number, lastE: number, lastS: number) =>
    cnt >= 2 && !na(lastE) && !na(lastS) && lastE <= effSum / cnt && lastS <= (sprSum / cnt) * 1.05;
  const validationWS = (w: WS, p: number, trendNow: number, atrNow: number) => {
    const rATR = rangeATR(w, atrNow), bAge = !na(w.bStartBar) ? Math.max(i - w.bStartBar, 0) : 0, badAge = na(w.lastBadBar) ? -1 : i - w.lastBadBar;
    const clean = badAge < 0 || badAge >= round(p * K.phaseBBadTestCooldownFactor), cause = causeUnits(w.travCount, bAge, p, rATR);
    const terminal = (w.cfTest && (!w.exc || w.excTested)) || (w.cfExc && w.cfStrength);
    return w.stopSide === DIR_NONE ? 0 : validationScore(nz(w.birthTrend, trendNow), w.absorbed, rATR, w.stCount, w.oppCount, w.travCount, clean, cause, terminal, w.cfStrength, w.cfLPS);
  };
  const matureWS = (w: WS, p: number, atrNow: number) => {
    const rATR = rangeATR(w, atrNow), bAge = !na(w.bStartBar) ? i - w.bStartBar : 0, bMin = phaseBMin(p, rATR), badAge = na(w.lastBadBar) ? -1 : i - w.lastBadBar;
    const clean = badAge < 0 || badAge >= round(p * K.phaseBBadTestCooldownFactor);
    const opp = w.oppCount >= K.minPhaseBOppositeTests, trav = w.travCount >= K.minPhaseBTraversals;
    const ch = characterImproving(w.stN, w.stEffSum, w.stSprSum, w.lastGoodEff, w.lastGoodSpr);
    const support = (opp ? 1 : 0) + (trav ? 1 : 0) + (clean ? 1 : 0) + (ch ? 1 : 0);
    const sane = rATR >= K.phaseBRangeMinATR * 0.75 && rATR <= K.phaseBRangeMaxATR * 2.0;
    return w.phase === PHASE_B && bAge >= bMin && w.stCount >= K.minPhaseBTests && sane && support >= 2;
  };
  const entryReadiness = (w: WS, minConf: number, valFloor: number, atrNow: number) => {
    const bull = w.outcome === DIR_ACCUM, u = Math.max(atrNow, tick);
    const distATR = na(w.rangeHigh) || na(w.rangeLow) ? 99.0 : bull ? (close[i]! - w.rangeHigh) / u : (w.rangeLow - close[i]!) / u;
    const ageBars = !na(w.lastEventTime) ? (time[i]! - w.lastEventTime) / Math.max(barMs, 1.0) : 999.0;
    const terminal = (w.exc && w.excTested) || (!w.exc && w.cfTest);
    let r = 0;
    r += w.outcome !== DIR_NONE ? 1 : 0;
    r += w.phase >= PHASE_C ? 1 : 0;
    r += terminal ? 1 : 0;
    r += w.cfStrength ? 1 : 0;
    r += w.cfLPS ? 1 : 0;
    r += confWS(w) >= minConf ? 1 : 0;
    r += validationWS(w, nz(w.pivLen, K.pivotLen), w.birthTrend, atrNow) >= valFloor ? 1 : 0;
    r += distATR <= 2.0 ? 1 : 0;
    r += ageBars <= 50.0 ? 1 : 0;
    return r;
  };
  const priorTrendScore = (nn: number, endOff: number) => {
    const m = Math.max(nn, 2), e = Math.max(endOff, 0), cEnd = at(close, i - e), cStart = at(close, i - e - m);
    if (na(cEnd) || na(cStart)) return 0.0;
    const unitA = Math.max(nz(at(aS, i - e), aS[i]!), tick), net = cEnd - cStart;
    const disp = clamp(net / (unitA * Math.sqrt(m)), -3.0, 3.0) * 15.0;
    let path = 0, hh = 0, ll = 0, lh = 0, hl = 0, lastPH = NaN, lastPL = NaN;
    for (let k = m - 1; k >= 0; k--) {
      const o = e + k, co = nz(at(close, i - o));
      path += Math.abs(co - nz(at(close, i - o - 1), co));
      const vph = at(phS, i - o), vpl = at(plS, i - o);
      if (!na(vph)) { if (!na(lastPH)) { hh += vph > lastPH ? 1 : 0; lh += vph < lastPH ? 1 : 0; } lastPH = vph; }
      if (!na(vpl)) { if (!na(lastPL)) { hl += vpl > lastPL ? 1 : 0; ll += vpl < lastPL ? 1 : 0; } lastPL = vpl; }
    }
    const er = path > 0 ? Math.abs(net) / path : 0.0, erPart = (net >= 0 ? 1.0 : -1.0) * er * 25.0, swings = hh + ll + lh + hl;
    const swingPart = swings > 0 ? ((hh + hl - lh - ll) / swings) * 20.0 : 0.0;
    const smaEnd = at(longSmaS, i - e), smaStart = at(longSmaS, i - e - m);
    const smaPart = !na(smaEnd) && !na(smaStart) ? (smaEnd > smaStart ? 10.0 : smaEnd < smaStart ? -10.0 : 0.0) : 0.0;
    return clamp(disp + erPart + swingPart + smaPart, -100.0, 100.0);
  };

  // The script's "Next" line (f_describe, the first part) for the campaign at the last bar.
  const describeNext = (w: WS, p: number, reg: number, iNow: number): string => {
    const sideTxt = w.stopSide === DIR_ACCUM ? 'SC' : 'BC', campAge = !na(w.startBar) ? iNow - w.startBar : 0;
    const rATR = rangeATR(w, aS[iNow]!);
    if (w.phase === PHASE_A) return !w.absorbed ? `Confirming stopping action after the ${sideTxt}` : !w.arOK ? `Waiting for AR (${K.minARATR.toFixed(1)} ATR counter-move)` : 'Waiting for confirming ST (AR provisional)';
    if (w.phase === PHASE_B) {
      const bAge = !na(w.bStartBar) ? iNow - w.bStartBar : 0, bMin = phaseBMin(p, rATR), cool = round(p * K.phaseBBadTestCooldownFactor), badAge = na(w.lastBadBar) ? -1 : iNow - w.lastBadBar;
      const sup = (w.oppCount >= K.minPhaseBOppositeTests ? 1 : 0) + (w.travCount >= K.minPhaseBTraversals ? 1 : 0) + (badAge < 0 || badAge >= cool ? 1 : 0) + (characterImproving(w.stN, w.stEffSum, w.stSprSum, w.lastGoodEff, w.lastGoodSpr) ? 1 : 0);
      const sane = rATR >= K.phaseBRangeMinATR * 0.75 && rATR <= K.phaseBRangeMaxATR * 2.0;
      let blockers = '';
      if (w.stCount < K.minPhaseBTests) blockers += `tests ${w.stCount}/${K.minPhaseBTests}  `;
      if (bAge < bMin) blockers += `age ${bAge}/${bMin}  `;
      if (sup < 2) blockers += `support ${sup}/4 (need 2)  `;
      if (!sane) blockers += 'range height out of band  ';
      const prov = w.provEdge === DIR_ACCUM ? ' | provisional Spring on file' : w.provEdge === DIR_DIST ? ' | provisional UTAD on file' : '';
      return (blockers === '' ? 'Cause built: watch for Spring/UTAD or a terminal test at either edge' : `Building cause: ${blockers.trim()}`) + prov;
    }
    if (w.phase === PHASE_C) {
      const formal = !w.exc || w.excTested, want = w.outcome === DIR_ACCUM ? 'SOS' : 'SOW';
      const oppCyc = (reg === REGIME_MARKDOWN && w.outcome === DIR_ACCUM) || (reg === REGIME_MARKUP && w.outcome === DIR_DIST);
      if (oppCyc && campAge < K.oppositeCycleMinBars) return `Cycle reversal: building cause (${campAge}/${K.oppositeCycleMinBars})`;
      return formal ? `Waiting for ${want}` : `Waiting for Test, or a decisive ${want}`;
    }
    if (w.phase === PHASE_D) return na(w.lpsTime) ? `Waiting for ${w.outcome === DIR_ACCUM ? 'LPS' : 'LPSY'}` : 'Waiting for acceptance beyond the range';
    if (w.phase === PHASE_E) return w.outcome === DIR_ACCUM ? 'Markup underway: range should act as support' : 'Markdown underway: range should act as resistance';
    return 'Searching for SC / BC';
  };

  for (i = 0; i < n; i++) {
    const a = aS[i]!, aPrev = nz(at(atrRaw, i - 1), a), unit = unitS[i]!, cPos = (close[i]! - low[i]!) / spr[i]!, relE = relES[i]!, sprATR = sprATRS[i]!;
    const avgEff = avgEffS[i]!, avgEffPrev = nz(at(avgEffRaw, i - 1), avgEff), e0 = eff[i]!, s0 = spr[i]!;
    const recentEff = recentEffS[i]!, recentLow = recentLowS[i]!, recentHigh = recentHighS[i]!;
    const priorLo = at(lo30, i - 1), priorHi = at(hi30, i - 1), effHiPrior = at(effHi30, i - 1);
    const newLow = !na(priorLo) && low[i]! <= priorLo, newHigh = !na(priorHi) && high[i]! >= priorHi;
    const liveLen = liveLenS[i]!, preLen = nz(at(liveLenS, i - 3), liveLen);
    const pLen = s.phase !== PHASE_NONE ? nz(s.pivLen, liveLen) : liveLen;
    const ph = taPivot(high, i, pLen, true), pl = taPivot(low, i, pLen, false);
    phS[i] = ph; plS[i] = pl;
    const pivBar = i - pLen, pA = Math.max(nz(at(atrRaw, i - pLen), a), tick), pEff = nz(at(eff, i - pLen), e0);
    const pSpr = Math.max(nz(at(high, i - pLen), high[i]!) - nz(at(low, i - pLen), low[i]!), tick);
    const pCPos = (nz(at(close, i - pLen), close[i]!) - nz(at(low, i - pLen), low[i]!)) / pSpr, pAvgEff = nz(at(avgEffRaw, i - pLen), avgEff), pTime = nz(at(time, i - pLen), time[i]!);
    const longSma = longSmaS;
    const trendBars = Math.max(K.trendLen, Math.min(K.priorTrendMaxBars, round(liveLen * K.priorTrendPivotFactor)));
    const trendEnd = Math.max(2, Math.min(8, round(liveLen * 0.75)));
    const trendScore = priorTrendScore(trendBars, trendEnd);
    const downTrend = trendScore <= -K.priorTrendNeutral, upTrend = trendScore >= K.priorTrendNeutral, strongTrend = Math.abs(trendScore) >= K.priorTrendStrong;
    const c1 = nz(at(close, i - 1)), ls1 = nz(at(longSma, i - 1)), ls20 = at(longSma, i - 20);
    const longBull = c1 > ls1 && ls1 > nz(ls20), longBear = !na(ls20) && c1 < ls1 && ls1 < nz(ls20);
    const dnBase = at(dnBaseS, i - 1), upBase = at(upBaseS, i - 1);
    const dnAbsorb = !na(dnBase) && dnEffc[i]! <= dnBase * K.prelimEfficiencyRatio, upAbsorb = !na(upBase) && upEffc[i]! <= upBase * K.prelimEfficiencyRatio;
    const nearRecentLow = !na(priorLo) && low[i]! <= priorLo + a * K.prelimExtremeATR, nearRecentHigh = !na(priorHi) && high[i]! >= priorHi - a * K.prelimExtremeATR;
    const hiCInv = hiCInvS[i]!, loCInv = loCInvS[i]!, hiCDep = hiCDepS[i]!, loCDep = loCDepS[i]!, hiCA = hiCAS[i]!, loCA = loCAS[i]!;
    const hiCConf = hiCConfS[i]!, loCConf = loCConfS[i]!, hiCDir = hiCDirS[i]!, loCDir = loCDirS[i]!, hiCFail = hiCFailS[i]!, loCFail = loCFailS[i]!;
    const mbEffRatio = effSum5[i]! / Math.max(avgEff * K.sosMultiBarLen, 1e-10);
    const mbSOS = (close[i]! - mbLowS[i]!) / unit >= K.sosMultiBarATR && mbEffRatio >= K.sosMultiBarEffort && cPos >= 0.50;
    const mbSOW = (mbHighS[i]! - close[i]!) / unit >= K.sosMultiBarATR && mbEffRatio >= K.sosMultiBarEffort && cPos <= 0.50;
    const res3Up = Math.max(close[i]! - nz(at(close, i - 3), close[i]!), 0) / unit, res3Dn = Math.max(nz(at(close, i - 3), close[i]!) - close[i]!, 0) / unit;
    const bodyUp = close[i]! > open[i]! && close[i]! - open[i]! >= a * 0.50, bodyDn = close[i]! < open[i]! && open[i]! - close[i]! >= a * 0.50;
    const sosScore = (relE >= K.strengthVolMult ? 1 : 0) + (sprATR >= K.strengthSpreadATR ? 1 : 0) + (cPos >= K.sosCloseMin ? 1 : 0) + (bodyUp ? 1 : 0);
    const sowScore = (relE >= K.strengthVolMult ? 1 : 0) + (sprATR >= K.strengthSpreadATR ? 1 : 0) + (cPos <= K.sowCloseMax ? 1 : 0) + (bodyDn ? 1 : 0);
    const close1 = nz(at(close, i - 1), close[i]!), close2 = nz(at(close, i - 2), close[i]!);
    const ctxBars = Math.max(K.priorTrendMaxBars, K.continuationTrendLen) * 2;
    let sig = 0;

    // ---- commit (every closed bar) ----
    {
      const p0 = nz(s.pivLen, liveLen), rk0 = !na(s.rangeHigh) && !na(s.rangeLow), rH0 = s.rangeHigh, rL0 = s.rangeLow;
      const rHt0 = rk0 ? Math.max(rH0 - rL0, tick) : NaN, rMid0 = rk0 ? (rH0 + rL0) / 2.0 : NaN;
      const probeOpen = s.pend && i - s.pendStartBar <= excRecLimit(p0);
      const structAge = !na(s.startBar) ? i - s.startBar : 0;
      const ageOKBull = regime !== REGIME_MARKDOWN || structAge >= K.oppositeCycleMinBars, ageOKBear = regime !== REGIME_MARKUP || structAge >= K.oppositeCycleMinBars;
      const hardBull0 = hardLevel(s, DIR_ACCUM), hardBear0 = hardLevel(s, DIR_DIST);
      let why: ResetWhy | null = null;

      // Retire structures that no longer fit.
      if (s.phase === PHASE_A) {
        const age = i - s.climaxBar;
        const invAcc = s.stopSide === DIR_ACCUM && hiCInv < s.climaxPrice - a * K.structureInvalidationATR;
        const invDst = s.stopSide === DIR_DIST && loCInv > s.climaxPrice + a * K.structureInvalidationATR;
        const absorbExp = !s.absorbed && age > K.climaxAbsorptionMaxBars, noAR = !s.arOK && age > K.maxARBars;
        const overExt = s.arOK && !na(s.arRunPrice) && Math.abs(s.arRunPrice - s.climaxPrice) / Math.max(nz(s.climaxATR, a), tick) > K.arMaxExtensionATR;
        const buf = rk0 ? Math.max(rHt0 * K.phaseAPrematureDepartureTRFrac, a * K.phaseAPrematureDepartureATR) : NaN;
        const depart = age > K.maxARBars && rk0 && ((s.stopSide === DIR_ACCUM && loCA > rH0 + buf) || (s.stopSide === DIR_DIST && hiCA < rL0 - buf));
        if (invAcc || invDst) why = 'invalid'; else if (absorbExp) why = 'no absorption'; else if (noAR || overExt || depart) why = 'no range';
      }
      if (s.phase === PHASE_C && !probeOpen && !why) {
        if ((s.outcome === DIR_ACCUM && !na(hardBull0) && hiCInv < hardBull0 - a * K.structureInvalidationATR) || (s.outcome === DIR_DIST && !na(hardBear0) && loCInv > hardBear0 + a * K.structureInvalidationATR)) why = 'invalid';
      }
      if (s.phase === PHASE_D && rk0 && !why) {
        if (s.outcome === DIR_ACCUM) {
          if (!na(hardBull0) && hiCInv < hardBull0 - a * K.structureInvalidationATR) why = 'invalid';
          else if (hiCFail < rMid0) { demoteToB(); resets.demoted++; }
        } else if (s.outcome === DIR_DIST) {
          if (!na(hardBear0) && loCInv > hardBear0 + a * K.structureInvalidationATR) why = 'invalid';
          else if (loCFail > rMid0) { demoteToB(); resets.demoted++; }
        }
      }
      if (s.phase === PHASE_E && rk0 && !why) {
        const eFail = s.outcome === DIR_ACCUM ? hiCFail < rMid0 : loCFail > rMid0;
        const eOld = K.phaseEMaxBars > 0 && !na(s.eStartBar) && i - s.eStartBar > K.phaseEMaxBars;
        if (eFail || eOld) why = 'phase E ended';
      }
      const idle = idleLimit(s.phase, s.arOK, p0);
      if (!why && !probeOpen && !na(idle) && !na(s.lastActBar) && i - s.lastActBar > idle) why = 'stale';
      if (why) { resets[why]++; lastReset = why; s = new WS(); }

      // Preliminary support / supply, and new climaxes.
      if (s.phase === PHASE_NONE || s.phase === PHASE_E) {
        const psSc = (downTrend ? 1 : 0) + (nearRecentLow ? 1 : 0) + (relE >= K.prelimVolMult ? 1 : 0) + (sprATR >= 0.80 ? 1 : 0) + (cPos >= 0.45 ? 1 : 0) + (dnAbsorb ? 1 : 0);
        const psySc = (upTrend ? 1 : 0) + (nearRecentHigh ? 1 : 0) + (relE >= K.prelimVolMult ? 1 : 0) + (sprATR >= 0.80 ? 1 : 0) + (cPos <= 0.55 ? 1 : 0) + (upAbsorb ? 1 : 0);
        const psStale = na(prelimBar) || i - prelimBar > K.extremeLen;
        if (downTrend && nearRecentLow && relE >= K.prelimVolMult && psSc >= K.prelimMinScore && (prelimDir !== DIR_ACCUM || psStale || psSc >= prelimScore)) {
          prelimBar = i; prelimTime = time[i]!; prelimPrice = low[i]!; prelimDir = DIR_ACCUM; prelimScore = psSc;
        } else if (upTrend && nearRecentHigh && relE >= K.prelimVolMult && psySc >= K.prelimMinScore && (prelimDir !== DIR_DIST || psStale || psySc >= prelimScore)) {
          prelimBar = i; prelimTime = time[i]!; prelimPrice = high[i]!; prelimDir = DIR_DIST; prelimScore = psySc;
        }
      }
      const relaxK = strongTrend ? K.relaxedClimaxFactor : 1.0;
      const volHit = e0 >= avgEffPrev * K.climaxVolMult * relaxK, sprHit = s0 >= aPrev * K.climaxSpreadMult * relaxK;
      const exceptional = (!na(effHiPrior) && e0 >= effHiPrior) || s0 >= aPrev * K.climaxSpreadMult * 1.5;
      const scSc = (downTrend ? 1 : 0) + (newLow ? 1 : 0) + (volHit ? 1 : 0) + (sprHit ? 1 : 0) + (cPos >= K.scCloseMin ? 1 : 0) + (exceptional ? 1 : 0);
      const bcSc = (upTrend ? 1 : 0) + (newHigh ? 1 : 0) + (volHit ? 1 : 0) + (sprHit ? 1 : 0) + (cPos <= K.bcCloseMax ? 1 : 0) + (exceptional ? 1 : 0);
      const seedOpen = s.phase === PHASE_NONE || s.phase === PHASE_E;
      const canSC = seedOpen || (s.phase === PHASE_A && s.stopSide === DIR_ACCUM && low[i]! < s.climaxPrice);
      const canBC = seedOpen || (s.phase === PHASE_A && s.stopSide === DIR_DIST && high[i]! > s.climaxPrice);
      const isSC = canSC && downTrend && newLow && volHit && sprHit && scSc >= K.climaxMinScore;
      const isBC = canBC && upTrend && newHigh && volHit && sprHit && bcSc >= K.climaxMinScore;
      if (isSC !== isBC) {
        const side = isSC ? DIR_ACCUM : DIR_DIST;
        const recentMarkup = regime === REGIME_MARKUP && !na(regimeBar) && i - regimeBar <= ctxBars;
        const recentMarkdown = regime === REGIME_MARKDOWN && !na(regimeBar) && i - regimeBar <= ctxBars;
        s = new WS();
        seed(side, isSC ? scSc : bcSc, preLen, trendScore, recentMarkup || longBull, recentMarkdown || longBear, a, e0, s0);
        if (prelimDir === side && !na(prelimBar) && prelimBar < i && i - prelimBar <= K.extremeLen) { s.psTime = prelimTime; s.psPrice = prelimPrice; s.psScore = prelimScore; }
      }

      // Stopping action and the AR.
      if (s.phase === PHASE_A && !s.absorbed && !na(s.climaxBar)) {
        const absAge = i - s.climaxBar;
        if (absAge >= K.climaxAbsorptionMinBars && absAge <= K.climaxAbsorptionMaxBars) {
          const effortOK = recentEff >= avgEff * K.climaxAbsorptionVolFloor;
          const accAbs = s.stopSide === DIR_ACCUM && recentLow >= s.climaxPrice - s.climaxATR * K.climaxAbsorptionExtremeATR && close[i]! >= s.climaxPrice + s.climaxATR * K.climaxAbsorptionReboundATR;
          const dstAbs = s.stopSide === DIR_DIST && recentHigh <= s.climaxPrice + s.climaxATR * K.climaxAbsorptionExtremeATR && close[i]! <= s.climaxPrice - s.climaxATR * K.climaxAbsorptionReboundATR;
          if (effortOK && (accAbs || dstAbs)) {
            s.absorbed = true; s.cfClimax = true; s.lastActBar = i;
            sig = addBit(sig, s.stopSide === DIR_ACCUM ? BIT.SC : BIT.BC);
            if (!na(s.psTime)) sig = addBit(sig, BIT.PS);
          }
        }
      }
      if (s.phase === PHASE_A && na(s.arBar) && !na(s.climaxBar) && i > s.climaxBar && i - s.climaxBar <= K.maxARBars) {
        if (s.stopSide === DIR_ACCUM) {
          if (na(s.arRunPrice) || high[i]! > s.arRunPrice) { s.arRunPrice = high[i]!; s.arRunBar = i; s.arRunTime = time[i]!; }
          s.arOK = s.arOK || s.arRunPrice - s.climaxPrice >= a * K.minARATR;
        } else {
          if (na(s.arRunPrice) || low[i]! < s.arRunPrice) { s.arRunPrice = low[i]!; s.arRunBar = i; s.arRunTime = time[i]!; }
          s.arOK = s.arOK || s.climaxPrice - s.arRunPrice >= a * K.minARATR;
        }
      }
      if (s.phase === PHASE_A && s.arOK && s.absorbed && na(s.arBar)) {
        if (s.stopSide === DIR_ACCUM) { s.rangeHigh = s.arRunPrice; s.origHigh = s.arRunPrice; } else { s.rangeLow = s.arRunPrice; s.origLow = s.arRunPrice; }
      }

      const p1 = nz(s.pivLen, liveLen);
      let rk1 = !na(s.rangeHigh) && !na(s.rangeLow);
      const rH1 = s.rangeHigh, rL1 = s.rangeLow, origHt1 = rk1 ? Math.max(nz(s.origHigh, rH1) - nz(s.origLow, rL1), tick) : NaN;
      const mature1 = matureWS(s, p1, a);
      const newPL = !na(pl) && (na(lastPLBar) || pivBar > lastPLBar), newPH = !na(ph) && (na(lastPHBar) || pivBar > lastPHBar);
      if (newPL) lastPLBar = pivBar;
      if (newPH) lastPHBar = pivBar;
      let plUsed = false, phUsed = false;

      // Terminal tests from a mature Phase B.
      if (newPL && s.phase === PHASE_B && mature1 && rk1) {
        const loRefST = s.stopSide === DIR_ACCUM, refN = loRefST ? s.stN : s.opN, refBar = loRefST ? s.stBar : s.opLastBar, refPrice = loRefST ? s.stPrice : s.opLastPrice;
        if (refN > 0 && !na(refBar)) {
          const refEff = (loRefST ? s.stEffSum : s.opEffSum) / refN, refSpr = (loRefST ? s.stSprSum : s.opSprSum) / refN;
          const later = pivBar >= refBar + K.terminalTestMinBarsAfterST, near = pl <= rL1 + pA * K.testTolATR;
          const holds = pl >= Math.min(nz(s.origLow, rL1), rL1) - pA * K.testExtremeToleranceATR, higher = na(refPrice) || pl >= refPrice - pA * K.testExtremeToleranceATR;
          const qV = pEff <= refEff * K.terminalTestVolRatio, qS = pSpr <= refSpr * K.terminalTestSpreadRatio, nV = pEff <= refEff * K.terminalTestOtherMaxRatio, nS = pSpr <= refSpr * K.terminalTestOtherMaxRatio;
          const sc = (qV ? 1 : 0) + (qS ? 1 : 0) + (pCPos >= 0.50 ? 1 : 0);
          if (later && near && holds && higher && ((qV && nS) || (qS && nV)) && sc >= K.testMinScore) { enterCTest(DIR_ACCUM, pTime, pl, sc); sig = addBit(sig, BIT.CTEST); plUsed = true; }
        }
      }
      if (newPH && s.phase === PHASE_B && mature1 && rk1) {
        const hiRefST = s.stopSide === DIR_DIST, refN = hiRefST ? s.stN : s.opN, refBar = hiRefST ? s.stBar : s.opLastBar, refPrice = hiRefST ? s.stPrice : s.opLastPrice;
        if (refN > 0 && !na(refBar)) {
          const refEff = (hiRefST ? s.stEffSum : s.opEffSum) / refN, refSpr = (hiRefST ? s.stSprSum : s.opSprSum) / refN;
          const later = pivBar >= refBar + K.terminalTestMinBarsAfterST, near = ph >= rH1 - pA * K.testTolATR;
          const holds = ph <= Math.max(nz(s.origHigh, rH1), rH1) + pA * K.testExtremeToleranceATR, lower = na(refPrice) || ph <= refPrice + pA * K.testExtremeToleranceATR;
          const qV = pEff <= refEff * K.terminalTestVolRatio, qS = pSpr <= refSpr * K.terminalTestSpreadRatio, nV = pEff <= refEff * K.terminalTestOtherMaxRatio, nS = pSpr <= refSpr * K.terminalTestOtherMaxRatio;
          const sc = (qV ? 1 : 0) + (qS ? 1 : 0) + (pCPos <= 0.50 ? 1 : 0);
          if (later && near && holds && lower && ((qV && nS) || (qS && nV)) && sc >= K.testMinScore) { enterCTest(DIR_DIST, pTime, ph, sc); sig = addBit(sig, BIT.CTEST); phUsed = true; }
        }
      }

      // The ST that confirms the AR and opens Phase B.
      if (newPL && !plUsed && s.phase === PHASE_A && s.stopSide === DIR_ACCUM && s.absorbed && s.arOK && !na(s.arRunBar) && pivBar > s.arRunBar) {
        const zoneTop = s.origLow + (s.arRunPrice - s.origLow) * K.phaseBZoneFrac;
        const near = Math.abs(pl - s.origLow) <= pA * K.boundaryTolATR || pl <= zoneTop, holds = pl >= s.origLow - pA * K.boundaryTolATR, closeOK = pCPos >= 0.45;
        const tc = testClass(near, holds, closeOK, pEff, pSpr, s.climaxEff, s.climaxSpr);
        const sc = (near ? 1 : 0) + (pEff <= s.climaxEff * K.stMaxVolRatio ? 1 : 0) + (pSpr <= s.climaxSpr * K.stMaxSpreadRatio ? 1 : 0) + (holds ? 1 : 0) + (closeOK ? 1 : 0) + 1;
        const ageOK = pivBar - s.startBar >= phaseAMin(p1), spaceOK = pivBar - s.arRunBar >= Math.max(2, p1);
        if (near) s.lastActBar = i;
        if (tc === TEST_GOOD && sc >= K.stMinScore && ageOK && spaceOK) {
          freezeAR(); registerST(pl, pTime, pivBar, pEff, pSpr, sc); s.phase = PHASE_B; s.bStartBar = pivBar; s.bStartTime = pTime;
          sig = addBit(sig, BIT.AR); sig = addBit(sig, BIT.ST); plUsed = true;
        }
      }
      if (newPH && !phUsed && s.phase === PHASE_A && s.stopSide === DIR_DIST && s.absorbed && s.arOK && !na(s.arRunBar) && pivBar > s.arRunBar) {
        const zoneBot = s.origHigh - (s.origHigh - s.arRunPrice) * K.phaseBZoneFrac;
        const near = Math.abs(ph - s.origHigh) <= pA * K.boundaryTolATR || ph >= zoneBot, holds = ph <= s.origHigh + pA * K.boundaryTolATR, closeOK = pCPos <= 0.55;
        const tc = testClass(near, holds, closeOK, pEff, pSpr, s.climaxEff, s.climaxSpr);
        const sc = (near ? 1 : 0) + (pEff <= s.climaxEff * K.stMaxVolRatio ? 1 : 0) + (pSpr <= s.climaxSpr * K.stMaxSpreadRatio ? 1 : 0) + (holds ? 1 : 0) + (closeOK ? 1 : 0) + 1;
        const ageOK = pivBar - s.startBar >= phaseAMin(p1), spaceOK = pivBar - s.arRunBar >= Math.max(2, p1);
        if (near) s.lastActBar = i;
        if (tc === TEST_GOOD && sc >= K.stMinScore && ageOK && spaceOK) {
          freezeAR(); registerST(ph, pTime, pivBar, pEff, pSpr, sc); s.phase = PHASE_B; s.bStartBar = pivBar; s.bStartTime = pTime;
          sig = addBit(sig, BIT.AR); sig = addBit(sig, BIT.ST); phUsed = true;
        }
      }

      // Phase B tests and opposite-edge tests.
      rk1 = !na(s.rangeHigh) && !na(s.rangeLow);
      if (newPL && !plUsed && s.phase === PHASE_B && rk1 && pivBar > s.bStartBar) {
        const bHt = Math.max(s.rangeHigh - s.rangeLow, tick);
        if (s.stopSide === DIR_ACCUM) {
          const near = Math.abs(pl - s.rangeLow) <= pA * K.boundaryTolATR || Math.abs(pl - s.origLow) <= pA * K.boundaryTolATR || pl <= s.rangeLow + bHt * K.phaseBZoneFrac;
          const holds = pl >= s.origLow - pA * K.boundaryTolATR, closeOK = pCPos >= 0.45;
          const tc = testClass(near, holds, closeOK, pEff, pSpr, s.climaxEff, s.climaxSpr);
          const sc = (near ? 1 : 0) + (pEff <= s.climaxEff * K.stMaxVolRatio ? 1 : 0) + (pSpr <= s.climaxSpr * K.stMaxSpreadRatio ? 1 : 0) + (holds ? 1 : 0) + (closeOK ? 1 : 0) + 1;
          const isProv = s.provEdge === DIR_ACCUM && !na(s.provBar) && Math.abs(pivBar - s.provBar) <= p1;
          if (near) s.lastActBar = i;
          if (tc === TEST_FAILED && !isProv) s.lastBadBar = pivBar;
          else if (tc === TEST_GOOD && sc >= K.stMinScore) { registerST(pl, pTime, pivBar, pEff, pSpr, sc); sig = addBit(sig, BIT.ST); }
        } else {
          if (pl < s.rangeLow && pl >= nz(s.origLow, s.rangeLow) - origHt1 * K.phaseBEdgeExpansionCap) s.rangeLow = pl;
          const oHt = Math.max(s.rangeHigh - s.rangeLow, tick);
          const near = pl <= s.rangeLow + pA * K.boundaryTolATR || pl <= s.rangeLow + oHt * K.phaseBZoneFrac;
          const inside = pl >= nz(s.origLow, s.rangeLow) - origHt1 * K.phaseBEdgeExpansionCap, ctrl = pEff <= s.climaxEff * 1.20 && pSpr <= s.climaxSpr * 1.20;
          if (near && inside && ctrl && (na(s.opLastBar) || pivBar > s.opLastBar)) registerOpp(pl, pTime, pivBar, pEff, pSpr);
        }
      }
      if (newPH && !phUsed && s.phase === PHASE_B && rk1 && pivBar > s.bStartBar) {
        const bHt = Math.max(s.rangeHigh - s.rangeLow, tick);
        if (s.stopSide === DIR_DIST) {
          const near = Math.abs(ph - s.rangeHigh) <= pA * K.boundaryTolATR || Math.abs(ph - s.origHigh) <= pA * K.boundaryTolATR || ph >= s.rangeHigh - bHt * K.phaseBZoneFrac;
          const holds = ph <= s.origHigh + pA * K.boundaryTolATR, closeOK = pCPos <= 0.55;
          const tc = testClass(near, holds, closeOK, pEff, pSpr, s.climaxEff, s.climaxSpr);
          const sc = (near ? 1 : 0) + (pEff <= s.climaxEff * K.stMaxVolRatio ? 1 : 0) + (pSpr <= s.climaxSpr * K.stMaxSpreadRatio ? 1 : 0) + (holds ? 1 : 0) + (closeOK ? 1 : 0) + 1;
          const isProv = s.provEdge === DIR_DIST && !na(s.provBar) && Math.abs(pivBar - s.provBar) <= p1;
          if (near) s.lastActBar = i;
          if (tc === TEST_FAILED && !isProv) s.lastBadBar = pivBar;
          else if (tc === TEST_GOOD && sc >= K.stMinScore) { registerST(ph, pTime, pivBar, pEff, pSpr, sc); sig = addBit(sig, BIT.ST); }
        } else {
          if (ph > s.rangeHigh && ph <= nz(s.origHigh, s.rangeHigh) + origHt1 * K.phaseBEdgeExpansionCap) s.rangeHigh = ph;
          const oHt = Math.max(s.rangeHigh - s.rangeLow, tick);
          const near = ph >= s.rangeHigh - pA * K.boundaryTolATR || ph >= s.rangeHigh - oHt * K.phaseBZoneFrac;
          const inside = ph <= nz(s.origHigh, s.rangeHigh) + origHt1 * K.phaseBEdgeExpansionCap, ctrl = pEff <= s.climaxEff * 1.20 && pSpr <= s.climaxSpr * 1.20;
          if (near && inside && ctrl && (na(s.opLastBar) || pivBar > s.opLastBar)) registerOpp(ph, pTime, pivBar, pEff, pSpr);
        }
      }

      // Traversals of the range.
      if (s.phase === PHASE_B && !na(s.rangeHigh) && !na(s.rangeLow)) {
        const tvHt = Math.max(s.rangeHigh - s.rangeLow, tick);
        const loZ = newPL && pl <= s.rangeLow + tvHt * K.phaseBZoneFrac, hiZ = newPH && ph >= s.rangeHigh - tvHt * K.phaseBZoneFrac;
        const zoneNow = loZ !== hiZ ? (loZ ? -1 : 1) : 0;
        if (zoneNow !== 0 && (na(s.lastZoneBar) || pivBar > s.lastZoneBar)) {
          if (s.lastZone !== 0 && zoneNow !== s.lastZone) { s.travCount++; s.lastActBar = i; }
          s.lastZone = zoneNow; s.lastZoneBar = pivBar;
        }
      }

      // The test after a Spring / UTAD.
      if (newPL && s.phase === PHASE_C && s.outcome === DIR_ACCUM && s.exc && !s.excTested && pivBar > s.excBar && !na(s.rangeLow)) {
        const near = pl <= s.rangeLow + pA * K.testTolATR, keep = pl >= s.excPrice - pA * K.testExtremeToleranceATR;
        const sc = (pEff <= s.excEff * K.testMaxVolRatio ? 1 : 0) + (pSpr <= s.excSpr * K.testMaxSpreadRatio ? 1 : 0) + (pCPos >= 0.50 ? 1 : 0);
        if (near && keep && sc >= K.testMinScore) {
          s.excTested = true; s.cReadyBar = i; s.testTime = pTime; s.testPrice = pl; s.testScore = sc; s.cfTest = true;
          setEvent(EV.TEST); sig = addBit(sig, BIT.TEST);
        }
      }
      if (newPH && s.phase === PHASE_C && s.outcome === DIR_DIST && s.exc && !s.excTested && pivBar > s.excBar && !na(s.rangeHigh)) {
        const near = ph >= s.rangeHigh - pA * K.testTolATR, keep = ph <= s.excPrice + pA * K.testExtremeToleranceATR;
        const sc = (pEff <= s.excEff * K.testMaxVolRatio ? 1 : 0) + (pSpr <= s.excSpr * K.testMaxSpreadRatio ? 1 : 0) + (pCPos <= 0.50 ? 1 : 0);
        if (near && keep && sc >= K.testMinScore) {
          s.excTested = true; s.cReadyBar = i; s.testTime = pTime; s.testPrice = ph; s.testScore = sc; s.cfTest = true;
          setEvent(EV.TEST); sig = addBit(sig, BIT.TEST);
        }
      }

      // LPS / LPSY in Phase D.
      if (newPL && s.phase === PHASE_D && s.outcome === DIR_ACCUM && !na(s.strBar) && pivBar > s.strBar && !na(s.rangeHigh)) {
        const hard = hardLevel(s, DIR_ACCUM), side = !na(hard) && pl > hard - pA * K.testExtremeToleranceATR, creek = pl >= s.rangeHigh - pA * K.lpsBoundaryATR;
        const sc = (pEff <= pAvgEff * K.lpsVolMult ? 1 : 0) + (pSpr <= pA * K.lpsSpreadATR ? 1 : 0) + (pCPos >= 0.45 ? 1 : 0);
        if (side && creek && sc >= K.lpsMinScore) { s.lpsTime = pTime; s.lpsPrice = pl; s.lpsBar = i; s.lpsScore = sc; s.cfLPS = true; setEvent(EV.LPS); sig = addBit(sig, BIT.LPS); }
      }
      if (newPH && s.phase === PHASE_D && s.outcome === DIR_DIST && !na(s.strBar) && pivBar > s.strBar && !na(s.rangeLow)) {
        const hard = hardLevel(s, DIR_DIST), side = !na(hard) && ph < hard + pA * K.testExtremeToleranceATR, ice = ph <= s.rangeLow + pA * K.lpsBoundaryATR;
        const sc = (pEff <= pAvgEff * K.lpsVolMult ? 1 : 0) + (pSpr <= pA * K.lpsSpreadATR ? 1 : 0) + (pCPos <= 0.55 ? 1 : 0);
        if (side && ice && sc >= K.lpsMinScore) { s.lpsTime = pTime; s.lpsPrice = ph; s.lpsBar = i; s.lpsScore = sc; s.cfLPS = true; setEvent(EV.LPSY); sig = addBit(sig, BIT.LPSY); }
      }

      const p2 = nz(s.pivLen, liveLen), rk2 = !na(s.rangeHigh) && !na(s.rangeLow), rH2 = s.rangeHigh, rL2 = s.rangeLow, recLimit2 = excRecLimit(p2);
      const mature2 = matureWS(s, p2, a), bAge2 = !na(s.bStartBar) ? i - s.bStartBar : 0;
      // Spring, UTAD and terminal probes.
      const probeB = s.phase === PHASE_B && s.stCount >= 1 && bAge2 >= Math.max(3, p2 * 2);
      const probeCLo = s.phase === PHASE_C && s.outcome === DIR_ACCUM && !s.exc, probeCHi = s.phase === PHASE_C && s.outcome === DIR_DIST && !s.exc;
      if (rk2 && !s.pend && (na(s.pendCoolBar) || i > s.pendCoolBar)) {
        const penLo = rL2 - low[i]!, penHi = high[i]! - rH2;
        const okLo = (probeB || probeCLo) && penLo >= a * K.springMinPenATR && penLo <= a * K.springMaxPenATR;
        const okHi = (probeB || probeCHi) && penHi >= a * K.springMinPenATR && penHi <= a * K.springMaxPenATR;
        if (okLo !== okHi) {
          s.pend = true; s.pendEdge = okLo ? DIR_ACCUM : DIR_DIST; s.pendStartBar = i; s.pendExtBar = i; s.pendExt = okLo ? low[i]! : high[i]!; s.pendExtTime = time[i]!; s.pendEff = e0; s.pendSpr = s0;
        }
      }
      if (s.pend && rk2 && (s.phase === PHASE_B || s.phase === PHASE_C)) {
        if (s.pendEdge === DIR_ACCUM && low[i]! < s.pendExt) { s.pendExt = low[i]!; s.pendExtBar = i; s.pendExtTime = time[i]!; s.pendEff = Math.max(nz(s.pendEff), e0); s.pendSpr = Math.max(nz(s.pendSpr), s0); }
        else if (s.pendEdge === DIR_DIST && high[i]! > s.pendExt) { s.pendExt = high[i]!; s.pendExtBar = i; s.pendExtTime = time[i]!; s.pendEff = Math.max(nz(s.pendEff), e0); s.pendSpr = Math.max(nz(s.pendSpr), s0); }
        const recAge = i - s.pendStartBar, recovered = s.pendEdge === DIR_ACCUM ? close[i]! > rL2 : close[i]! < rH2;
        const depth = s.pendEdge === DIR_ACCUM ? rL2 - s.pendExt : s.pendExt - rH2, depthOK = depth >= a * K.springMinPenATR && depth <= a * K.springMaxPenATR;
        const recSc = s.pendEdge === DIR_ACCUM
          ? (cPos >= K.springCloseMin ? 1 : 0) + (e0 <= avgEff * K.springEffortMaxMult ? 1 : 0) + (close[i]! > open[i]! ? 1 : 0) + (s0 >= a * 0.50 ? 1 : 0)
          : (cPos <= K.utadCloseMax ? 1 : 0) + (e0 <= avgEff * K.springEffortMaxMult ? 1 : 0) + (close[i]! < open[i]! ? 1 : 0) + (s0 >= a * 0.50 ? 1 : 0);
        if (recovered && depthOK && recAge <= recLimit2 && recSc >= K.excursionMinScore) {
          const edge = s.pendEdge;
          if (s.phase === PHASE_B && !mature2) {
            s.provEdge = edge; s.provBar = s.pendExtBar; s.provPrice = s.pendExt; s.provTime = s.pendExtTime; s.provEff = s.pendEff; s.provSpr = s.pendSpr; s.provScore = recSc;
            s.lastActBar = i; s.pend = false;
          } else {
            if (s.phase === PHASE_C) clearTerminal();
            excFromPend(recSc);
            sig = addBit(sig, edge === DIR_ACCUM ? BIT.SPRING : BIT.UTAD);
          }
        } else if (recAge > recLimit2 || (!depthOK && depth > a * K.springMaxPenATR)) {
          if (s.phase === PHASE_B) s.lastBadBar = i;
          s.pend = false; s.pendCoolBar = i + p2;
        }
      }
      if (s.phase === PHASE_C && s.exc && !s.excTested && rk2) {
        if (s.outcome === DIR_ACCUM && low[i]! < s.excPrice && low[i]! >= rL2 - a * K.springMaxPenATR) {
          s.excPrice = low[i]!; s.excBar = i; s.excTime = time[i]!; s.excEff = Math.max(nz(s.excEff), e0); s.excSpr = Math.max(nz(s.excSpr), s0);
        } else if (s.outcome === DIR_DIST && high[i]! > s.excPrice && high[i]! <= rH2 + a * K.springMaxPenATR) {
          s.excPrice = high[i]!; s.excBar = i; s.excTime = time[i]!; s.excEff = Math.max(nz(s.excEff), e0); s.excSpr = Math.max(nz(s.excSpr), s0);
        }
      }

      // SOS / SOW: promote to Phase D.
      if (s.phase === PHASE_C && rk2 && !s.pend) {
        const cMinD = phaseCToDMin(p2), formal = !s.exc || s.excTested, anchor = !na(s.cReadyBar) ? s.cReadyBar : s.excBar;
        const ageReady = !na(anchor) && i - anchor >= cMinD, cVal = validationWS(s, p2, trendScore, a), cValD = formal ? cVal : Math.min(100, cVal + 13);
        const cConf = confWS(s), cConfD = formal ? cConf : Math.min(100, cConf + 30), cHt = Math.max(rH2 - rL2, tick);
        if (ageReady && cValD >= K.phaseDValidationMin && cConfD >= K.minConfidencePhaseC) {
          if (s.outcome === DIR_ACCUM && ageOKBull) {
            const dom = rL2 + cHt * K.phaseDDominanceFrac, brk = close[i]! > rH2 + a * K.breakATR;
            const domOK = brk || (formal ? close[i]! >= dom && close1 >= dom : close[i]! >= dom && close1 >= dom && close2 >= dom);
            const req = formal ? K.strengthMinScore : Math.max(2, K.strengthMinScore - 1), q = sosScore >= req || mbSOS || (!formal && res3Up >= 1.0);
            if (domOK && q) { promoteD(DIR_ACCUM, sosScore, high[i]!); sig = addBit(sig, BIT.SOS); }
          } else if (s.outcome === DIR_DIST && ageOKBear) {
            const dom = rH2 - cHt * K.phaseDDominanceFrac, brk = close[i]! < rL2 - a * K.breakATR;
            const domOK = brk || (formal ? close[i]! <= dom && close1 <= dom : close[i]! <= dom && close1 <= dom && close2 <= dom);
            const req = formal ? K.strengthMinScore : Math.max(2, K.strengthMinScore - 1), q = sowScore >= req || mbSOW || (!formal && res3Dn >= 1.0);
            if (domOK && q) { promoteD(DIR_DIST, sowScore, low[i]!); sig = addBit(sig, BIT.SOW); }
          }
        }
      }

      // A Phase B range left without a test (adopt a provisional Spring / UTAD, or reset).
      let resetLate = false;

      if (s.phase === PHASE_B && rk2 && !s.pend) {
        const dHt = Math.max(rH2 - rL2, tick), dBuf = Math.max(dHt * K.phaseBDepartureTRFrac, a * K.phaseBDepartureATR);
        const upAcc = close[i]! > rH2 + a * K.breakATR && close1 > rH2 + a * K.breakATR, dnAcc = close[i]! < rL2 - a * K.breakATR && close1 < rL2 - a * K.breakATR;
        const upSus = loCDep > rH2 + dBuf, dnSus = hiCDep < rL2 - dBuf;
        const upGo = (upAcc && (sosScore >= K.strengthMinScore || mbSOS)) || upSus, dnGo = (dnAcc && (sowScore >= K.strengthMinScore || mbSOW)) || dnSus;
        const provLimit = idleLimit(PHASE_C, true, p2);
        if (upGo && !dnGo) {
          const upProv = s.provEdge === DIR_ACCUM && !na(s.provBar) && i - s.provBar <= provLimit;
          if (ageOKBull && upProv && mature2) { adoptProv(); promoteD(DIR_ACCUM, sosScore, high[i]!); sig = addBit(sig, BIT.SPRING); sig = addBit(sig, BIT.SOS); }
          else if (upSus && !upProv) resetLate = true;
        } else if (dnGo && !upGo) {
          const dnProv = s.provEdge === DIR_DIST && !na(s.provBar) && i - s.provBar <= provLimit;
          if (ageOKBear && dnProv && mature2) { adoptProv(); promoteD(DIR_DIST, sowScore, low[i]!); sig = addBit(sig, BIT.UTAD); sig = addBit(sig, BIT.SOW); }
          else if (dnSus && !dnProv) resetLate = true;
        }
      }
      if (resetLate) { resets['left range']++; lastReset = 'left range'; s = new WS(); }

      // A new SOS / SOW after the LPS / LPSY.
      if (s.phase === PHASE_D && s.outcome === DIR_ACCUM && s.ev === EV.LPS && !na(s.rangeHigh)) {
        if (close[i]! > s.rangeHigh + a * K.breakATR && relE >= K.strengthVolMult && cPos >= K.sosCloseMin) { s.strBar = i; s.strTime = time[i]!; s.strPrice = high[i]!; s.strScore = sosScore; setEvent(EV.SOS); sig = addBit(sig, BIT.SOS); }
      }
      if (s.phase === PHASE_D && s.outcome === DIR_DIST && s.ev === EV.LPSY && !na(s.rangeLow)) {
        if (close[i]! < s.rangeLow - a * K.breakATR && relE >= K.strengthVolMult && cPos <= K.sowCloseMax) { s.strBar = i; s.strTime = time[i]!; s.strPrice = low[i]!; s.strScore = sowScore; setEvent(EV.SOW); sig = addBit(sig, BIT.SOW); }
      }

      // Acceptance into Phase E.
      if (s.phase === PHASE_D && !na(s.rangeHigh) && !na(s.rangeLow)) {
        const eConf = confWS(s), dAge = !na(s.dStartBar) ? i - s.dStartBar : 0, dMin = phaseDMin(nz(s.pivLen, liveLen));
        if (s.outcome === DIR_ACCUM) {
          s.outCount = close[i]! > s.rangeHigh ? s.outCount + 1 : 0;
          const oppOK = regime !== REGIME_MARKDOWN || s.cfLPS;
          const std = s.cfLPS && !na(s.lpsBar) && i - s.lpsBar >= K.confirmBars && dAge >= dMin && loCConf > s.rangeHigh && eConf >= K.minConfidencePhaseD;
          const dir = !s.cfLPS && dAge >= Math.max(dMin, K.directAcceptanceBars) && loCDir > s.rangeHigh && eConf >= K.directAcceptanceConfidence;
          if ((std || dir) && oppOK) { s.cfAccept = true; s.phase = PHASE_E; s.eStartBar = i; s.eStartTime = time[i]!; regime = REGIME_MARKUP; regimeBar = i; setEvent(EV.MARKUP); sig = addBit(sig, BIT.E); }
        } else if (s.outcome === DIR_DIST) {
          s.outCount = close[i]! < s.rangeLow ? s.outCount + 1 : 0;
          const oppOK = regime !== REGIME_MARKUP || s.cfLPS;
          const std = s.cfLPS && !na(s.lpsBar) && i - s.lpsBar >= K.confirmBars && dAge >= dMin && hiCConf < s.rangeLow && eConf >= K.minConfidencePhaseD;
          const dir = !s.cfLPS && dAge >= Math.max(dMin, K.directAcceptanceBars) && hiCDir < s.rangeLow && eConf >= K.directAcceptanceConfidence;
          if ((std || dir) && oppOK) { s.cfAccept = true; s.phase = PHASE_E; s.eStartBar = i; s.eStartTime = time[i]!; regime = REGIME_MARKDOWN; regimeBar = i; setEvent(EV.MARKDOWN); sig = addBit(sig, BIT.E); }
        }
      }
    }

    // Entry (Standard strictness: a Phase C test, else an LPS / LPSY, with the quality gates).
    if (na(s.entryTime) && s.outcome !== DIR_NONE) {
      const minConf = K.entryMinConfidenceStandard, minTests = K.entryMinTestsStandard, valFloor = Math.max(45, K.phaseDValidationMin - 10);
      const val = validationWS(s, nz(s.pivLen, liveLen), trendScore, a), ready = entryReadiness(s, minConf, valFloor, a);
      const quality = confWS(s) >= minConf && val >= valFloor && ready >= minTests;
      const testBit = hasBit(sig, BIT.TEST) || hasBit(sig, BIT.CTEST), lpsBit = hasBit(sig, BIT.LPS) || hasBit(sig, BIT.LPSY);
      const testTrig = testBit && quality && s.testScore >= K.testMinScore, lpsTrig = lpsBit && quality;
      if (testTrig || lpsTrig) {
        s.entryTime = time[i]!; s.entryPrice = close[i]!; s.entryKind = lpsTrig ? ENTRY_LPS : ENTRY_TEST;
        entries.push({ time: s.entryTime, price: s.entryPrice, dir: s.outcome, kind: s.entryKind });
      }
    }

    const oP = nz(s.pivLen, liveLen);
    bars.push({
      stop: s.stopSide, outcome: s.outcome, wdir: s.outcome !== DIR_NONE ? s.outcome : biasDir(s), type: typeWS(s), phase: s.phase, ev: s.ev,
      conf: s.stopSide === DIR_NONE ? 0 : confWS(s), val: validationWS(s, oP, trendScore, a), rangeHigh: s.rangeHigh, rangeLow: s.rangeLow, sig,
      entryTime: s.entryTime, entryPrice: s.entryPrice, entryKind: s.entryKind, lastEventTime: s.lastEventTime, lastEventPrice: s.lastEventPrice,
      exc: s.exc ? s.excPrice : NaN,
    });
    if (i === n - 1) return { bars, state: s, next: describeNext(s, oP, regime, i), entries, resets, lastReset };
  }
  return { bars, state: s, next: 'Searching for SC / BC', entries, resets, lastReset };
}
