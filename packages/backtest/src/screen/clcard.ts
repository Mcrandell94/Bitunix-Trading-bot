// CoinLobster (coinlobster.com REST, Pro plan; owner 2026-10-17: "lets add what we can from coinlobster") for the ETH / BTC
// cards: per coin, the whale flow against the coin's own history (/whales/context: 24h whale volume as a multiple of its
// logged daily average, net buy / sell, buy share now vs the last 7 days, how many covered coins run hot) and the net
// whale flow of the 4H bar the card closes (/whales/flow/{coin}, hourly buckets). Live data as of the call, display only:
// a line in the card's positioning block, not a POI source.
// Left out after the probe (2026-10-17, --cl-probe): the order book (50 levels a side, about 0.1% around the price, so no
// walls near the POIs) and the liquidations (the same 24h totals the CryptoDataAPI line already shows).
// The key is sent as `Authorization: Bearer <key>` and never logged. 50 credits a coin a close (20 + 30). Every call has
// a timeout; a failed one leaves its part out.

export const CL_CARD = { base: 'https://coinlobster.com/api/ai/v1', timeoutMs: 15_000, flowHours: 8, hotDays: 7 } as const;
const H = 3_600_000;

export interface ClCoin {
  /** When it was fetched (ms). */
  at: number;
  /** The coin's whale flow vs its own logged history; null when the call failed or the coin has no context. */
  whales: { usd24h: number; net24h: number; multiple: number | null; buyShare24h: number | null; buyShare7d: number | null; highestInDays: number; record: boolean } | null;
  /** How many covered coins run hot (24h flow above their own normal). */
  breadth: { elevated: number; total: number } | null;
  /** Net whale flow (buy − sell, $) over the 4H bar the card closes. */
  net4h: number | null;
  /** Which calls failed (no key or response text). */
  errors: string[];
}

type Res = { ok: boolean; status: number; json(): Promise<unknown> };
type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Res>;
type J = Record<string, unknown>;
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** The /whales/context answer for one coin. */
export function parseContext(j: unknown): Pick<ClCoin, 'whales' | 'breadth'> {
  const d = (j as J)?.data as J | undefined, s = d?.stats as J | undefined, b = d?.breadth as J | undefined;
  const usd = num(s?.usd_24h), net = num(s?.net_24h), el = num(b?.elevated), tot = num(b?.total);
  return {
    whales: usd == null || net == null ? null : {
      usd24h: usd, net24h: net, multiple: num(s?.multiple_vs_avg), buyShare24h: num(s?.buy_share_24h), buyShare7d: num(s?.buy_share_7d),
      highestInDays: num(s?.highest_in_days) ?? 0, record: s?.record === true,
    },
    breadth: el == null || tot == null ? null : { elevated: el, total: tot },
  };
}

/** Net whale flow (buy − sell) of the hourly buckets inside the 4H bar that closes at `close`; null without any. */
export function parseFlow4h(j: unknown, close: number): number | null {
  const rows = (((j as J)?.data as J | undefined)?.rows as J[] | undefined) ?? [];
  const inBar = rows.filter((r) => { const t = num(r.t); return t != null && t >= close - 4 * H && t < close; });
  return inBar.length ? inBar.reduce((a, r) => a + (num(r.buyUsd) ?? 0) - (num(r.sellUsd) ?? 0), 0) : null;
}

/** One coin's data (BTCUSDT / ETHUSDT) for the card of the 4H close `close`; null without a key. */
export async function clCoin(symbol: string, key: string | null | undefined, close: number, fetchFn: FetchFn = fetch as unknown as FetchFn, now = Date.now()): Promise<ClCoin | null> {
  if (!key) return null;
  const coin = symbol.replace(/USDT$/, ''), errors: string[] = [];
  const get = async (path: string): Promise<unknown> => {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), CL_CARD.timeoutMs);
    try {
      const r = await fetchFn(`${CL_CARD.base}${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: ac.signal });
      if (!r.ok) { errors.push(`${path.split('?')[0]}: HTTP ${r.status}`); return null; }
      return await r.json();
    } catch (e) { errors.push(`${path.split('?')[0]}: ${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message.split(key).join('***')}`); return null; }
    finally { clearTimeout(timer); }
  };
  const [ctx, flow] = await Promise.all([get(`/whales/context?coin=${coin}`), get(`/whales/flow/${coin}?hours=${CL_CARD.flowHours}`)]);
  return { at: now, ...parseContext(ctx), net4h: flow ? parseFlow4h(flow, close) : null, errors };
}
