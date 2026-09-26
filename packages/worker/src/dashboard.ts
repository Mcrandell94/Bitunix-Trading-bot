// Read-only web dashboard, served by the worker itself. One HTML page plus
// one JSON endpoint; no controls. Anything that changes what the bot does
// (the master switch, paper trading) stays in Railway variables.
//
// Protected by HTTP Basic auth: any username, password = DASHBOARD_PASSWORD.
// Without a password the dashboard doesn't start at all.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadDashboard, type DashboardData, type Db } from '@bot/store';
import type { Logger } from './log';

/** Live worker facts the database doesn't hold. */
export interface WorkerStatus {
  startedAt: number;
  paperEnabled: boolean;
  tradingEnabled: boolean;
  codeSha: string | null;
  /** When the loop wakes next; null before the first wait. */
  nextWakeAt: number | null;
}

export interface DashboardOptions {
  db: Db;
  password: string;
  port: number;
  host?: string;
  status: () => WorkerStatus;
  log: Logger;
  /** For tests. */
  load?: (db: Db) => Promise<DashboardData>;
}

const PAGE = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Basic auth with any username; compares hashes in constant time. */
export function authorized(header: string | undefined, password: string): boolean {
  if (!password || !header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  return timingSafeEqual(digest(decoded.slice(colon + 1)), digest(password));
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

export function dashboardHandler(opts: DashboardOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const load = opts.load ?? ((db: Db) => loadDashboard(db));
  return (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed', { Allow: 'GET, HEAD' });
    if (path === '/healthz') return send(res, 200, 'text/plain', 'ok');
    if (!authorized(req.headers.authorization, opts.password)) {
      return send(res, 401, 'text/plain', 'password required', { 'WWW-Authenticate': 'Basic realm="Bitunix bot", charset="UTF-8"' });
    }
    if (path === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (path === '/api/state') {
      load(opts.db).then(
        (data) => send(res, 200, 'application/json', JSON.stringify({ status: opts.status(), data })),
        (err: Error) => {
          opts.log.error('dashboard: load failed', { error: err.message });
          send(res, 500, 'application/json', JSON.stringify({ error: 'could not load state' }));
        },
      );
      return;
    }
    send(res, 404, 'text/plain', 'not found');
  };
}

/** Starts the dashboard; resolves once it is listening. */
export function startDashboard(opts: DashboardOptions): Promise<Server> {
  const server = createServer(dashboardHandler(opts));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      opts.log.info('dashboard listening', { port: opts.port });
      resolve(server);
    });
  });
}
