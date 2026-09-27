// Full-loop portfolio backtest: the layer-4 controls must be on and must bite.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { EMA50_SIGNAL, defaultConfig } from '../src/index';
import { loadScoreConfig } from '../src/score/config';
import { DEFAULT_CONTROLS, HOLDOUT_FROZEN, compareTrades, HOLDOUT_PHRASE, formatPortfolio, holdoutUnlocked, holdoutVerdict, portfolioConfig, quarters, runPortfolio } from '../src/screen/portfolio';
import { EXITS } from '../src/screen/screen';
import { SIGNALS } from '../src/screen/signals';
import { START } from './market';
import { syntheticMarket } from './synthetic';

const DAY = 86_400_000;
const REPO = join(__dirname, '..', '..', '..');
const { config: score } = loadScoreConfig(join(REPO, 'config/confluence.yaml'));
const data = syntheticMarket(160, 6);
const symbols = Object.keys(data);
const base = defaultConfig(START + 30 * DAY, START + 160 * DAY);
const hiwin = EXITS[0]!;

describe('portfolio backtest', () => {
  test('the config switches every control on', () => {
    const c = portfolioConfig(base, '1d', hiwin, DEFAULT_CONTROLS);
    expect(c.portfolio).toEqual({ maxOpenRiskPct: 6, maxSameDirAlts: 2 });
    expect(c.circuitBreaker).toEqual({ drawdownPct: 15, pauseDays: 7 });
    expect(c.risk.tiers.MTF).toMatchObject({ riskPct: 1, dailyLossPct: 8 });
    expect(c.fillRealism).toBe(true);
  });

  test('tight controls block entries that loose controls allow, and the report says so', () => {
    const def = SIGNALS.find((s) => s.id === 'ema_9_21')!;
    const loose = runPortfolio(data, symbols, def, '1h', hiwin, base, score, { ...DEFAULT_CONTROLS, maxOpenRiskPct: 1e9, maxSameDirAlts: 1e9, dailyLossPct: 1e9, drawdownPct: 1e9 }).report;
    const tight = runPortfolio(data, symbols, def, '1h', hiwin, base, score, { ...DEFAULT_CONTROLS, maxOpenRiskPct: 1.5, maxSameDirAlts: 1 }).report;
    expect(loose.trades).toBeGreaterThan(0);
    expect(Object.keys(loose.blocked)).toHaveLength(0);
    expect(tight.trades).toBeLessThan(loose.trades);
    expect((tight.blocked['portfolio open-risk cap'] ?? 0) + (tight.blocked['same-direction alts cap'] ?? 0)).toBeGreaterThan(0);
    expect(tight.openMax).toBeLessThanOrEqual(2);
    const text = formatPortfolio(tight, hiwin.what);
    expect(text).toContain('Blocked by the controls');
    expect(text).toContain('quarters positive');
  }, 60_000);

  test('quarters cover the window without gaps', () => {
    const q = quarters([], Date.UTC(2023, 2, 29), Date.UTC(2024, 2, 29));
    expect(q).toHaveLength(4);
    expect(q[0]!.from).toBe(Date.UTC(2023, 2, 29));
    expect(q[3]!.to).toBe(Date.UTC(2024, 2, 29));
  });
});

