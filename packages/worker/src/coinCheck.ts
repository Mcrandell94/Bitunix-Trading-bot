// One-off diagnostic (owner 2026-10-07: "Bot didn't signal for tau or river?"): for each named coin, is it on Bitunix,
// does it pass the scan (API-tradable, crypto, $0.5M+ 24h volume, rank), how much history it has, its RSI now, and every
// row the 9 live models produce on it over the last 60 days. Read-only: public market data, nothing is traded or saved.
// Run: npx tsx packages/worker/src/coinCheck.ts TAU RIVER, or on the research workflow: controls = --coin-check TAU,RIVER

import { rsi10LiveSignals, rsiFrameworkSignals } from '@bot/backtest';
import { createClient, fetchCandles, fetchTickers, fetchTradingPairs, type Interval } from '@bot/bitunix';
import { closedOnly, type Candle } from '@bot/marketdata';
import { HISTORY_DAYS } from './candleMemory';
import { RSI_MAX_COINS, RSI_MIN_VOLUME } from './rsiSignals';
import { isNonCrypto, selectUniverse } from './scan';

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

function wilderRsi(closes: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  if (closes.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i]! - closes[i - 1]!; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
const lastRsi = (cs: Candle[]) => { const r = wilderRsi(cs.map((c) => c.close)); const v = r.at(-1); return v == null ? '-' : v.toFixed(1); };
function weekly(d: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of d) {
    const wk = Math.floor((c.openTime - 4 * DAY) / (7 * DAY)); // weeks start Monday 00:00 UTC
    const last = out.at(-1);
    if (last && Math.floor((last.openTime - 4 * DAY) / (7 * DAY)) === wk) { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; }
    else out.push({ ...c });
  }
  return out;
}

export async function coinCheck(input: string[]): Promise<void> {
  const names = input.map((s) => s.toUpperCase());
  const client = createClient({});
  const now = Date.now();
  const tickers = await fetchTickers(client);
  const pairs = await fetchTradingPairs(client);
  const tradable = new Set(pairs.filter((p) => p.apiSupported !== false).map((p) => p.symbol));
  const list = selectUniverse(tickers, { universe: 'all', minQuoteVolume24h: RSI_MIN_VOLUME, maxExtraSymbols: RSI_MAX_COINS }, tradable);
  console.log(`scan list now: ${list.length} coins ($${RSI_MIN_VOLUME / 1e6}M+ 24h volume, API-tradable, crypto)`);
  for (const floor of [1_000_000, 500_000, 350_000, 250_000, 100_000]) {
    const l = selectUniverse(tickers, { universe: 'all', minQuoteVolume24h: floor, maxExtraSymbols: 1000 }, tradable);
    console.log(`  floor $${floor / 1e6}M: ${l.length} coins`);
  }
  const btc = closedOnly(await fetchCandles(client, { symbol: 'BTCUSDT', interval: '1d', from: now - 120 * DAY, to: now, type: 'LAST_PRICE' }), '1d', now);

  for (const name of names) {
    console.log(`\n=== ${name} ===`);
    const matches = tickers.filter((t) => t.symbol.replace(/USDT$/, '').includes(name));
    if (!matches.length) { console.log('not listed on Bitunix as a USDT perp'); continue; }
    for (const t of matches) {
      const sym = t.symbol, pos = list.indexOf(sym);
      const pair = pairs.find((p) => p.symbol === sym);
      console.log(`${sym}: 24h volume $${((t.quoteVolume24h ?? 0) / 1e6).toFixed(2)}M · API trading ${pair?.apiSupported === false ? 'NO' : 'yes'} · ${isNonCrypto(sym) ? 'non-crypto (excluded)' : 'crypto'} · ${pos >= 0 ? `ON the scan list (#${pos + 1})` : 'NOT on the scan list'}`);
      if (sym !== name + 'USDT' && matches.length > 3) continue; // only detail the exact match when the name is common
      const got: Record<string, Candle[]> = {};
      for (const tf of ['1d', '4h', '1h', '15m'] as const) {
        got[tf] = closedOnly(await fetchCandles(client, { symbol: sym, interval: tf as Interval, from: now - HISTORY_DAYS[tf] * DAY, to: now, type: 'LAST_PRICE' }), tf, now);
      }
      const d1 = got['1d']!, h4 = got['4h']!;
      console.log(`  history: daily ${d1.length} bars (from ${d1[0] ? iso(d1[0].openTime) : '-'}), 4H ${h4.length}, weekly ${weekly(d1).length} · needs: daily 60+ (daily models), weekly 40+ (weekly models), 4H 300+ (4H models), 15M-RSI10 15m 1500+ / 1h 200+ / 4H 300+ / daily 100+`);
      console.log(`  RSI now: weekly ${lastRsi(weekly(d1))} · daily ${lastRsi(d1)} · 4H ${lastRsi(h4)} · 1h ${lastRsi(got['1h']!)} · 15m ${lastRsi(got['15m']!)} · last close ${d1.at(-1)?.close ?? '-'}`);
      const rows = [
        ...rsiFrameworkSignals(sym, d1, h4, now, 60, btc),
        ...rsi10LiveSignals(sym, d1.slice(-400), h4.filter((c) => c.openTime >= now - 400 * DAY), got['1h']!, got['15m']!, now, 60, btc),
      ].filter((r) => r.variant === 0);
      if (!rows.length) console.log('  no signal from any live model in the last 60 days');
      for (const r of rows) {
        console.log(`  ${r.model} (${r.side}) ${r.status} · signal ${iso(r.signalAt)} · entry ${r.entry ?? '-'} · stop ${r.stop ?? '-'} · ${r.status === 'closed' ? `closed ${r.exit} ${r.r}R` : r.status === 'open' ? `open ${r.r}R` : ''} · plans ${r.plans.join('/')}`);
      }
    }
  }
}

if (process.argv[1]?.endsWith('coinCheck.ts')) coinCheck(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
