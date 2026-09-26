// The dashboard: password gate, read-only routes, and what it serves.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DashboardData } from '@bot/store';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { authorized, silentLogger, startDashboard, type WorkerStatus } from '../src/index';

const PASSWORD = 'a long test password';
const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

const data: DashboardData = {
  session: { id: 1, startedAt: 1_700_000_000_000, startEquity: 10_000, symbols: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'], config: {}, codeSha: 'abc1234' },
  lastStepAt: 1_700_000_900_000,
  summary: { trades: 0, wins: 0, netUsd: 0, totalR: 0, feesUsd: 0, fundingUsd: 0 },
  equity: [], positions: [], orders: [], trades: [], scans: [],
};
const status: WorkerStatus = { startedAt: 1, paperEnabled: true, tradingEnabled: false, codeSha: 'abc1234', nextWakeAt: 2 };

describe('authorized', () => {
  test('any username, exact password only', () => {
    expect(authorized(basic('me', PASSWORD), PASSWORD)).toBe(true);
    expect(authorized(basic('', PASSWORD), PASSWORD)).toBe(true);
    expect(authorized(basic('me', `${PASSWORD} `), PASSWORD)).toBe(false);
    expect(authorized(basic('me', 'wrong'), PASSWORD)).toBe(false);
    expect(authorized(basic('me', 'pass:with:colons'), 'pass:with:colons')).toBe(true);
    expect(authorized(undefined, PASSWORD)).toBe(false);
    expect(authorized('Bearer x', PASSWORD)).toBe(false);
    expect(authorized('Basic !!!', PASSWORD)).toBe(false);
    expect(authorized(basic('me', ''), '')).toBe(false); // an empty password never opens it
  });
});

describe('dashboard server', () => {
  let server: Server;
  let base: string;
  let fail = false;
  beforeAll(async () => {
    server = await startDashboard({
      db: {} as never, password: PASSWORD, port: 0, host: '127.0.0.1', status: () => status, log: silentLogger,
      load: async () => { if (fail) throw new Error('db down'); return data; },
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const get = (path: string, init: RequestInit = {}) => fetch(base + path, init);
  const auth = { headers: { Authorization: basic('owner', PASSWORD) } };

  test('everything but the health check needs the password', async () => {
    expect((await get('/healthz')).status).toBe(200);
    for (const path of ['/', '/api/state', '/nope']) {
      const res = await get(path);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Basic /);
      expect(await res.text()).not.toContain('BTCUSDT');
    }
    expect((await get('/api/state', { headers: { Authorization: basic('owner', 'guess') } })).status).toBe(401);
  });

  test('serves the page and the state, with no caching and a strict CSP', async () => {
    const page = await get('/', auth);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain('<title>Bitunix Bot</title>');

    const state = await get('/api/state', auth);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ status, data });
  });

  test('read-only: no other methods, unknown paths 404, load errors are 500 without details', async () => {
    const post = await get('/api/state', { ...auth, method: 'POST', body: '{}' });
    expect(post.status).toBe(405);
    expect((await get('/admin', auth)).status).toBe(404);
    fail = true;
    const res = await get('/api/state', auth);
    fail = false;
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('db down');
  });
});
