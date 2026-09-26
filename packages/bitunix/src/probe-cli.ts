// npm run probe — checks the Bitunix API contract live (public endpoints).
import { createClient } from './client';
import { formatReport, runProbe } from './probe';

const results = await runProbe(createClient({ baseUrl: process.env.BITUNIX_BASE_URL }));
console.log(formatReport(results));
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${failed ? `${failed} FAIL` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
