// Which free market-data sources are reachable from GitHub's runners, and how
// far back their open-interest / long-short history goes? No keys. Prints a
// table; exit code 0 regardless (it's a survey, not a test).
const checks = [
  { name: 'Bybit OI history (1h)', url: 'https://api.bybit.com/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=1h&limit=200', rows: (j) => j.result?.list, time: (r) => Number(r.timestamp) },
  { name: 'Bybit long/short ratio', url: 'https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=BTCUSDT&period=1h&limit=500', rows: (j) => j.result?.list, time: (r) => Number(r.timestamp) },
  { name: 'OKX OI history (1H)', url: 'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=BTC-USDT-SWAP&period=1H&limit=100', rows: (j) => j.data, time: (r) => Number(r[0]) },
  { name: 'OKX long/short (1H)', url: 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract?instId=BTC-USDT-SWAP&period=1H&limit=100', rows: (j) => j.data, time: (r) => Number(r[0]) },
  { name: 'Binance OI history (1h)', url: 'https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=500', rows: (j) => j, time: (r) => Number(r.timestamp) },
  { name: 'Binance taker buy/sell', url: 'https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=1h&limit=500', rows: (j) => j, time: (r) => Number(r.timestamp) },
  { name: 'Fear & Greed (alternative.me)', url: 'https://api.alternative.me/fng/?limit=0&format=json', rows: (j) => j.data, time: (r) => Number(r.timestamp) * 1000 },
  { name: 'CoinGecko BTC dominance', url: 'https://api.coingecko.com/api/v3/global', rows: (j) => (j.data ? [j.data] : null), time: () => Date.now() },
];
const day = (t) => new Date(t).toISOString().slice(0, 10);
for (const c of checks) {
  try {
    const res = await fetch(c.url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) { console.log(`${c.name.padEnd(32)} HTTP ${res.status} ${text.slice(0, 80).replace(/\s+/g, ' ')}`); continue; }
    const rows = c.rows(JSON.parse(text));
    if (!Array.isArray(rows) || !rows.length) { console.log(`${c.name.padEnd(32)} ok, but no rows: ${text.slice(0, 80)}`); continue; }
    const times = rows.map(c.time).filter(Number.isFinite);
    console.log(`${c.name.padEnd(32)} ok  ${rows.length} rows  ${day(Math.min(...times))} -> ${day(Math.max(...times))}`);
  } catch (err) {
    console.log(`${c.name.padEnd(32)} FAILED ${err.message}`);
  }
}
