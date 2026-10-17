// "BTCUSDSHORTS BTCUSDLONGS - Bitfinex BTC Shorts & Longs" (Pine v3; the copy given has no licence header,
// TradingView's default for open scripts is MPL 2.0) for the owner's script library (owner 2026-10-17). The script only
// plots the close of TradingView's BITFINEX:BTCUSDLONGS and BITFINEX:BTCUSDSHORTS series (Bitfinex's open BTC margin
// longs and shorts, in BTC) on the chart's timeframe (pow(x, 1.0) leaves them as they are).
//
// Here the same series come from Bitfinex's public stats API (no key): pos.size:1m:tBTCUSD:long / short, 1-minute
// values; a bar's close is the last value at or before its end. Used by the preview only (the bot's worker does not
// read it); it gives no price levels, so it is not one of the card's POI scripts.

export const BFX = { base: 'https://api-pub.bitfinex.com/v2/stats1', gapMs: 400 } as const;
export type BfxSide = 'long' | 'short';
type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const bfxUrl = (side: BfxSide, end: number) => `${BFX.base}/pos.size:1m:tBTCUSD:${side}/hist?end=${end}&limit=1&sort=-1`;

/** The last 1-minute value at or before each time, oldest call first; null where Bitfinex gives none (errors listed). */
export async function bfxPosAt(side: BfxSide, ends: ReadonlyArray<number>, fetchFn: FetchFn = fetch as unknown as FetchFn, gapMs: number = BFX.gapMs): Promise<{ values: (number | null)[]; errors: string[] }> {
  const values: (number | null)[] = [], errors: string[] = [];
  for (const [k, end] of ends.entries()) {
    if (k > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    try {
      const res = await fetchFn(bfxUrl(side, end));
      if (!res.ok) { errors.push(`${side} ${end}: HTTP ${res.status}`); values.push(null); continue; }
      const rows = (await res.json()) as unknown;
      const row = Array.isArray(rows) && Array.isArray(rows[0]) ? (rows[0] as unknown[]) : null;
      const v = row && typeof row[1] === 'number' && typeof row[0] === 'number' && row[0] <= end ? row[1] : null;
      values.push(v);
    } catch (e) { errors.push(`${side} ${end}: ${(e as Error).message}`); values.push(null); }
  }
  return { values, errors };
}

/** The preview's lines: per timeframe, the longs and shorts at the last close, their change over `back` bars, the ratio. */
export function bfxLines(rows: ReadonlyArray<{ tf: string; at: string; longs: number | null; longsAgo: number | null; shorts: number | null; shortsAgo: number | null }>, back: number): string[] {
  const n = (x: number | null) => (x == null ? '-' : Math.round(x).toLocaleString('en-US'));
  const ch = (x: number | null, y: number | null) => (x == null || y == null || y === 0 ? '' : ` (${back} bars: ${x >= y ? '+' : '−'}${Math.abs((x / y - 1) * 100).toFixed(1)}%)`);
  return rows.map((r) => ` ${r.tf} (close ${r.at}): longs ${n(r.longs)} BTC${ch(r.longs, r.longsAgo)} · shorts ${n(r.shorts)} BTC${ch(r.shorts, r.shortsAgo)}${r.longs != null && r.shorts ? ` · longs / shorts ${(r.longs / r.shorts).toFixed(1)}` : ''}`);
}
