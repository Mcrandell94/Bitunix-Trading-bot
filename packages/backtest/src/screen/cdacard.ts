// CryptoDataAPI (cryptodataapi.com, Pro plan; owner 2026-10-17) for the ETH / BTC cards: per coin, the Hyperliquid
// market makers' liquidation levels near the price (its perp "GEX"), the 24h realized liquidations (OKX + Bybit +
// Hyperliquid; Binance not covered), Binance's long / short account ratio, its 24h regime model and, for BTC, Deribit's
// options max pain. Live data as of the call (not a backtest input). The key is sent as the X-API-Key header and never
// logged. Display only.
//
// - Market-maker levels: the GEX endpoint's `levels` (liquidation clusters of market-maker accounts within a few % of
//   the mark), those of $1M or more; they join the card's liquidity family. Max pain joins the level family.
// - Every call has a timeout; a failed one leaves its part out (the card is built without it).

export const CDA_CARD = { base: 'https://cryptodataapi.com', header: 'X-API-Key', minLevelUsd: 1_000_000, timeoutMs: 15_000 } as const;

export interface CdaMmLevel { price: number; usd: number; side: 'long' | 'short'; accounts: number }
export interface CdaCoin {
  /** When it was fetched (ms). */
  at: number;
  mark: number | null; mmLevels: CdaMmLevel[]; gammaFlip: number | null; mmNetUsd: number | null;
  liq24h: { long: number; short: number } | null;
  lsRatio: number | null; topLsRatio: number | null;
  regime: { name: string; confidence: number; since: string | null } | null;
  maxPain: number | null; putCall: number | null;
  /** Which calls failed (no key or response text). */
  errors: string[];
}

type Res = { ok: boolean; status: number; json(): Promise<unknown> };
type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Res>;

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
type J = Record<string, unknown>;

/** The GEX response for one coin: mark, gamma flip, market makers' net delta and their liquidation levels ($1M+). */
export function parseGex(j: unknown, coin: string): Pick<CdaCoin, 'mark' | 'mmLevels' | 'gammaFlip' | 'mmNetUsd'> {
  const c = ((j as J)?.coins as J | undefined)?.[coin] as J | undefined;
  const levels = Array.isArray(c?.levels) ? (c!.levels as J[]) : [];
  return {
    mark: num(c?.mark), gammaFlip: num(c?.gamma_flip), mmNetUsd: num(c?.mm_net_delta),
    mmLevels: levels.map((l) => ({ price: num(l.price) ?? NaN, usd: num(l.total_usd) ?? 0, side: l.side === 'short' ? 'short' as const : 'long' as const, accounts: num(l.n_accounts) ?? 0 }))
      .filter((l) => Number.isFinite(l.price) && l.usd >= CDA_CARD.minLevelUsd).sort((a, b) => a.price - b.price),
  };
}
export function parseLiq(j: unknown): CdaCoin['liq24h'] {
  const r = (((j as J)?.data as J[] | undefined) ?? [])[0];
  const long = num(r?.long_liquidation_usd_24h), short = num(r?.short_liquidation_usd_24h);
  return long == null || short == null ? null : { long, short };
}
export function parseLs(j: unknown): Pick<CdaCoin, 'lsRatio' | 'topLsRatio'> {
  return { lsRatio: num((j as J)?.long_short_ratio), topLsRatio: num((j as J)?.top_trader_long_short_ratio) };
}
export function parseRegime(j: unknown): CdaCoin['regime'] {
  const r = (j as J)?.regime as J | undefined, conf = num(r?.confidence);
  return r && typeof r.name === 'string' && conf != null ? { name: r.name, confidence: conf, since: typeof r.in_regime_since === 'string' ? r.in_regime_since : null } : null;
}
export function parseOptions(j: unknown): Pick<CdaCoin, 'maxPain' | 'putCall'> {
  const rows = ((j as J)?.data as J[] | undefined) ?? [], all = rows.find((r) => r.exchange_name === 'All') ?? rows[0];
  return { maxPain: num(all?.max_pain), putCall: num(all?.put_call_ratio) };
}

/** One coin's data (BTCUSDT / ETHUSDT); null without a key. */
export async function cdaCoin(symbol: string, key: string | null | undefined, fetchFn: FetchFn = fetch as unknown as FetchFn, now = Date.now()): Promise<CdaCoin | null> {
  if (!key) return null;
  const coin = symbol.replace(/USDT$/, ''), errors: string[] = [];
  const get = async (path: string): Promise<unknown> => {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), CDA_CARD.timeoutMs);
    try {
      const r = await fetchFn(`${CDA_CARD.base}${path}`, { headers: { [CDA_CARD.header]: key }, signal: ac.signal });
      if (!r.ok) { errors.push(`${path.split('?')[0]}: HTTP ${r.status}`); return null; }
      return await r.json();
    } catch (e) { errors.push(`${path.split('?')[0]}: ${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message.split(key).join('***')}`); return null; }
    finally { clearTimeout(timer); }
  };
  const [gex, liq, ls, reg, opt] = await Promise.all([
    get(`/api/v1/quant/gex?coin=${coin}`),
    get(`/api/v1/market-intelligence/liquidations?symbol=${coin}`),
    get(`/api/v1/derivatives/binance/long-short-ratio?symbol=${coin}USDT`),
    get(`/api/v1/quant/coins/${coin}?horizon=24h`),
    coin === 'BTC' ? get('/api/v1/market-intelligence/options?symbol=BTC') : Promise.resolve(null), // BTC options only
  ]);
  return { at: now, ...parseGex(gex, coin), liq24h: parseLiq(liq), ...parseLs(ls), regime: parseRegime(reg), ...(opt ? parseOptions(opt) : { maxPain: null, putCall: null }), errors };
}

/** $ amounts on the card: $110.5M, $1.2B, $950k. */
export const usdShort = (x: number) => { const a = Math.abs(x), s = x < 0 ? '−' : ''; return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : `${s}$${Math.round(a / 1e3)}k`; };
