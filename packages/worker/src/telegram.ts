// Live signal alerts to a Telegram group (owner 2026-10-05: "create a toggle under live trade for live signal").
// Each RSI model has its own switch on the dashboard, separate from live trading. A model switched on posts its signals
// (with the rule set and exit picked for it) as they happen: a new setup waiting for its trigger, an entry signal, the
// trade opening and the trade closing with its R. Messages only report; nothing here places, changes or closes orders.
// TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID come from the Railway variables, never the repository; without them the
// switches still save but nothing is sent. Only events at or after the moment a switch was turned on are sent (no flood
// of old signals), except setups still waiting for their trigger (sent when first seen), and each event once (remembered
// in the database).

import { FV_LIVE, RSI_MODELS, isSignalRow, type FvSignalRow, type RsiModelId, type RsiSignalRow } from '@bot/backtest';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';
import type { Logger } from './log';
import { liveRsiModels } from './rsiLive';
import type { FvSignalsSnapshot } from './fvSignals';
import type { RsiSignalsSnapshot } from './rsiSignals';
import { smcInfo } from './smcInfo';

export const RSI_ALERTS_KEY = 'rsi-signal-alerts';
export const ALERTS_SENT_KEY = 'rsi-signal-alerts-sent';
const KEEP_SENT = 3000;

export interface RsiAlert { on: boolean; since: number | null }
export type RsiAlertSettings = Record<RsiModelId, RsiAlert>;
export interface TelegramConfig { token: string; chatId: string; /** A forum topic to post in (default: General). */ threadId?: number }

export async function loadRsiAlerts(db: Db): Promise<RsiAlertSettings> {
  const s = (await loadSnapshot<Partial<Record<RsiModelId, Partial<RsiAlert>>>>(db, RSI_ALERTS_KEY)) ?? {};
  return Object.fromEntries((Object.keys(RSI_MODELS) as RsiModelId[]).map((m) => {
    const x = s[m] ?? {};
    const on = x.on === true && liveRsiModels().includes(m);
    return [m, { on, since: on && typeof x.since === 'number' ? x.since : null }];
  })) as RsiAlertSettings;
}

export async function setRsiAlert(db: Db, model: RsiModelId, on: boolean, now: number): Promise<RsiAlert> {
  const all = await loadRsiAlerts(db);
  const next: RsiAlert = { on, since: on ? (all[model].on ? all[model].since : now) : null };
  await saveSnapshot(db, RSI_ALERTS_KEY, { ...all, [model]: next });
  return next;
}

/** The event a row stands for right now, with when it happened. */
export function rowEvent(r: RsiSignalRow): { kind: RsiSignalRow['status']; at: number } {
  if (r.status === 'closed') return { kind: 'closed', at: r.closedAt ?? r.signalAt };
  if (r.status === 'open') return { kind: 'open', at: r.enteredAt ?? r.signalAt };
  return { kind: r.status, at: r.signalAt };
}
export const eventKey = (r: RsiSignalRow) => `${r.model}|${r.variant}|${r.symbol}|${r.signalAt}|${r.status}`;