describe('the ema50 bot model (owner: current exit default, hybrids tagged alongside)', () => {
  test('its default slot trades exactly what the portfolio backtest traded', async () => {
    const { botConfig, runBacktest } = await import('../src/index');
    const def = SIGNALS.find((s) => s.id === 'ema50_trend_vol')!;
    // A 1d signal needs history: stretch the synthetic market to a year.
    const long = syntheticMarket(400, 7);
    const b = defaultConfig(START + 150 * DAY, START + 400 * DAY);
    const port = runPortfolio(long, Object.keys(long), def, '1d', hiwin, b, score, DEFAULT_CONTROLS).result.trades;
    const cfg = botConfig(b.from, b.to, 'ema50');
    const onlyDefault = { ...cfg, tiers: { ...cfg.tiers, HTF: { ...cfg.tiers.HTF, enabled: false }, LTF: { ...cfg.tiers.LTF, enabled: false }, P4H: { ...cfg.tiers.P4H, enabled: false }, P1H: { ...cfg.tiers.P1H, enabled: false } } };
    const bot = runBacktest(long, onlyDefault).trades;
    expect(bot.length).toBeGreaterThan(0);
    const key = (t: { symbol: string; side: string; openedAt: number; closedAt: number; r: number }) => `${t.symbol}|${t.side}|${t.openedAt}|${t.closedAt}|${t.r.toFixed(9)}`;
    expect(bot.map(key)).toEqual(port.map(key));
  }, 60_000);

  test('all three slots trade side by side, each position tagged with its strategy, each with its own exits', async () => {
    const { botConfig, runBacktest } = await import('../src/index');
    const long = syntheticMarket(400, 7);
    const cfg = botConfig(START + 150 * DAY, START + 400 * DAY, 'ema50');
    expect(cfg.tiers.MTF.label).toContain('target 1 ATR');
    expect(cfg.tiers.HTF.partials).toEqual([{ atR: 0.5, fraction: 0.6 }]);
    expect(cfg.tiers.LTF.partials).toEqual([{ atR: 0.75, fraction: 0.5 }]);
    const trades = runBacktest(long, cfg).trades;
    const bySlot = new Set(trades.map((t) => t.tier));
    expect(bySlot.has('MTF')).toBe(true);
    expect(bySlot.size).toBeGreaterThan(1);
    // Same entry signal: every hybrid entry lines up with a signal bar the default slot saw too (same coin, side, bar).
    const entries = (tier: string) => new Set(trades.filter((t) => t.tier === tier).map((t) => `${t.symbol}|${t.side}|${t.tag}`));
    const mtf = entries('MTF');
    const hyb = entries('HTF');
    expect([...hyb].filter((k) => mtf.has(k)).length).toBeGreaterThan(0);
  }, 60_000);

  test('the 4H pullback trades in its own slot (P4H) on 4H closes, with a structure stop and the fee-aware breakeven', async () => {
    const { botConfig, runBacktest } = await import('../src/index');
    const long = syntheticMarket(400, 7);
    const cfg = botConfig(START + 150 * DAY, START + 400 * DAY, 'ema50');
    expect(cfg.tiers.P4H).toMatchObject({ enabled: true, entryTf: '4h', stopSteps: [{ atR: 1.6, toR: 0.2 }], partials: [{ atR: 1.6, fraction: 0.5 }], expiryBars: 1 });
    expect(cfg.tiers.P1H).toMatchObject({ enabled: true, entryTf: '1h', stopSteps: [{ atR: 1.4, toR: 0.25 }], partials: [{ atR: 1.4, fraction: 0.5 }], timeStop: { checkBars: 15, minMfeR: 0.5, maxBars: 45 } });
    expect(cfg.tiers.P4H.signal).toMatchObject({ makerEntry: true, structureStop: { capR: 6 } });
    const only = { ...cfg, tiers: { ...cfg.tiers, MTF: { ...cfg.tiers.MTF, enabled: false }, HTF: { ...cfg.tiers.HTF, enabled: false }, LTF: { ...cfg.tiers.LTF, enabled: false }, P1H: { ...cfg.tiers.P1H, enabled: false } } };
    const trades = runBacktest(long, only).trades;
    for (const t of trades) {
      expect(t.tier).toBe('P4H');
      expect(t.tag! % (4 * 3_600_000)).toBe(0); // entered on a 4H close
      expect(t.r).toBeGreaterThan(-1.5); // a structure stop, not a runaway loss
    }
  }, 120_000);

  test('coin selection: range and RRG-direction filters only let through trades that pass them', async () => {
    const { botConfig, runBacktest } = await import('../src/index');
    const long = syntheticMarket(400, 7);
    const cfg = botConfig(START + 150 * DAY, START + 400 * DAY, 'ema50');
    expect(cfg.tiers.P1H.signal?.selection).toBe('rrg');
    expect(cfg.tiers.P4H.signal?.selection).toBe('none');
    const only = { ...cfg, tiers: { ...cfg.tiers, MTF: { ...cfg.tiers.MTF, enabled: false }, HTF: { ...cfg.tiers.HTF, enabled: false }, LTF: { ...cfg.tiers.LTF, enabled: false }, P1H: { ...cfg.tiers.P1H, enabled: false } } };
    const location = (symbol: string, time: number) => {
      const d = long[symbol]!.candles['1d']!;
      let j = -1;
      for (let k = 0; k < d.length; k++) if (d[k]!.openTime + DAY <= time) j = k;
      const w = d.slice(j - 19, j + 1);
      const hi = Math.max(...w.map((c) => c.high)), lo = Math.min(...w.map((c) => c.low));
      return (d[j]!.close - lo) / (hi - lo);
    };
    const all = runBacktest(long, only, undefined, { closeAtEnd: true, selectionAt: () => 'none' }).trades;
    const ranged = runBacktest(long, only, undefined, { closeAtEnd: true, selectionAt: (tier) => (tier === 'P4H' ? 'range' : null) }).trades;
    for (const t of ranged) {
      const loc = location(t.symbol, t.tag!);
      if (t.side === 'long') expect(loc).toBeGreaterThanOrEqual(0.45);
      else expect(loc).toBeLessThanOrEqual(0.55);
    }
    // The daily EMA 50 slots take the same filter.
    const mtfOnly = { ...cfg, tiers: { ...cfg.tiers, HTF: { ...cfg.tiers.HTF, enabled: false }, LTF: { ...cfg.tiers.LTF, enabled: false }, P4H: { ...cfg.tiers.P4H, enabled: false }, P1H: { ...cfg.tiers.P1H, enabled: false } } };
    const mtfAll = runBacktest(long, mtfOnly, undefined, { closeAtEnd: true, selectionAt: () => 'none' }).trades;
    const mtfRanged = runBacktest(long, mtfOnly, undefined, { closeAtEnd: true, selectionAt: (tier) => (tier === 'MTF' ? 'range' : null) }).trades;
    expect(mtfAll.length).toBeGreaterThan(0);
    for (const t of mtfRanged) {
      expect(t.tier).toBe('MTF');
      const loc = location(t.symbol, t.tag!);
      if (t.side === 'long') expect(loc).toBeGreaterThanOrEqual(0.45);
      else expect(loc).toBeLessThanOrEqual(0.55);
    }
    const outside = all.filter((t) => (t.side === 'long' ? location(t.symbol, t.tag!) < 0.45 : location(t.symbol, t.tag!) > 0.55));
    if (outside.length) expect(ranged.length).not.toEqual(all.length);
    const { rrgDirectionAt } = await import('../src/screen/signals');
    for (const mode of ['heading', 'fastslow'] as const) {
      const turned = runBacktest(long, only, undefined, { closeAtEnd: true, selectionAt: (tier) => (tier === 'P4H' ? mode : null) }).trades;
      for (const t of turned) {
        if (t.symbol === 'BTCUSDT') continue;
        const d = long[t.symbol]!.candles['1d']!;
        let j = -1;
        for (let k = 0; k < d.length; k++) if (d[k]!.openTime + DAY <= t.tag!) j = k;
        expect(rrgDirectionAt(t.symbol, d, long.BTCUSDT!.candles['1d']!, d[j]!.openTime, mode), `${mode} ${t.symbol}`).toBe(t.side === 'long' ? 1 : -1);
      }
    }
    const { btcRegimeAt } = await import('../src/screen/signals');
    const btcD = long.BTCUSDT!.candles['1d']!;
    for (const t of runBacktest(long, only, undefined, { closeAtEnd: true, selectionAt: (tier) => (tier === 'P4H' ? 'btcregime' : null) }).trades) {
      let j = -1;
      for (let k = 0; k < btcD.length; k++) if (btcD[k]!.openTime + DAY <= t.tag!) j = k;
      expect(btcRegimeAt(btcD, btcD[j]!.openTime), `btcregime ${t.symbol}`).toBe(t.side === 'long' ? 1 : -1);
    }
  }, 120_000);

  test('radar: one shared EMA 50 row per coin, unless a strategy holds it (then one row per strategy)', async () => {
    const { botConfig, runBacktest } = await import('../src/index');
    const long = syntheticMarket(400, 7);
    const r = runBacktest(long, botConfig(START + 150 * DAY, START + 400 * DAY, 'ema50'), undefined, { closeAtEnd: false, radar: true });
    const rows = r.radar!.rows;
    expect(rows.every((x) => x.model === 'signal' && x.rrg === null)).toBe(true);
    for (const symbol of Object.keys(long)) {
      const mine = rows.filter((x) => x.symbol === symbol);
      const held = r.open.positions.filter((p) => p.symbol === symbol).length + r.open.pending.filter((p) => p.symbol === symbol).length;
      if (held) expect(mine.every((x) => x.status === 'in-position' || x.status === 'order-pending')).toBe(true);
      else expect(mine).toMatchObject([{ shared: true, tier: 'MTF' }]);
    }
    expect(rows.some((x) => /trend|signal/.test(x.note))).toBe(true);
  }, 60_000);

  test('the built-in signal settings equal the research config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return import('../src/screen/signals').then(({ SIGNAL_SETTINGS }) => {
      expect(SIGNAL_SETTINGS.components).toEqual(score.components);
    });
  });
});

