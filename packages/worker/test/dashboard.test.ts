// The dashboard: password gate, read-only routes, and what it serves.
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DashboardData } from '@bot/store';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ControlError, authorized, silentLogger, startDashboard, type WorkerStatus } from '../src/index';

const PASSWORD = 'a long test password';
const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

const data: DashboardData = {
  session: { id: 1, startedAt: 1_700_000_000_000, startEquity: 10_000, symbols: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'], config: {}, codeSha: 'abc1234' },
  lastStepAt: 1_700_000_900_000,
  summary: { trades: 0, wins: 0, netUsd: 0, totalR: 0, feesUsd: 0, fundingUsd: 0 },
  equity: [], positions: [], orders: [], trades: [], scans: [],
  controls: { haltLive: false, pauses: [] }, controlEvents: [], radar: null, liveOrders: [],
};
const status: WorkerStatus = { startedAt: 1, paperEnabled: true, tradingEnabled: false, writeMode: 'disabled', codeSha: 'abc1234', nextWakeAt: 2, account: null };

test('the page script parses (a syntax error would leave the dashboard blank)', () => {
  const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(scripts.length).toBeGreaterThan(0);
  for (const js of scripts) expect(() => new Function(js)).not.toThrow();
});

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
  const controls: { body: unknown; source: string }[] = [];
  beforeAll(async () => {
    server = await startDashboard({
      db: {} as never, password: PASSWORD, port: 0, host: '127.0.0.1', status: () => status, log: silentLogger,
      control: async (body, source) => {
        const b = body as { action?: string };
        if (b.action === 'bad') throw new ControlError('unknown action');
        controls.push({ body, source });
        return { message: 'done' };
      },
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

  test('controls: only from the dashboard page, with the password', async () => {
    const post = (headers: Record<string, string>, body = '{"action":"halt-live"}') => get('/api/control', { method: 'POST', headers, body });
    const good = { ...auth.headers, 'Content-Type': 'application/json', 'X-Bot-Control': '1' };
    expect((await post({ 'Content-Type': 'application/json', 'X-Bot-Control': '1' })).status).toBe(401);
    expect((await post({ ...auth.headers, 'Content-Type': 'application/json' })).status).toBe(403); // no custom header
    expect((await post({ ...good, 'Content-Type': 'text/plain' })).status).toBe(403); // a plain form post
    expect((await post({ ...good, Origin: 'https://evil.example' })).status).toBe(403);
    expect(controls).toEqual([]);

    const ok = await post({ ...good, Origin: base });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ message: 'done' });
    expect(controls).toEqual([{ body: { action: 'halt-live' }, source: 'dashboard 127.0.0.1' }]);

    expect((await post(good, 'not json')).status).toBe(400);
    const bad = await post(good, '{"action":"bad"}');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'unknown action' });
    expect((await post(good, JSON.stringify({ action: 'halt-live', pad: 'x'.repeat(5000) }))).status).toBe(400);
    expect((await get('/api/state', { ...auth, method: 'PUT' })).status).toBe(405);
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
