// The ETH and BTC cards to Telegram (owner 2026-10-11: "Looks good activate it to the dashboard and just put the on off
// toggles in the dashboard"; cards v2 2026-10-13: one card with weekly, daily and 4H reads and an AI read; cards v3
// 2026-10-16: the POIs only, and no change alerts; 2026-10-17: no AI read). Each coin has its own switch, off until turned
// on. With a coin's switch on, this posts to the same Telegram group as the signals, at each 4H close, one card
// (@bot/backtest coincard.ts: the POI ladder from the owner's scripts on W / D / 4H):
// - with XAI_API_KEY set (grok.ts, owner 2026-10-13), the levels the followed X traders posted (grok.ts
//   COMMUNITY_TRADERS), shown only as "Community trader #n", with the POIs they line up with tagged. Grok does nothing
//   else.
// - with CRYPTODATAAPI_API_KEY set (cdacard.ts, owner 2026-10-17, Pro plan), its live positioning: the Hyperliquid market
//   makers' liquidation levels and BTC max pain join the POIs, and a positioning block shows the 24h liquidations,
//   Binance long / short and the regime model;
// - with COINLOBSTER_API_KEY set (clcard.ts, owner 2026-10-17, Pro plan), a whale line in that block: the coin's 24h whale
//   flow against its own history and the net of the 4H bar just closed.
// Each live source is fetched once per coin per close; a failed call leaves its part out.
// DISPLAY ONLY: nothing here reads or touches orders, positions or the live models.
// Candles come from the worker's memory (candleMemory.ts; BTC and ETH are core coins, always kept). Only closes at or
// after the moment a switch was turned on are sent, each message once (remembered in the database only after it was sent, so a failed send is retried at the next wake-up).

import { cdaCoin, clCoin, coinCard, coinCardText, type CdaCoin, type ClCoin } from '@bot/backtest';
import type { BitunixClient } from '@bot/bitunix';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';
import { COMMUNITY_TRADERS, traderLabel, traderLine, type Grok, type TraderLevels } from './grok';
import { candles, isReady, update } from './candleMemory';
import type { Logger } from './log';
import { sendTelegram, type TelegramConfig } from './telegram';

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

export const cardKey = (coin: CardCoin, t: number, k: number) => `${coin}|card2|${t}|${k}`;

/**
 * A one-off repost (owner 2026-10-17: "after merging push new cards to telegram as UPDATED"): after a deploy, each coin
 * switched on gets the card of the latest 4H close once more, headed UPDATED, unless that close's card is going out
 * anyway. Once per coin per tag (in the CARD_UPDATE.key snapshot, saved after the send); a new tag posts them again.
 * It waits until CryptoDataAPI and CoinLobster both answer (owner: "push new cards when everything is fixed"), checked
 * again at each wake-up with fresh calls; the next close's regular card goes out regardless.
 */
export const CARD_UPDATE = { tag: '2026-10-17 cards v3: one line a POI', key: 'eth-report-update', label: 'UPDATED' } as const;
type Live = { t: number; cda: CdaCoin | null; cl: ClCoin | null };
/** What the repost still waits for: '' when both live sources answered, else e.g. "CryptoDataAPI: no key". */
export function liveMissing(l: Live): string {
  const cda = l.cda == null ? 'no key' : l.cda.errors.length ? `failed (${l.cda.errors.join(', ')})` : '';
  const cl = l.cl == null ? 'no key' : l.cl.errors.length ? `failed (${l.cl.errors.join(', ')})` : !l.cl.whales ? 'no whale data' : '';
  return [cda && `CryptoDataAPI: ${cda}`, cl && `CoinLobster: ${cl}`].filter(Boolean).join(' · ');
}
const updateKey = (coin: CardCoin, t: number, k: number) => `${coin}|update|${t}|${k}`;

/**
 * The messages of one coin at the 4H close `t`: the card's messages, only with the switch on, for a close at or after it
 * was turned on, and nothing already sent. Pure.
 */
