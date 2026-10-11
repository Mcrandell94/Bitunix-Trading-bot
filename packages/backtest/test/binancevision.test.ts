import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { binanceCandles, klineGaps, parseFundingCsv, parseKlineCsv, parseKlineOhlcvCsv, parseMetricsCsv, unzipFirst, type Archive, type BinanceCandle } from '../src/binancevision';

/** A one-file zip archive as the Binance archive serves them (deflated, or stored with method 0). */
function zipOf(name: string, text: string, method: 0 | 8 = 8): Buffer {
  const raw = Buffer.from(text), data = method === 8 ? deflateRawSync(raw) : raw, nm = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10);
  cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42);
  const cdAt = local.length + nm.length + data.length, end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length + nm.length, 12); end.writeUInt32LE(cdAt, 16);
  return Buffer.concat([local, nm, data, cd, nm, end]);
}

describe('Binance archive files', () => {
  test('unzips the one file, deflated or stored', () => {
    const text = 'calc_time,funding_interval_hours,last_funding_rate\n1704067200000,8,0.00010000\n';
    expect(unzipFirst(zipOf('BTCUSDT-fundingRate-2024-01.csv', text)).toString()).toBe(text);
    expect(unzipFirst(zipOf('x.csv', text, 0)).toString()).toBe(text);
    expect(() => unzipFirst(Buffer.from('not a zip at all, just some bytes'))).toThrow('not a zip');
  });

  test('funding: header dropped, the last column is the rate, microsecond times read as ms', () => {
    expect(parseFundingCsv('calc_time,funding_interval_hours,last_funding_rate\n1704067200000,8,0.00010000\n1704096000000000,8,-0.00052\n'))
      .toEqual([{ time: 1704067200000, rate: 0.0001 }, { time: 1704096000000, rate: -0.00052 }]);
    expect(parseFundingCsv('1704067200000,0.00030000\n')).toEqual([{ time: 1704067200000, rate: 0.0003 }]); // older files: no header
  });

  test('klines: quote volume and taker buy quote volume per open time', () => {
    const csv = 'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n'
      + '1704067200000,100,110,95,105,10,1704081599999,1000,50,6,620,0\n';
    expect(parseKlineCsv(csv)).toEqual([{ t: 1704067200000, vol: 1000, buy: 620 }]);
  });

  test('metrics: 5-minute open interest in base units at UTC times', () => {
    const csv = 'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio\n'
      + '2024-01-01 00:05:00,BTCUSDT,80000.5,3400000000,1.2,1.1,1.3,0.9\n';
    expect(parseMetricsCsv(csv)).toEqual([{ t: Date.UTC(2024, 0, 1, 0, 5), oi: 80000.5 }]);
  });
});

describe('Binance candles (ETH bot)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const DAY = 86_400_000, put = (path: string, v: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(v)); };
  const bar = (t: number): BinanceCandle => ({ openTime: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, buy: 6 });
  const days = (a: string, n: number) => Array.from({ length: n }, (_, k) => bar(Date.parse(`${a}T00:00:00Z`) + k * DAY));

  test('klines parser: open/high/low/close, quote volume as the volume, taker buy quote volume; bad rows dropped', () => {
    const csv = 'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n'
      + '1704067200000,100,110,95,105,10,1704081599999,1000,50,6,620,0\n'
      + '1704081600000000,105,106,104,105.5,3,1704095999999,316,20,1,105,0\n'
      + '1704096000000,105,100,104,105,3,1704095999999,316,20,1,105,0\n'; // high under low: dropped
    expect(parseKlineOhlcvCsv(csv)).toEqual([
      { openTime: 1704067200000, open: 100, high: 110, low: 95, close: 105, volume: 1000, buy: 620 },
      { openTime: 1704081600000, open: 105, high: 106, low: 104, close: 105.5, volume: 316, buy: 105 },
    ]);
  });

  test('range loader: listed months from monthly files, later months from daily files, cut to [from, to) and closed bars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bv-')), a: Archive = { cacheDir: dir, log: () => {}, errors: [] };
    const pre = 'futures/um/monthly/klines/ETHUSDT/1d';
    put(join(dir, 'bv', 'list', 'data_futures_um_monthly_klines_ETHUSDT_1d_.json'), { at: Date.now(), keys: [`data/${pre}/ETHUSDT-1d-2024-01.zip`, `data/${pre}/ETHUSDT-1d-2024-01.zip.CHECKSUM`, `data/${pre}/ETHUSDT-1d-2024-02.zip`] });
    put(join(dir, 'bv', pre, 'ETHUSDT-1d-2024-01.json'), { rows: days('2024-01-01', 31) });
    put(join(dir, 'bv', pre, 'ETHUSDT-1d-2024-02.json'), { rows: days('2024-02-01', 29) });
    for (const d of ['2024-03-01', '2024-03-02']) put(join(dir, 'bv', 'futures/um/daily/klines/ETHUSDT/1d', `ETHUSDT-1d-${d}.json`), { rows: days(d, 1) });
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { asked.push(url); return new Response(null, { status: 404 }); });
    const now = Date.parse('2024-03-04T12:00:00Z');
    const got = await binanceCandles(a, 'ETHUSDT', '1d', Date.parse('2023-12-01'), Date.parse('2024-03-10'), now);
    expect(got.length).toBe(31 + 29 + 2);
    expect(got[0]!.openTime).toBe(Date.parse('2024-01-01'));
    expect(got.at(-1)!.openTime).toBe(Date.parse('2024-03-02'));
    expect(asked).toEqual(['https://data.binance.vision/data/futures/um/daily/klines/ETHUSDT/1d/ETHUSDT-1d-2024-03-03.zip']); // not published yet: a 404
    expect(a.errors).toEqual([]);
    const cut = await binanceCandles(a, 'ETHUSDT', '1d', Date.parse('2024-01-15'), Date.parse('2024-02-03'), now);
    expect(cut.map((b) => new Date(b.openTime).toISOString().slice(0, 10))).toEqual([...Array.from({ length: 17 }, (_, k) => `2024-01-${String(15 + k).padStart(2, '0')}`), '2024-02-01', '2024-02-02']);
    const open = await binanceCandles(a, 'ETHUSDT', '1d', Date.parse('2024-02-27'), Date.parse('2024-03-10'), Date.parse('2024-03-02T12:00:00Z'));
    expect(open.at(-1)!.openTime).toBe(Date.parse('2024-03-01')); // 03-02 is still forming at that time
  });

  test('gaps: missing bars between the first and the last', () => {
    const H = 3_600_000;
    expect(klineGaps([{ openTime: 0 }, { openTime: H }, { openTime: 4 * H }, { openTime: 5 * H }], '1h')).toBe(2);
    expect(klineGaps([], '1h')).toBe(0);
  });
});
