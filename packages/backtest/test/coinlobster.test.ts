import { describe, expect, test } from 'vitest';
import { CL, clProbe } from '../src/screen/coinlobster';

describe('CoinLobster probe', () => {
  test('the Bearer key on every call, an alternative path only after a 404, never the key, an email or a key field', async () => {
    const key = 'cl_live_SECRET123', seen: { url: string; auth?: string }[] = [];
    const fake = async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, auth: init?.headers?.Authorization });
      const path = url.slice(CL.base.length);
      if (path === '/api/ai/v1/openapi.json') return { ok: true, status: 200, text: async () => JSON.stringify({ paths: { '/api/ai/v1/liq_zones': {}, '/api/ai/v1/my_access': {} } }) };
      if (path.startsWith('/api/ai/v1/liq_zones')) return { ok: false, status: 404, text: async () => 'not found' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ plan: 'pro', email: 'owner@example.com', key_prefix: 'cl_live_SEC', echo: key, note: `Bearer ${key}` }) };
    };
    const out = (await clProbe(key, fake)).join('\n');
    expect(out).toContain('Spec /api/ai/v1/openapi.json: 2 paths');
    expect(out).toContain(' (other) (2): /api/ai/v1/liq_zones, /api/ai/v1/my_access');
    expect(seen.every((x) => x.auth === `Bearer ${key}`)).toBe(true);
    // liq_zones 404s, so its alternative is tried; every other endpoint once.
    expect(seen.filter((x) => x.url.includes('scope=projected'))).toHaveLength(2);
    expect(seen.filter((x) => x.url.includes('scope=heat'))).toHaveLength(0);
    expect(out).toContain(' /api/ai/v1/my_access → HTTP 200');
    expect(out).toContain('"plan":"pro"');
    for (const s of ['SECRET123', 'owner@example.com', 'cl_live_SEC']) expect(out).not.toContain(s);
    expect((await clProbe(undefined, fake)).join('\n')).toContain('no COINLOBSTER_API_KEY secret');
  });
});
