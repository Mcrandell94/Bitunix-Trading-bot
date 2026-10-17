import { describe, expect, test } from 'vitest';
import { cotLatest, cotLines, cotUrl } from '../src/screen/cot';

const row = (date: string, v: number[]) => ({
  report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`,
  comm_positions_long_all: String(v[0]), comm_positions_short_all: String(v[1]),
  noncomm_positions_long_all: String(v[2]), noncomm_positions_short_all: String(v[3]),
  nonrept_positions_long_all: String(v[4]), nonrept_positions_short_all: String(v[5]),
});

describe('COT report (CFTC Legacy, futures only)', () => {
  test('reads the last two reports for a market code; bad answers give an error, not numbers', async () => {
    const urls: string[] = [];
    const ok = async (u: string) => { urls.push(u); return { ok: true, status: 200, json: async () => [row('2026-10-13', [1000, 3000, 20000, 15000, 4000, 7000]), row('2026-10-06', [1200, 2800, 19000, 16000, 4500, 6500])] }; };
    const r = await cotLatest('133741', ok);
    expect(urls[0]).toBe(cotUrl('133741'));
    expect(urls[0]).toContain('cftc_contract_market_code=133741');
    expect(r.reports.map((x) => [x.date, x.comL, x.nrS])).toEqual([['2026-10-13', 1000, 7000], ['2026-10-06', 1200, 6500]]);
    expect((await cotLatest('1', async () => ({ ok: false, status: 503, json: async () => null }))).error).toBe('HTTP 503');
    expect((await cotLatest('1', async () => ({ ok: true, status: 200, json: async () => [{ report_date_as_yyyy_mm_dd: '2026-10-13' }] }))).error).toBe('missing fields in the 2026-10-13 report');
  });

  test('the table: net contracts, long / short %, the change from the week before', async () => {
    const r = await cotLatest('133741', async () => ({ ok: true, status: 200, json: async () => [row('2026-10-13', [1000, 3000, 20000, 15000, 4000, 7000]), row('2026-10-06', [1200, 2800, 19000, 16000, 4500, 6500])] }));
    expect(cotLines(r.reports)).toEqual([
      ' Commercials: net −2,000 contracts (long 25.0% / short 75.0%) · week before net −1,600 (−400)',
      ' Institutional (non-commercials): net +5,000 contracts (long 57.1% / short 42.9%) · week before net +3,000 (+2,000)',
      ' Retail traders (non-reportable): net −3,000 contracts (long 36.4% / short 63.6%) · week before net −2,000 (−1,000)',
    ]);
  });
});