describe('RRG as a magnifying glass (owner): reorders who gets a slot, never adds or drops a signal', () => {
  test('same signals seen; without a full cap it changes nothing', () => {
    const long = syntheticMarket(400, 7);
    const def = SIGNALS.find((s) => s.id === 'ema50_trend_vol')!;
    const b = defaultConfig(START + 150 * DAY, START + 400 * DAY);
    const run = (rrg: '1d' | null, alts: number) => runPortfolio(long, Object.keys(long), def, '1d', hiwin, b, score, { ...DEFAULT_CONTROLS, maxSameDirAlts: alts, maxOpenRiskPct: 100, rrgPriorityTf: rrg }).result;
    // Caps wide open: every signal trades either way, so A and B are identical.
    const a0 = run(null, 99), b0 = run('1d', 99);
    expect(compareTrades(a0.trades, b0.trades).swappedIn.n).toBe(0);
    expect(b0.trades.length).toBe(a0.trades.length);
    // Tight cap: same number of signals considered; only which ones got in may differ.
    const a1 = run(null, 1), b1 = run('1d', 1);
    expect(b1.setupsSeen).toBe(a1.setupsSeen);
    const d = compareTrades(a1.trades, b1.trades);
    expect(d.common + d.swappedIn.n).toBe(b1.trades.length);
  }, 120_000);
});