export function dueCardMessages(coin: CardCoin, t: number, sw: CardSwitch, card: string[], sent: ReadonlySet<string>): { key: string; text: string }[] {
  if (!sw.on || sw.since == null || t < sw.since) return [];
  return card.map((text, k) => ({ key: cardKey(coin, t, k), text })).filter((m) => !sent.has(m.key));
}

const doneClose = new Map<string, number>();
/** The traders' levels of each coin's latest card, so a retried send repeats the same card (Grok paid for once). */
const readMemo = new Map<string, { t: number; note: { title: string; lines: string[] } | null; marks: { tag: string; levels: number[] }[] }>();
/** The followed traders' levels at the 4H close `t`: one Grok call a trader (side by side) for all card coins, shared by the cards. */
let community: { t: number; byTrader: (TraderLevels[] | null)[] } | null = null;
/** Each coin's live data (CryptoDataAPI, CoinLobster) for its latest close, so a retried send builds the same card (each paid for once). */
const liveMemo = new Map<string, Live>();
export const resetCardMemory = () => { doneClose.clear(); readMemo.clear(); liveMemo.clear(); community = null; };

type CardDeps = { client: BitunixClient; grok?: Grok | null; traders?: string[] | null; log?: Logger; cdaKey?: string | null; cdaFetch?: typeof fetch; clKey?: string | null; clFetch?: typeof fetch };

/** Each followed trader's latest levels for `coin` (label #1, #2, ... in list order); [] without Grok or traders. */
async function traderLevels(deps: CardDeps, coin: CardCoin, t: number, now: number): Promise<{ label: string; tag: string; levels: TraderLevels }[]> {
  const handles = deps.traders ?? COMMUNITY_TRADERS;
  if (!deps.grok || !handles.length) return [];
  if (community?.t !== t) {
    const coins = CARD_COINS.filter((c) => isReady(c)).map((c) => ({ coin: c as string, price: candles(c, '4h', 0, t).at(-1)?.close ?? NaN })).filter((c) => Number.isFinite(c.price));
    const grok = deps.grok;
    community = { t, byTrader: await Promise.all(handles.map((h) => grok.trader(h, coins, now))) };
  }
  return community.byTrader.flatMap((list, k) => (list ?? []).filter((x) => x.coin === coin).map((levels) => ({ label: traderLabel(k), tag: `CT#${k + 1}`, levels })));
}

/** The live sources of one coin for the close `t` (CRYPTODATAAPI_API_KEY / COINLOBSTER_API_KEY set in Railway): fetched once per close. */
async function liveData(deps: CardDeps, coin: CardCoin, t: number, now: number): Promise<Live> {
  let live = liveMemo.get(coin);
  if (live?.t !== t) {
    const [cda, cl] = await Promise.all([
      cdaCoin(coin, deps.cdaKey, deps.cdaFetch as Parameters<typeof cdaCoin>[2] | undefined, now).catch(() => null),
      clCoin(coin, deps.clKey, t, deps.clFetch as Parameters<typeof clCoin>[3] | undefined, now).catch(() => null),
    ]);
    if (cda?.errors.length) deps.log?.warn('cards: CryptoDataAPI calls failed (card built without them)', { coin, failed: cda.errors });
    if (cl?.errors.length) deps.log?.warn('cards: CoinLobster calls failed (card built without them)', { coin, failed: cl.errors });
    else if (cl && !cl.whales && cl.net4h == null) deps.log?.warn('cards: CoinLobster answered without whale data (no line)', { coin });
    live = { t, cda, cl };
    liveMemo.set(coin, live);
  }
  return live;
}