const px = (x: number | null) => (x == null || !Number.isFinite(x) ? '-' : Number(x.toPrecision(5)).toString());
const utc = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The exit as signal readers see it (owner 2026-10-08: "for people that read the signal I'll not have 90 day expiry, keep
 * the 2R break even"): the time limit is left out; the target, trail and breakeven stay. "hold N days" (no target) reads
 * "no fixed target". The bot's own trades and the dashboard keep the time limit.
 */
export function signalExitText(name: string): string {
  return name
    .replace(/^hold \d+ days/, 'no fixed target')
    .replace(/, (\d+ days|no time stop)/g, '')
    .trim();
}

/**
 * The Telegram text for one row (HTML parse mode). `smc` = the SMC zone line (smcInfo.ts), shown under new setups,
 * entries and open trades as information only (owner 2026-10-09).
 */
export function alertText(r: RsiSignalRow, smc?: string | null): string {
  const side = r.side === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const head = `${side} <b>${esc(r.symbol)}</b> · ${esc(RSI_MODELS[r.model].label)}`;
  const levels = `Stop ${px(r.stop)}${r.stopPct != null ? ` (${r.stopPct.toFixed(1)}%)` : ''}${r.target != null ? ` · Target ${px(r.target)}` : ''}`;
  const zone = smc ? `\nSMC (info only, not used for entry): ${esc(smc)}` : '';
  const exit = `Exit: ${esc(signalExitText(r.exitName))}${r.support?.length ? `\nSupported with ${esc(r.support.join(' + '))}` : ''}${zone}`;
  if (r.status === 'waiting') return `⏳ ${head}\nSetup found, waiting for the entry trigger${r.until ? ` until ${utc(r.until)}` : ''}.\nLast price ${px(r.lastPrice)}${zone}`;
  if (r.status === 'enter') return `📣 ${head}\nEntry signal: enter at the next open (about ${px(r.entry)}).\n${levels}\n${exit}`;
  if (r.status === 'open') return `✅ ${head}\nIn trade from ${px(r.entry)} (${utc(r.enteredAt ?? r.signalAt)}).\n${levels}\n${exit}`;
  const why = r.exit === 'target' ? '🎯 target' : r.exit === 'stop' ? '❌ stop' : r.exit === 'time' ? '⌛ time exit' : '↩️ exit signal';
  return `🏁 ${head}\nClosed (${why}) at ${px(r.lastPrice)}: ${r.r != null ? `${r.r >= 0 ? '+' : ''}${r.r.toFixed(2)}R` : '-'}`;
}

/** Nothing older than this is ever sent (owner 2026-10-07: "Don't send anything to telegram more than 2 weeks old"). */
export const MAX_ALERT_AGE_MS = 14 * 86_400_000;

/**
 * Rows that should be sent now: the model's switch on, its one exit (isSignalRow), new since the switch (or a setup
 * still waiting), at most MAX_ALERT_AGE_MS old at `now`, not sent yet. An event sent under the model's other exit
 * number (picked on the dashboard before 2026-10-09) counts as sent.
 */
export function dueAlerts(rows: ReadonlyArray<RsiSignalRow>, alerts: RsiAlertSettings, sent: ReadonlySet<string>, now: number): RsiSignalRow[] {
  const sentBefore = (r: RsiSignalRow) => sent.has(eventKey(r)) || sent.has(eventKey({ ...r, variant: r.variant === 0 ? 1 : 0 }));
  return rows.filter((r) => {
    const a = alerts[r.model];
    if (!a?.on || a.since == null || !isSignalRow(r)) return false;
    // A setup still waiting for its trigger is posted the first time it is seen, however old (owner 2026-10-07: setups
    // found on coins just added to the list were dated before the switch and never posted).
    const at = rowEvent(r).at;
    if (now - at > MAX_ALERT_AGE_MS) return false;
    if (r.status === 'closed' && r.exit === 'time') return false; // readers have no time limit (owner 2026-10-08)
    return (r.status === 'waiting' || at >= a.since) && !sentBefore(r);
  }).sort((a, b) => rowEvent(a).at - rowEvent(b).at);
}

export async function sendTelegram(cfg: TelegramConfig, text: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, ...(cfg.threadId ? { message_thread_id: cfg.threadId } : {}), text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

/** One wake-up: send what is due; an event is remembered only once it was sent. */
export async function rsiAlertStep(
  deps: { db: Db; log: Logger; telegram: TelegramConfig | null; fetchFn?: typeof fetch; now?: () => number; smc?: (r: RsiSignalRow, now: number) => string | null },
  snapshot: RsiSignalsSnapshot | null,
): Promise<number> {
  if (!snapshot || !deps.telegram) return 0;
  const alerts = await loadRsiAlerts(deps.db);
  if (!Object.values(alerts).some((a) => a.on)) return 0;
  const sentList = (await loadSnapshot<string[]>(deps.db, ALERTS_SENT_KEY)) ?? [];
  const sent = new Set(sentList);
  const now = (deps.now ?? Date.now)();
  const due = dueAlerts(snapshot.rows, alerts, sent, now);
  const zoneLine = (r: RsiSignalRow) => {
    try { return (deps.smc ?? smcInfo)(r, now); } catch (err) { deps.log.warn('telegram: smc line failed', { symbol: r.symbol, error: (err as Error).message }); return null; }
  };
  let n = 0;
  for (const r of due) {
    try {
      await sendTelegram(deps.telegram, alertText(r, zoneLine(r)), deps.fetchFn);
      sentList.push(eventKey(r));
      n++;
    } catch (err) {
      deps.log.error('telegram: send failed', { error: (err as Error).message.replace(deps.telegram.token, '***') });
      break; // try the rest next wake-up
    }
  }
  if (n) await saveSnapshot(deps.db, ALERTS_SENT_KEY, sentList.slice(-KEEP_SENT));
  return n;
}

// ---- The 4H funding squeeze (fvSignals.ts; display only, never traded) ------------------------------------------------
// Its own switch and sent list. Posted (owner 2026-10-10: "signals for the 4hr signal and 1hr entry"): the 4H signal
// (a squeeze candle, waiting for the 1H entry), the 1H entry, the trade opening only if its entry was not posted (the
// worker was down then), and the close of a trade whose entry or opening was posted. Same limits as the RSI models: only
// events at or after the switch was turned on, nothing older than MAX_ALERT_AGE_MS, each once.

export const FV_ALERT_KEY = 'fv-signal-alert';
export const FV_SENT_KEY = 'fv-signal-alerts-sent';

export async function loadFvAlert(db: Db): Promise<RsiAlert> {
  const x = (await loadSnapshot<Partial<RsiAlert>>(db, FV_ALERT_KEY)) ?? {};
  const on = x.on === true;
  return { on, since: on && typeof x.since === 'number' ? x.since : null };
}

export async function setFvAlert(db: Db, on: boolean, now: number): Promise<RsiAlert> {
  const was = await loadFvAlert(db);
  const next: RsiAlert = { on, since: on ? (was.on ? was.since : now) : null };
  await saveSnapshot(db, FV_ALERT_KEY, next);
  return next;
}

export const fvEventKey = (r: Pick<FvSignalRow, 'symbol' | 'signalAt'>, status: FvSignalRow['status']) => `${r.symbol}|${r.signalAt}|${status}`;
/** When the event a row stands for happened. */
export function fvEventAt(r: FvSignalRow): number {
  if (r.status === 'closed') return r.closedAt ?? r.signalAt;
  if (r.status === 'open') return r.enteredAt ?? r.signalAt;
  if (r.status === 'enter') return r.confirmedAt ?? r.signalAt;
  return r.signalAt;
}

const pct = (x: number, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(100 * x).toFixed(d)}%`;

/** The Telegram text for one row (HTML parse mode); the layout of the 2026-10-10 mockup. */
export function fvAlertText(r: FvSignalRow): string {
  const side = r.side === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const head = `${side} <b>${esc(r.symbol)}</b> · ${esc(FV_LIVE.label)}`;
  const crowd = r.crowd === 'long' ? 'Longs' : 'Shorts';
  const why = `Why: ${crowd} crowded (funding ${pct(r.rate8, 3)} per 8h over the last 24h); the 4H candle moved ${pct(r.move)} on ${r.rvol.toFixed(1)}× normal volume against them.`;
  const levels = `Stop ${px(r.stop)}${r.stopPct != null ? ` (${r.stopPct.toFixed(1)}%)` : ''} · Target ${px(r.target)}`;
  const tail = `Exit: ${esc(FV_LIVE.exit.name)}, no time limit\n${why}\nFunding: ${crowd.toLowerCase()} pay about ${Math.abs(100 * r.rate8).toFixed(3)}% per 8h, so this trade pays it while open.\nSignal only: the bot does not trade this model.`;
  const way = r.side === 'long' ? 'up' : 'down';
  if (r.status === 'enter') return `📣 ${head}\n1H entry: a 1H candle closed ${way} after the 4H signal; enter at the next 1H open (about ${px(r.entry)}).\n${levels}\n${tail}`;
  if (r.status === 'open') return `✅ ${head}\nIn trade from ${px(r.entry)} (${utc(r.enteredAt ?? r.signalAt)}).\n${levels}\n${tail}`;
  if (r.status === 'closed') {
    const at = r.exit === 'target' ? `🎯 target ${px(r.target)}` : `❌ stop ${px(r.stop)}`;
    const fund = r.fundingR ? ` (funding ${r.fundingR > 0 ? 'received +' : 'paid '}${r.fundingR.toFixed(2)}R)` : '';
    return `🏁 ${head}\nClosed (${at}): ${r.r != null ? `${r.r >= 0 ? '+' : ''}${r.r.toFixed(2)}R` : '-'}${fund}`;
  }
  return `🔔 ${head}\n4H signal: squeeze candle closed ${utc(r.signalAt)}. Waiting for the 1H entry: a 1H candle closing ${way} by ${r.until ? utc(r.until) : '-'}. If none does, there is no trade.\n${why}\nSignal only: the bot does not trade this model.`;
}

/** Rows to send now (see above), oldest first. */
export function dueFvAlerts(rows: ReadonlyArray<FvSignalRow>, alert: RsiAlert, sent: ReadonlySet<string>, now: number): FvSignalRow[] {
  if (!alert.on || alert.since == null) return [];
  const told = (r: FvSignalRow) => sent.has(fvEventKey(r, 'enter')) || sent.has(fvEventKey(r, 'open'));
  return rows.filter((r) => {
    const at = fvEventAt(r);
    if (at < alert.since! || now - at > MAX_ALERT_AGE_MS || sent.has(fvEventKey(r, r.status))) return false;
    if (r.status === 'open') return !sent.has(fvEventKey(r, 'enter'));
    if (r.status === 'closed') return told(r);
    return true;
  }).sort((a, b) => fvEventAt(a) - fvEventAt(b));
}

/** One wake-up: send what is due; an event is remembered only once it was sent. */
export async function fvAlertStep(
  deps: { db: Db; log: Logger; telegram: TelegramConfig | null; fetchFn?: typeof fetch; now?: () => number },
  snapshot: FvSignalsSnapshot | null,
): Promise<number> {
  if (!snapshot || !deps.telegram) return 0;
  const alert = await loadFvAlert(deps.db);
  if (!alert.on) return 0;
  const sentList = (await loadSnapshot<string[]>(deps.db, FV_SENT_KEY)) ?? [];
  const due = dueFvAlerts(snapshot.rows, alert, new Set(sentList), (deps.now ?? Date.now)());
  let n = 0;
  for (const r of due) {
    try {
      await sendTelegram(deps.telegram, fvAlertText(r), deps.fetchFn);
      sentList.push(fvEventKey(r, r.status));
      n++;
    } catch (err) {
      deps.log.error('telegram: fv send failed', { error: (err as Error).message.replace(deps.telegram.token, '***') });
      break; // try the rest next wake-up
    }
  }
  if (n) await saveSnapshot(deps.db, FV_SENT_KEY, sentList.slice(-KEEP_SENT));
  return n;
}
