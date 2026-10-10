import { describe, expect, test } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { parseFundingCsv, parseKlineCsv, parseMetricsCsv, unzipFirst } from '../src/binancevision';

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
