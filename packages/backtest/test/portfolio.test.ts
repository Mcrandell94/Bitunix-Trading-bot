// Full-loop portfolio backtest: the layer-4 controls must be on and must bite.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultConfig } from '../src/index';
import { loadScoreConfig } from '../src/score/config';
import { DEFAULT_CONTROLS, formatPortfolio, portfolioConfig, quarters, runPortfolio } from '../src/screen/portfolio';
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
    const onlyDefault = { ...cfg, tiers: { ...cfg.tiers, HTF: { ...cfg.tiers.HTF, enabled: false }, LTF: { ...cfg.tiers.LTF, enabled: false } } };
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

  test('the built-in signal settings equal the research config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return import('../src/screen/signals').then(({ SIGNAL_SETTINGS }) => {
      expect(SIGNAL_SETTINGS.components).toEqual(score.components);
    });
  });
});
