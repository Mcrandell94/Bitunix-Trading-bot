// Web dashboard, served by the worker itself: one HTML page, a JSON state
// endpoint and a control endpoint for the kill switches. Controls can only
// make the bot safer (see controls.ts); turning live trading on stays in the
// Railway variables.
//
// Protected by HTTP Basic auth: any username, password = DASHBOARD_PASSWORD.
// Without a password the dashboard doesn't start at all.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { WriteMode } from '@bot/bitunix';
import type { Tier } from '@bot/risk';
import { loadDashboard, type DashboardData, type Db } from '@bot/store';
import type { AccountSnapshot } from './account';
import { ControlError } from './controls';
import type { Logger } from './log';

/** Live worker facts the database doesn't hold. */
export interface WorkerStatus {
  startedAt: number;
  paperEnabled: boolean;
  tradingEnabled: boolean;
  /** Which tiers the code has switched on (a tier off here can't be turned on from the dashboard). */
  tiersEnabled: Record<Tier, boolean>;
  /** BOT_MODEL: what the code trades ('none' = idle). */
  botModel?: string;
  /** Each tier's strategy name when the model names its slots (e.g. the EMA 50 strategies). */
  slotLabels?: Partial<Record<Tier, string>>;
  /** LIVE_MODEL: what the code allows on the real account ('none' = nothing, locked). */
  liveModel?: string;
  /** The strategy the dashboard marks as preferred for live. */
  preferredLive?: Tier;
  /** Which of the live model's strategies the owner has switched on for live trading. */
  liveSlots?: Record<Tier, boolean>;
  /** Live drawdown breaker: settings, the account's peak, and when entries resume if tripped. */
  liveBreaker?: { drawdownPct: number; pauseDays: number; peak: number | null; until: number | null };
  /** Live leverage ceiling (LIVE_LEVERAGE) and margin mode; per coin, the size class decides below it. */
  liveLeverage?: { max: number; marginMode: string; byClass?: { large: number; mid: number; small: number }; largeCaps?: string[] };
  /** Live risk per trade, % of the account. */
  liveRiskPct?: number;
  /** Most live trades open at once. */
  liveMaxOpen?: number;
  /** The selection filter each pullback slot uses now. */
  selection?: Partial<Record<Tier, 'none' | 'range' | 'rrg' | 'heading' | 'fastslow' | 'btcregime'>>;
  /** RRG magnifying glass switches, as they stand now. */
  rrgInfluence?: { paper: boolean; live: boolean };
  /** The one-time 6-month check: locked (not run yet), or its result. */
  holdout?: { state: 'locked' | 'passed' | 'failed'; ranAt?: string };
  /** What order code would do right now: refuse, report only, or send. */
  writeMode: WriteMode;
  /** The linked Bitunix account; null when no API keys are set. */
  account: AccountSnapshot | null;
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
  /** Handles a kill-switch request (already authenticated). Throw ControlError for a bad request. */
  control?: (body: unknown, source: string) => Promise<{ message: string }>;
  /** For tests. */
  load?: (db: Db) => Promise<DashboardData>;
}

const MAX_BODY = 4096;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Too big: answer 400 and let the rest drain (dropping the socket would hide the answer).
      if (size > MAX_BODY) { reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * A control request must come from the dashboard page itself: JSON, a custom
 * header (which a cross-site form or image can't send without a CORS
 * preflight we never answer), and, when the browser sends one, an Origin
 * matching this host.
 */
export function sameSiteControl(req: IncomingMessage): boolean {
  if (req.headers['x-bot-control'] !== '1') return false;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (origin == null) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
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
    const isControl = path === '/api/control' && req.method === 'POST';
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isControl) return send(res, 405, 'text/plain', 'method not allowed', { Allow: 'GET, HEAD' });
    if (path === '/healthz') return send(res, 200, 'text/plain', 'ok');
    if (!authorized(req.headers.authorization, opts.password)) {
      return send(res, 401, 'text/plain', 'password required', { 'WWW-Authenticate': 'Basic realm="Bitunix bot", charset="UTF-8"' });
    }
    if (isControl) {
      const json = (status: number, body: unknown) => send(res, status, 'application/json', JSON.stringify(body));
      if (!opts.control) return json(404, { error: 'controls are not available' });
      if (!sameSiteControl(req)) return json(403, { error: 'refused: not sent from the dashboard page' });
      const source = `dashboard ${String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]!.trim()}`;
      readBody(req)
        .then((raw) => { let body: unknown; try { body = JSON.parse(raw); } catch { throw new ControlError('body is not JSON'); } return opts.control!(body, source); })
        .then((r) => json(200, r), (err: Error) => {
          if (err instanceof ControlError || err.message === 'body too large') return json(400, { error: err.message });
          opts.log.error('dashboard: control failed', { error: err.message });
          json(500, { error: `control failed: ${err.message}` });
        });
      return;
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