/** One coin's card at the 4H close `t` (at wall time `now`), with the live sources and the community traders' levels. */
async function coinMessages(deps: CardDeps, coin: CardCoin, t: number, now: number, label: string | null = null): Promise<string[]> {
  await update(deps.client, coin, ['15m', '1h', '4h', '1d'], t);
  const live = await liveData(deps, coin, t, now);
  const built = coinCard({
    symbol: coin, m15: candles(coin, '15m', t - 2 * DAY, t), h1: candles(coin, '1h', 0, t), h4: candles(coin, '4h', 0, t), d1: candles(coin, '1d', 0, t),
    funding: null, now: t, cda: live.cda, cl: live.cl,
  });
  let memo = readMemo.get(coin);
  if (memo?.t !== t) {
    // Grok searches as of now (the card may be late after a restart).
    const traders = await traderLevels(deps, coin, t, now);
    const note = traders.length ? { title: 'Community traders (Grok · unverified · not advice)', lines: traders.map((x) => traderLine(x.label, x.levels)) } : null;
    const marks = traders.map((x) => ({ tag: x.tag, levels: x.levels.levels.map((l) => l.price) }));
    memo = { t, note, marks };
    readMemo.set(coin, memo);
  }
  return coinCardText(built.card, memo.note, memo.marks, label);
}

/**
 * One wake-up (every 15 minutes): once per new 4H close, for each coin switched on, build and send what is due. A
 * coin whose candles are still downloading after a restart waits; an error is logged and that close retried.
 */
export async function cardStep(
  deps: { client: BitunixClient; db: Db; log: Logger; telegram: TelegramConfig | null; grok?: Grok | null; traders?: string[] | null; fetchFn?: typeof fetch; cdaKey?: string | null; cdaFetch?: typeof fetch; clKey?: string | null; clFetch?: typeof fetch },
  now: number,
): Promise<number> {
  if (!deps.telegram) return 0;
  const sw = await loadCardSwitches(deps.db), on = CARD_COINS.filter((c) => sw[c].on);
  if (!on.length) return 0;
  const t = Math.floor(now / H4) * H4;
  const sentList = (await loadSnapshot<string[]>(deps.db, CARD_SENT_KEY)) ?? [], sent = new Set(sentList);
  const updated = (await loadSnapshot<Partial<Record<CardCoin, string>>>(deps.db, CARD_UPDATE.key)) ?? {};
  let n = 0, newUpdate = false;
  for (const coin of on) {
    if (doneClose.get(coin) === t) continue;
    if (!isReady(coin)) { deps.log.info('cards: candles still downloading', { coin }); continue; }
    try {
      // Nothing to build when this close's card was already sent or comes before the switch.
      const onAtClose = t >= (sw[coin].since ?? Infinity), due = onAtClose && !sent.has(cardKey(coin, t, 0));
      // The UPDATED repost: the close's card went out before this deploy, and this tag has not been posted for the coin.
      const repost = onAtClose && !due && updated[coin] !== CARD_UPDATE.tag;
      if (repost) {
        await update(deps.client, coin, ['15m', '1h', '4h', '1d'], t);
        const missing = liveMissing(await liveData(deps, coin, t, now));
        if (missing) {
          // Held: asked again (fresh calls) at the next wake-up.
          deps.log.info('cards: UPDATED repost held until the live sources answer', { coin, missing });
          liveMemo.delete(coin);
          continue;
        }
      }
      const msgs = due ? dueCardMessages(coin, t, sw[coin], await coinMessages(deps, coin, t, now), sent)
        : repost ? (await coinMessages(deps, coin, t, now, CARD_UPDATE.label)).map((text, k) => ({ key: updateKey(coin, t, k), text })).filter((m) => !sent.has(m.key)) : [];
      for (const m of msgs) {
        await sendTelegram(deps.telegram, m.text, deps.fetchFn);
        sentList.push(m.key); sent.add(m.key); n++;
      }
      if ((due || repost) && updated[coin] !== CARD_UPDATE.tag) { updated[coin] = CARD_UPDATE.tag; newUpdate = true; }
      doneClose.set(coin, t);
    } catch (err) {
      deps.log.error('cards: step failed (retried next wake-up)', { coin, error: (err as Error).message.replace(deps.telegram.token, '***') });
    }
  }
  if (n) await saveSnapshot(deps.db, CARD_SENT_KEY, sentList.slice(-KEEP_SENT));
  if (newUpdate) await saveSnapshot(deps.db, CARD_UPDATE.key, updated);
  return n;
}
