import { describe, expect, test } from 'vitest';
import { CL, clProbe } from '../src/screen/coinlobster';

describe('CoinLobster probe', () => {
  test('lists the spec, calls under its server with the Bearer key, never prints the key, an email or a key field', async () => {
    const key = 'cl_live_SECRET123', seen: { url: string; auth?: string }[] = [];
    const spec = { servers: [{ url: 'https://coinlobster.com/api/ai/v1' }], paths: { '/market/liquidations': { get: { summary: 'Forced closes', parameters: [{ name: 'coin', in: 'query', required: true }] } }, '/status': { get: { summary: 'Up?' } } } };
    const fake = async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, auth: init?.headers?.Authorization });
      if (url === `${CL.base}/openapi.json`) return { ok: true, status: 200, text: async () => JSON.stringify(spec) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ plan: 'pro', email: 'owner@example.com', key_prefix: 'cl_live_SEC', echo: key, note: `Bearer ${key}` }) };
    };
    const out = (await clProbe(key, fake)).join('\n');
    expect(out).toContain('Spec /openapi.json: HTTP 200 · 2 paths · server "https://coinlobster.com/api/ai/v1"');
    expect(out).toContain(' GET /market/liquidations: Forced closes · coin*');
    expect(seen.every((x) => x.auth === `Bearer ${key}`)).toBe(true);
    expect(seen.slice(1).map((x) => x.url)).toEqual(CL.probes.map((p) => `${CL.base}/api/ai/v1${p}`));
    expect(out).toContain(' /api/ai/v1/credits/balance → HTTP 200');
    expect(out).toContain('"plan":"pro"');
    for (const s of ['SECRET123', 'owner@example.com', 'cl_live_SEC']) expect(out).not.toContain(s);
    expect((await clProbe(undefined, fake)).join('\n')).toContain('no COINLOBSTER_API_KEY secret');
  });
});
