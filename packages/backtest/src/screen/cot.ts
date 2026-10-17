// "COT Report Indicator" (Pine v5, © TradingNerd, MPL 2.0) for the owner's script library (owner 2026-10-17). On a crypto
// pair the script reads TradingView's CFTC Commitments of Traders series (LibraryCOT, Legacy report, futures only by
// default) for the base coin's CME futures (Bitcoin 133741, Ether 146021; USDT has none, so the pair's B side and the
// combined lines are empty) and tables the net contracts and long / short % of commercials, non-commercials
// ("Institutional") and non-reportable positions ("Retail Traders").
//
// The owner's "Open Interest" script (Pine v2, no author or licence header) plots the same report's open interest
// (QUANDL:CFTC/<root>_F_L_ALL, column 0; TradingView's Quandl feed has since closed): it is the report's first line here.
//
// Here the same Legacy figures come from the CFTC's public reporting API (publicreporting.cftc.gov, no key): the last
// two weekly reports (positions as of Tuesday, published Friday). Used by the preview only (the bot's worker does not
// read it); it gives no price levels, so it is not one of the card's POI scripts.

export const COT = {
  base: 'https://publicreporting.cftc.gov/resource',
  /** Legacy futures only (the script's default) and futures-and-options combined. */
  datasets: { futures: '6dca-aqww', combined: 'jun7-fc8e' },
  codes: { BTCUSDT: '133741', ETHUSDT: '146021' } as Record<string, string>,
  names: { BTCUSDT: 'CME Bitcoin', ETHUSDT: 'CME Ether' } as Record<string, string>,
} as const;

type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CotReport { date: string; oi: number; comL: number; comS: number; ncL: number; ncS: number; nrL: number; nrS: number }

export const cotUrl = (code: string, n = 2, dataset: string = COT.datasets.futures) =>
  `${COT.base}/${dataset}.json?${new URLSearchParams({ cftc_contract_market_code: code, $order: 'report_date_as_yyyy_mm_dd DESC', $limit: String(n) })}`;

/** The last `n` Legacy reports for a CFTC market code, newest first. */
export async function cotLatest(code: string, fetchFn: FetchFn = fetch as unknown as FetchFn, n = 2): Promise<{ reports: CotReport[]; error?: string }> {
  try {
    const res = await fetchFn(cotUrl(code, n));
    if (!res.ok) return { reports: [], error: `HTTP ${res.status}` };
    const rows = (await res.json()) as Record<string, string>[];
    if (!Array.isArray(rows)) return { reports: [], error: 'not a list' };
    const num = (r: Record<string, string>, k: string) => Number(r[k]);
    const reports = rows.map((r) => ({
      date: String(r.report_date_as_yyyy_mm_dd ?? '').slice(0, 10), oi: num(r, 'open_interest_all'),
      comL: num(r, 'comm_positions_long_all'), comS: num(r, 'comm_positions_short_all'),
      ncL: num(r, 'noncomm_positions_long_all'), ncS: num(r, 'noncomm_positions_short_all'),
      nrL: num(r, 'nonrept_positions_long_all'), nrS: num(r, 'nonrept_positions_short_all'),
    }));
    const bad = reports.find((x) => [x.comL, x.comS, x.ncL, x.ncS, x.nrL, x.nrS].some((v) => !Number.isFinite(v))); // open interest is optional
    return bad ? { reports: [], error: `missing fields in the ${bad.date || 'first'} report` } : { reports };
  } catch (e) { return { reports: [], error: (e as Error).message }; }
}

/** The preview's lines: per group, net contracts and long % (the script's table), and the change from the week before. */
export function cotLines(rep: ReadonlyArray<CotReport>): string[] {
  const [a, b] = rep;
  if (!a) return [' no report'];
  const fmt = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x)).toLocaleString('en-US')}`;
  const row = (label: string, l: number, s: number, pl?: number, ps?: number) => {
    const pct = (l / (l + s)) * 100, ch = pl != null && ps != null ? ` · week before net ${fmt(pl - ps)} (${fmt(l - s - (pl - ps))})` : '';
    return ` ${label}: net ${fmt(l - s)} contracts (long ${pct.toFixed(1)}% / short ${(100 - pct).toFixed(1)}%)${ch}`;
  };
  const oiCh = b && b.oi > 0 ? ` · week before ${Math.round(b.oi).toLocaleString('en-US')} (${a.oi >= b.oi ? '+' : '−'}${Math.abs((a.oi / b.oi - 1) * 100).toFixed(1)}%)` : '';
  return [
    ...(Number.isFinite(a.oi) ? [` Open interest: ${Math.round(a.oi).toLocaleString('en-US')} contracts${oiCh}`] : []),
    row('Commercials', a.comL, a.comS, b?.comL, b?.comS),
    row('Institutional (non-commercials)', a.ncL, a.ncS, b?.ncL, b?.ncS),
    row('Retail traders (non-reportable)', a.nrL, a.nrS, b?.nrL, b?.nrS),
  ];
}