describe('RRG forward testing: logged on every trade, influence switched by time', () => {
  test('the EMA 50 bot records RRG at entry; a switch that is off equals no priority at all', async () => {
    const { botConfig, runBacktest } = await import('../src/index');
    const long = syntheticMarket(400, 7);
    const cfg = botConfig(START + 150 * DAY, START + 400 * DAY, 'ema50');
    const plain = runBacktest(long, cfg);
    expect(plain.trades.length).toBeGreaterThan(0);
    expect(plain.trades.every((t) => typeof t.rrg === 'number')).toBe(true);
    const off = runBacktest(long, { ...cfg, entryPriority: { rrgTf: '1d' } }, undefined, { closeAtEnd: true, rrgPriorityAt: () => false });
    expect(off.trades).toEqual(plain.trades);
    const on = runBacktest(long, { ...cfg, entryPriority: { rrgTf: '1d' } }, undefined, { closeAtEnd: true, rrgPriorityAt: () => true });
    expect(on.trades).toEqual(runBacktest(long, { ...cfg, entryPriority: { rrgTf: '1d' } }).trades);
  }, 120_000);
});

describe('entry timing: a limit dip after the daily close instead of a market entry', () => {
  test('B only trades signals A saw, always at a better price, and never after its window', () => {
    const long = syntheticMarket(400, 7);
    const def = SIGNALS.find((s) => s.id === 'ema50_trend_vol')!;
    const b = defaultConfig(START + 150 * DAY, START + 400 * DAY);
    const wide = { ...DEFAULT_CONTROLS, maxSameDirAlts: 99, maxOpenRiskPct: 100 };
    const a = runPortfolio(long, Object.keys(long), def, '1d', hiwin, b, score, wide).result.trades;
    const d = runPortfolio(long, Object.keys(long), def, '1d', hiwin, b, score, { ...wide, entryDip: { atr: 0.25, minutes: 90 } }).result.trades;
    expect(a.length).toBeGreaterThan(0);
    expect(d.length).toBeLessThanOrEqual(a.length);
    const bySignal = new Map(a.map((t) => [`${t.symbol}|${t.side}|${t.tag}`, t]));
    for (const t of d) {
      const m = bySignal.get(`${t.symbol}|${t.side}|${t.tag}`);
      expect(m).toBeDefined();
      expect(t.openedAt - t.tag!).toBeLessThanOrEqual(90 * 60_000);
      if (t.side === 'long') expect(t.entry).toBeLessThan(m!.entry);
      else expect(t.entry).toBeGreaterThan(m!.entry);
    }
  }, 120_000);
});

describe('the one-time 6-month check (locked)', () => {
  test('locked without the owner\'s phrase, and runs once', () => {
    expect(holdoutUnlocked(undefined, false).ok).toBe(false);
    expect(holdoutUnlocked('go', false).ok).toBe(false);
    expect(holdoutUnlocked(HOLDOUT_PHRASE, true).ok).toBe(false);
    expect(holdoutUnlocked(HOLDOUT_PHRASE, false).ok).toBe(true);
  });

  test('frozen on the bot\'s default strategy: EMA 50 trend, daily, target 1 ATR (hiwin), guideline controls', () => {
    expect(HOLDOUT_FROZEN).toMatchObject({ signal: EMA50_SIGNAL, tf: '1d', exit: 'hiwin', controls: DEFAULT_CONTROLS });
  });

  test('pass rule: every check must hold', () => {
    const good = { trades: 70, winRate: 0.7, expectancyR: 0.08, maxDrawdownPct: 6 };
    expect(holdoutVerdict(good).pass).toBe(true);
    expect(holdoutVerdict({ ...good, trades: 20 }).pass).toBe(false);
    expect(holdoutVerdict({ ...good, winRate: 0.55 }).pass).toBe(false);
    expect(holdoutVerdict({ ...good, expectancyR: 0.04 }).pass).toBe(false); // below half the research 0.103R
    expect(holdoutVerdict({ ...good, maxDrawdownPct: 30 }).pass).toBe(false);
  });
});
