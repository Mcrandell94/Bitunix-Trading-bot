// The ETH and BTC cards to Telegram (owner 2026-10-11: "Looks good activate it to the dashboard and just put the on off
// toggles in the dashboard"). Each coin has its own switch, off until turned on. With a coin's switch on, this posts to
// the same Telegram group as the signals:
// - the 4H card at each 4H close and the 1D card at the daily close (@bot/backtest ethreport.ts, one card per timeframe);
// - the change alerts of those closes (KAMA, levels, zones, ribbon, EMA stack, DiNapoli, ...);
// - the 1H DiNapoli alerts, new setups only, at each 1H close (owner: "only send the 1 hr out on freshly presented setups").
// DISPLAY ONLY: nothing here reads or touches orders, positions or the live models. Candles come from the worker's
// memory (candleMemory.ts; BTC and ETH are core coins, always kept); funding from Bitunix. Only closes at or after the
// moment a switch was turned on are sent, nothing older than MAX_ALERT_AGE_MS, each message once (remembered in the
// database only after it was sent, so a failed send is retried at the next wake-up).

import { dnH1Events, ethCard, ethCardText, ethEvents, type EthEvent } from '@bot/backtest';
import { fetchFunding, fetchFundingHistory, type BitunixClient, type FundingPoint } from '@bot/bitunix';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';
import { candles, isReady, update } from './candleMemory';
import type { Logger } from './log';
import { MAX_ALERT_AGE_MS, sendTelegram, type TelegramConfig } from './telegram';

export const CARD_COINS = ['ETHUSDT', 'BTCUSDT'] as const;
export type CardCoin = (typeof CARD_COINS)[number];
export const CARD_SWITCH_KEY = 'eth-report-alert';
export const CARD_SENT_KEY = 'eth-report-sent';
const KEEP_SENT = 3000;
const H = 3_600_000, H4 = 4 * H, DAY = 24 * H;
/** Funding settlements kept per coin (the Outlook line uses a 90-day median). */
const FUNDING_DAYS = 100;

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

/**
 * The messages of one coin at the 1H close `t`, in sending order: the 1D card (at the daily close), the 4H card (at a
 * 4H close), then the alerts oldest first. Only with the switch on, closes at or after it was turned on, alerts at most
 * MAX_ALERT_AGE_MS old at `now`, and nothing already sent. Pure.
 */
export function dueCardMessages(coin: CardCoin, t: number, sw: CardSwitch, cards: { '4H'?: string[]; '1D'?: string[] }, events: ReadonlyArray<EthEvent>, sent: ReadonlySet<string>, now: number): { key: string; text: string }[] {
  if (!sw.on || sw.since == null) return [];
  const out: { key: string; text: string }[] = [];
  for (const tf of ['1D', '4H'] as const) {
    const msgs = cards[tf];
    if (!msgs || t < sw.since) continue;
    msgs.forEach((text, k) => out.push({ key: `${coin}|card|${tf}|${t}|${k}`, text }));
  }
  for (const e of [...events].sort((a, b) => a.t - b.t)) if (e.t >= sw.since && now - e.t <= MAX_ALERT_AGE_MS) out.push({ key: `${coin}|${e.key}`, text: esc(e.text) });
  return out.filter((m) => !sent.has(m.key));
}

const funding = new Map<string, FundingPoint[]>();
const doneHour = new Map<string, number>();
export const resetCardMemory = () => { funding.clear(); doneHour.clear(); };

/** The coin's settled funding of the last FUNDING_DAYS (read once, then only the settlements since). */
async function fundingHistory(client: BitunixClient, coin: string, t: number): Promise<FundingPoint[]> {
  const had = funding.get(coin) ?? [], keepFrom = t - FUNDING_DAYS * DAY;
  const add = await fetchFundingHistory(client, coin, had.length ? had[had.length - 1]!.time + 1 : keepFrom, t + 1);
  const all = [...new Map([...had, ...add].filter((f) => f.time >= keepFrom).map((f) => [f.time, f])).values()].sort((a, b) => a.time - b.time);
  funding.set(coin, all);
  return all;
}

/** Builds what one coin has to say at the 1H close `t`: the cards at 4H / daily closes, and the alerts. */
async function coinMessages(client: BitunixClient, coin: CardCoin, t: number): Promise<{ cards: { '4H'?: string[]; '1D'?: string[] }; events: EthEvent[] }> {
  if (t % H4 !== 0) {
    // Between 4H closes only the 1H DiNapoli new setups.
    await update(client, coin, ['1h'], t);
    return { cards: {}, events: dnH1Events(coin, candles(coin, '1h', 0, t), t - H) };
  }
  const other: CardCoin = coin === 'ETHUSDT' ? 'BTCUSDT' : 'ETHUSDT';
  await update(client, coin, ['15m', '1h', '4h', '1d'], t);
  if (isReady(other)) await update(client, other, ['1d'], t);
  // Funding is context only: a failed read leaves the funding line empty (or uses the settlements read before).
  const rate = await fetchFunding(client, [coin]).then((r) => r.items.find((f) => f.symbol === coin), () => undefined);
  const fh = await fundingHistory(client, coin, t).catch(() => funding.get(coin) ?? []);
  const built = ethCard({
    symbol: coin, m15: candles(coin, '15m', t - 2 * DAY, t), h1: candles(coin, '1h', 0, t), h4: candles(coin, '4h', 0, t), d1: candles(coin, '1d', 0, t),
    funding: rate ? { rate: rate.rate, intervalHours: rate.intervalHours } : null, now: t,
    otherD1: isReady(other) ? candles(other, '1d', 0, t) : [], fundingHistory: fh,
  });
  return {
    cards: { '4H': ethCardText(built.card, '4H'), ...(t % DAY === 0 ? { '1D': ethCardText(built.card, '1D') } : {}) },
    events: ethEvents(built, t - H4),
  };
}

/**
 * One wake-up (every 15 minutes): once per new 1H close, for each coin switched on, build and send what is due. A
 * coin whose candles are still downloading after a restart waits; an error is logged and that close retried.
 */
export async function cardStep(
  deps: { client: BitunixClient; db: Db; log: Logger; telegram: TelegramConfig | null; fetchFn?: typeof fetch },
  now: number,
): Promise<number> {
  if (!deps.telegram) return 0;
  const sw = await loadCardSwitches(deps.db), on = CARD_COINS.filter((c) => sw[c].on);
  if (!on.length) return 0;
  const t = Math.floor(now / H) * H;
  const sentList = (await loadSnapshot<string[]>(deps.db, CARD_SENT_KEY)) ?? [], sent = new Set(sentList);
  let n = 0;
  for (const coin of on) {
    if (doneHour.get(coin) === t) continue;
    if (!isReady(coin)) { deps.log.info('cards: candles still downloading', { coin }); continue; }
    try {
      const { cards, events } = await coinMessages(deps.client, coin, t);
      for (const m of dueCardMessages(coin, t, sw[coin], cards, events, sent, now)) {
        await sendTelegram(deps.telegram, m.text, deps.fetchFn);
        sentList.push(m.key); sent.add(m.key); n++;
      }
      doneHour.set(coin, t);
    } catch (err) {
      deps.log.error('cards: step failed (retried next wake-up)', { coin, error: (err as Error).message.replace(deps.telegram.token, '***') });
    }
  }
  if (n) await saveSnapshot(deps.db, CARD_SENT_KEY, sentList.slice(-KEEP_SENT));
  return n;
}
