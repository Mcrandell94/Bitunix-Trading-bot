// CLI entry point.
//   npm run migrate          apply database migrations
//   npm run scan -- 4h       one scan of the last closed bar, then exit
//   npm start                migrate, then scan every bar close until stopped

import { createClient } from '@bot/bitunix';
import type { Timeframe } from '@bot/signals';
import { createPool, migrate } from '@bot/store';
import { loadConfig } from './config';
import { jsonLogger } from './log';
import { loop, runClose } from './run';

const log = jsonLogger();
const [command = 'run', arg] = process.argv.slice(2);

async function main(): Promise<number> {
  const config = loadConfig();
  log.info('starting', { command, tradingEnabled: config.tradingEnabled, universe: config.universe, timeframes: config.timeframes });
  const db = createPool(config.databaseUrl);
  try {
    const applied = await migrate(db);
    if (applied.length) log.info('migrations applied', { applied });
    if (command === 'migrate') return 0;

    const deps = { client: createClient({ baseUrl: config.bitunixBaseUrl }), db, config, log };
    if (command === 'scan') {
      const tfs = (arg ? [arg] : config.timeframes) as Timeframe[];
      const done = await runClose(deps, tfs, Date.now());
      return done.length === tfs.length ? 0 : 1;
    }
    if (command === 'run') {
      const stop = new AbortController();
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { log.info('stopping', { signal: sig }); stop.abort(); });
      await loop(deps, { signal: stop.signal });
      return 0;
    }
    log.error('unknown command', { command });
    return 2;
  } finally {
    await db.end();
  }
}

main().then((code) => process.exit(code), (err) => {
  log.error('fatal', { error: (err as Error).stack ?? String(err) });
  process.exit(1);
});
