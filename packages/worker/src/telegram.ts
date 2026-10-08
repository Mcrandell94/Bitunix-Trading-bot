// Live signal alerts to a Telegram group (owner 2026-10-05: "create a toggle under live trade for live signal").
// Each RSI model has its own switch on the dashboard, separate from live trading. A model switched on posts its signals
// (with the rule set and exit picked for it) as they happen: a new setup waiting for its trigger, an entry signal, the
// trade opening and the trade closing with its R. Messages only report; nothing here places, changes or closes orders.
// TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID come from the Railway variables, never the repository; without them the
// switches still save but nothing is sent. Only events at or after the moment a switch was turned on are sent (no flood
// of old signals), except setups still waiting for their trigger (sent when first seen), and each event once (remembered
// in the database).

import { RSI_MODELS, type RsiModelId, type RsiSignalRow } from '@bot/backtest';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';
import type { Logger } from './log';
import { liveRsiModels, loadRsiLive, type RsiLiveSettings } from './rsiLive';
import type { RsiSignalsSnapshot } from './rsiSignals';

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

/** The Telegram text for one row (HTML parse mode). */
export function alertText(r: RsiSignalRow): string {
  const side = r.side === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const head = `${side} <b>${esc(r.symbol)}</b> · ${esc(RSI_MODELS[r.model].label)}`;
  const levels = `Stop ${px(r.stop)}${r.stopPct != null ? ` (${r.stopPct.toFixed(1)}%)` : ''}${r.target != null ? ` · Target ${px(r.target)}` : ''}`;
  const exit = `Exit: ${esc(signalExitText(r.exitName))}${r.support?.length ? `\nSupported with ${esc(r.support.join(' + '))}` : ''}`;
  if (r.status === 'waiting') return `⏳ ${head}\nSetup found, waiting for the entry trigger${r.until ? ` until ${utc(r.until)}` : ''}.\nLast price ${px(r.lastPrice)}`;
  if (r.status === 'enter') return `📣 ${head}\nEntry signal: enter at the next open (about ${px(r.entry)}).\n${levels}\n${exit}`;
  if (r.status === 'open') return `✅ ${head}\nIn trade from ${px(r.entry)} (${utc(r.enteredAt ?? r.signalAt)}).\n${levels}\n${exit}`;
  const why = r.exit === 'target' ? '🎯 target' : r.exit === 'stop' ? '❌ stop' : r.exit === 'time' ? '⌛ time exit' : '↩️ exit signal';
  return `🏁 ${head}\nClosed (${why}) at ${px(r.lastPrice)}: ${r.r != null ? `${r.r >= 0 ? '+' : ''}${r.r.toFixed(2)}R` : '-'}`;
}

/** Nothing older than this is ever sent (owner 2026-10-07: "Don't send anything to telegram more than 2 weeks old"). */
export const MAX_ALERT_AGE_MS = 14 * 86_400_000;

/**
 * Rows that should be sent now: the model's switch on, its picked rule set and exit, new since the switch (or a setup
 * still waiting), at most MAX_ALERT_AGE_MS old at `now`, not sent yet.
 */
export function dueAlerts(rows: ReadonlyArray<RsiSignalRow>, alerts: RsiAlertSettings, live: RsiLiveSettings, sent: ReadonlySet<string>, now: number): RsiSignalRow[] {
  return rows.filter((r) => {
    const a = alerts[r.model], s = live[r.model];
    if (!a?.on || a.since == null || !s || s.variant !== r.variant || !r.plans.includes(s.plan)) return false;
    // A setup still waiting for its trigger is posted the first time it is seen, however old (owner 2026-10-07: setups
    // found on coins just added to the list were dated before the switch and never posted).
    const at = rowEvent(r).at;
    if (now - at > MAX_ALERT_AGE_MS) return false;
    if (r.status === 'closed' && r.exit === 'time') return false; // readers have no time limit (owner 2026-10-08)
    return (r.status === 'waiting' || at >= a.since) && !sent.has(eventKey(r));
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
export async function rsiAlertStep(deps: { db: Db; log: Logger; telegram: TelegramConfig | null; fetchFn?: typeof fetch; now?: () => number }, snapshot: RsiSignalsSnapshot | null): Promise<number> {
  if (!snapshot || !deps.telegram) return 0;
  const alerts = await loadRsiAlerts(deps.db);
  if (!Object.values(alerts).some((a) => a.on)) return 0;
  const sentList = (await loadSnapshot<string[]>(deps.db, ALERTS_SENT_KEY)) ?? [];
  const sent = new Set(sentList);
  const due = dueAlerts(snapshot.rows, alerts, await loadRsiLive(deps.db), sent, (deps.now ?? Date.now)());
  let n = 0;
  for (const r of due) {
    try {
      await sendTelegram(deps.telegram, alertText(r), deps.fetchFn);
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
