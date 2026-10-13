// The ETH and BTC cards to Telegram (owner 2026-10-11: "Looks good activate it to the dashboard and just put the on off
// toggles in the dashboard"; cards v2 2026-10-13: one card with weekly, daily and 4H reads and an AI read). Each coin
// has its own switch, off until turned on. With a coin's switch on, this posts to the same Telegram group as the signals:
// - the card at each 4H close (@bot/backtest coincard.ts: W / D / 4H reads from the owner's scripts), with the AI read
//   (aiRead.ts, Claude Haiku 5.5) on top when ANTHROPIC_API_KEY is set;
// - the change alerts of the weekly, daily and 4H bars that closed since the last 4H close.
// DISPLAY ONLY: nothing here reads or touches orders, positions or the live models, and the AI read sees only the card.
// Candles come from the worker's memory (candleMemory.ts; BTC and ETH are core coins, always kept); funding from
// Bitunix. Only closes at or after the moment a switch was turned on are sent, nothing older than MAX_ALERT_AGE_MS, each
// message once (remembered in the database only after it was sent, so a failed send is retried at the next wake-up).

import { aiInput, coinCard, coinCardText, coinEvents, type CoinEvent } from '@bot/backtest';
import { fetchFunding, type BitunixClient } from '@bot/bitunix';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';
import type { AiReader } from './aiRead';
import { candles, isReady, update } from './candleMemory';
import type { Logger } from './log';
import { MAX_ALERT_AGE_MS, sendTelegram, type TelegramConfig } from './telegram';

export const CARD_COINS = ['ETHUSDT', 'BTCUSDT'] as const;
export type CardCoin = (typeof CARD_COINS)[number];
export const CARD_SWITCH_KEY = 'eth-report-alert';
export const CARD_SENT_KEY = 'eth-report-sent';
const KEEP_SENT = 3000;
const H = 3_600_000, H4 = 4 * H, DAY = 24 * H;

export interface CardSwitch { on: boolean; since: number | null }
export type CardSwitches = Record<CardCoin, CardSwitch>;

export async function loadCardSwitches(db: Db): Promise<CardSwitches> {
  const s = (await loadSnapshot<Partial<Record<CardCoin, Partial<CardSwitch>>>>(db, CARD_SWITCH_KEY)) ?? {};
  return Object.fromEntries(CARD_COINS.map((c) => {
    const x = s[c] ?? {}, on = x.on === true;
    return [c, { on, since: on && typeof x.since === 'number' ? x.since : null }];
  })) as CardSwitches;
}

export async function setCardSwitch(db: Db, coin: CardCoin, on: boolean, now: number): Promise<CardSwitch> {
  const all = await loadCardSwitches(db);
  const next: CardSwitch = { on, since: on ? (all[coin].on ? all[coin].since : now) : null };
  await saveSnapshot(db, CARD_SWITCH_KEY, { ...all, [coin]: next });
  return next;
}

/** Telegram HTML: alert texts carry no tags, so their text is escaped; the cards are HTML already. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const cardKey = (coin: CardCoin, t: number, k: number) => `${coin}|card2|${t}|${k}`;

/**
 * The messages of one coin at the 4H close `t`, in sending order: the card, then the alerts oldest first. Only with the
 * switch on, a card for a close at or after it was turned on, alerts at or after it and at most MAX_ALERT_AGE_MS old at
 * `now`, and nothing already sent. Pure.
 */
export function dueCardMessages(coin: CardCoin, t: number, sw: CardSwitch, card: string[], events: ReadonlyArray<CoinEvent>, sent: ReadonlySet<string>, now: number): { key: string; text: string }[] {
  if (!sw.on || sw.since == null) return [];
  const out: { key: string; text: string }[] = [];
  if (t >= sw.since) card.forEach((text, k) => out.push({ key: cardKey(coin, t, k), text }));
  for (const e of [...events].sort((a, b) => a.t - b.t)) if (e.t >= sw.since && now - e.t <= MAX_ALERT_AGE_MS) out.push({ key: `${coin}|${e.key}`, text: esc(e.text) });
  return out.filter((m) => !sent.has(m.key));
}

const doneClose = new Map<string, number>();
/** The AI read of each coin's latest card, so a retried send repeats the same card (and the read is paid for once). */
const readMemo = new Map<string, { t: number; read: string | null }>();
export const resetCardMemory = () => { doneClose.clear(); readMemo.clear(); };

/** Builds what one coin has to say at the 4H close `t`: the card (with the AI read if it is still to be sent), the alerts. */
async function coinMessages(deps: { client: BitunixClient; ai?: AiReader | null }, coin: CardCoin, t: number, cardDue: boolean): Promise<{ card: string[]; events: CoinEvent[] }> {
  const { client } = deps;
  await update(client, coin, ['15m', '1h', '4h', '1d'], t);
  // Funding is context only: a failed read leaves the funding line empty.
  const rate = await fetchFunding(client, [coin]).then((r) => r.items.find((f) => f.symbol === coin), () => undefined);
  const built = coinCard({
    symbol: coin, m15: candles(coin, '15m', t - 2 * DAY, t), h1: candles(coin, '1h', 0, t), h4: candles(coin, '4h', 0, t), d1: candles(coin, '1d', 0, t),
    funding: rate ? { rate: rate.rate, intervalHours: rate.intervalHours } : null, now: t,
  });
  const events = coinEvents(built, t - H4);
  if (!cardDue) return { card: [], events };
  let memo = readMemo.get(coin);
  if (memo?.t !== t) {
    memo = { t, read: deps.ai ? await deps.ai(aiInput(built.card)) : null };
    readMemo.set(coin, memo);
  }
  return { card: coinCardText(built.card, memo.read), events };
}

/**
 * One wake-up (every 15 minutes): once per new 4H close, for each coin switched on, build and send what is due. A
 * coin whose candles are still downloading after a restart waits; an error is logged and that close retried.
 */
export async function cardStep(
  deps: { client: BitunixClient; db: Db; log: Logger; telegram: TelegramConfig | null; ai?: AiReader | null; fetchFn?: typeof fetch },
  now: number,
): Promise<number> {
  if (!deps.telegram) return 0;
  const sw = await loadCardSwitches(deps.db), on = CARD_COINS.filter((c) => sw[c].on);
  if (!on.length) return 0;
  const t = Math.floor(now / H4) * H4;
  const sentList = (await loadSnapshot<string[]>(deps.db, CARD_SENT_KEY)) ?? [], sent = new Set(sentList);
  let n = 0;
  for (const coin of on) {
    if (doneClose.get(coin) === t) continue;
    if (!isReady(coin)) { deps.log.info('cards: candles still downloading', { coin }); continue; }
    try {
      const { card, events } = await coinMessages(deps, coin, t, t >= (sw[coin].since ?? Infinity) && !sent.has(cardKey(coin, t, 0)));
      for (const m of dueCardMessages(coin, t, sw[coin], card, events, sent, now)) {
        await sendTelegram(deps.telegram, m.text, deps.fetchFn);
        sentList.push(m.key); sent.add(m.key); n++;
      }
      doneClose.set(coin, t);
    } catch (err) {
      deps.log.error('cards: step failed (retried next wake-up)', { coin, error: (err as Error).message.replace(deps.telegram.token, '***') });
    }
  }
  if (n) await saveSnapshot(deps.db, CARD_SENT_KEY, sentList.slice(-KEEP_SENT));
  return n;
}
