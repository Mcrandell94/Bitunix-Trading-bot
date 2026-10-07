import { describe, expect, test } from 'vitest';
import type { RsiSignalRow } from '@bot/backtest';
import { migrate } from '@bot/store';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { applyControl, parseControl, type ControlDeps } from '../src/controls';
import { silentLogger } from '../src/index';
import { alertText, dueAlerts, eventKey, loadRsiAlerts, rsiAlertStep, sendTelegram, type RsiAlertSettings } from '../src/telegram';
import type { RsiLiveSettings } from '../src/rsiLive';

const row = (o: Partial<RsiSignalRow>): RsiSignalRow => ({
  symbol: 'BEAMXUSDT', model: 'triple-div', variant: 1, exitName: '20R target, 90 days', side: 'long', signalAt: 1_000, status: 'enter',
  entry: 0.0061, enteredAt: null, stop: 0.0055, target: null, lastPrice: 0.0061, r: null, exit: null, until: null, closedAt: null, stopPct: 9.8,
  plans: ['option 1', 'no exceptions'], ...o,
});
const alerts = (on: boolean, since: number | null): RsiAlertSettings => ({ 'triple-div': { on, since } } as RsiAlertSettings);
const live = { 'triple-div': { on: false, plan: 'option 1', variant: 1 } } as unknown as RsiLiveSettings;

describe('live signal alerts', () => {
  test('only the switched-on model, its picked exit, events since the switch, each once', () => {
    const rows = [row({}), row({ variant: 0 }), row({ signalAt: 500 }), row({ model: 'bottom-div' })];
    expect(dueAlerts(rows, alerts(true, 900), live, new Set(), 2_000)).toEqual([rows[0]]);
    expect(dueAlerts(rows, alerts(true, 900), live, new Set([eventKey(rows[0]!)]), 2_000)).toEqual([]);
    expect(dueAlerts(rows, alerts(false, null), live, new Set(), 2_000)).toEqual([]);
    // A setup still waiting for its trigger is sent when first seen, even if found before the switch (a coin just added).
    const waiting = row({ status: 'waiting', signalAt: 500, entry: null, stop: null, until: 5_000 });
    expect(dueAlerts([waiting], alerts(true, 900), live, new Set(), 2_000)).toEqual([waiting]);
    // Nothing more than 2 weeks old is sent, waiting setups included.
    const DAY = 86_400_000;
    expect(dueAlerts([waiting], alerts(true, 900), live, new Set(), 500 + 14 * DAY)).toEqual([waiting]);
    expect(dueAlerts([waiting], alerts(true, 900), live, new Set(), 501 + 14 * DAY)).toEqual([]);
    expect(dueAlerts([rows[0]!], alerts(true, 900), live, new Set(), 1_001 + 14 * DAY)).toEqual([]);
    expect(dueAlerts([waiting], alerts(true, 900), live, new Set([eventKey(waiting)]), 2_000)).toEqual([]);
  });

  test('a closed trade is a new event, timed by its close', () => {
    const closed = row({ status: 'closed', enteredAt: 2_000, closedAt: 9_000, exit: 'target', r: 3.1, lastPrice: 0.008 });
    expect(dueAlerts([closed], alerts(true, 5_000), live, new Set([eventKey(row({}))]), 10_000)).toEqual([closed]);
    expect(alertText(closed)).toContain('Closed (🎯 target) at 0.008: +3.10R');
  });

  test('message text: side, coin, model, levels; HTML-safe', () => {
    const t = alertText(row({}));
    expect(t).toContain('🟢 LONG <b>BEAMXUSDT</b>');
    expect(t).toContain('Entry signal: enter at the next open (about 0.0061)');
    expect(t).toContain('Stop 0.0055 (9.8%)');
    expect(alertText(row({ symbol: 'A<B' }))).toContain('A&lt;B');
    expect(t).not.toContain('Supported');
    expect(alertText(row({ model: '15m-rsi10', support: ['bullish order block 4H', 'bullish order block 1D'] }))).toContain('Supported with bullish order block 4H + bullish order block 1D');
  });

  test('posts to the Bot API and surfaces errors', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const ok = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    await sendTelegram({ token: 'T', chatId: '-100' }, 'hi', ok);
    expect(calls[0]).toEqual({ url: 'https://api.telegram.org/botT/sendMessage', body: { chat_id: '-100', text: 'hi', parse_mode: 'HTML', disable_web_page_preview: true } });
    await sendTelegram({ token: 'T', chatId: '-100', threadId: 42 }, 'hi', ok);
    expect(calls[1]!.body).toMatchObject({ message_thread_id: 42 });
    const bad = (async () => new Response('chat not found', { status: 400 })) as unknown as typeof fetch;
    await expect(sendTelegram({ token: 'T', chatId: '1' }, 'x', bad)).rejects.toThrow('telegram 400: chat not found');
  });

  test('test button: sends "signal test", refuses without Telegram', async () => {
    expect(parseControl({ action: 'telegram-test' })).toEqual({ action: 'telegram-test' });
    const deps = { db: null as never, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => 0, telegram: null };
    await expect(applyControl(deps, { action: 'telegram-test' }, 'test')).rejects.toThrow(/not set up/);
    const bad = (async () => new Response('Forbidden: bot is not a member', { status: 403 })) as unknown as typeof fetch;
    await expect(applyControl({ ...deps, telegram: { token: 'SECRET', chatId: '1' }, fetchFn: bad }, { action: 'telegram-test' }, 'test')).rejects.toThrow(/403: Forbidden/);
  });

  test('the dashboard switch is validated', () => {
    expect(parseControl({ action: 'rsi-alert', model: 'triple-div', on: true })).toEqual({ action: 'rsi-alert', model: 'triple-div', on: true });
    expect(() => parseControl({ action: 'rsi-alert', model: 'triple-div' })).toThrow();
    expect(() => parseControl({ action: 'rsi-alert', model: 'nope', on: true })).toThrow();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('live signal alerts (Postgres)', { timeout: 60_000 }, () => {
  test('switch on at t, send new events once, retry after a failed send, nothing when off', async () => {
    const { pool, drop } = await freshSchema();
    try {
      await migrate(pool);
      const deps: ControlDeps = { db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => 900 };
      await applyControl(deps, { action: 'rsi-live', model: 'triple-div', variant: 1 }, 'test');
      await applyControl(deps, { action: 'rsi-alert', model: 'triple-div', on: true }, 'test');
      expect((await loadRsiAlerts(pool))['triple-div']).toEqual({ on: true, since: 900 });
      const sent: string[] = [];
      let fail = true;
      const fetchFn = (async (_u: string, init: RequestInit) => {
        if (fail) { fail = false; return new Response('down', { status: 502 }); }
        sent.push(JSON.parse(String(init.body)).text); return new Response('{}');
      }) as unknown as typeof fetch;
      const snap = { time: 1_000, coins: 1, rows: [row({}), row({ signalAt: 100 })] };
      const step = () => rsiAlertStep({ db: pool, log: silentLogger, telegram: { token: 'T', chatId: '1' }, fetchFn, now: () => 3_000 }, snap);
      expect(await step()).toBe(0); // Telegram down: nothing remembered
      expect(await step()).toBe(1); // sent now; the signal from before the switch is never sent
      expect(await step()).toBe(0); // once only
      expect(sent).toHaveLength(1);
      await applyControl(deps, { action: 'rsi-alert', model: 'triple-div', on: false }, 'test');
      expect(await rsiAlertStep({ db: pool, log: silentLogger, telegram: { token: 'T', chatId: '1' }, fetchFn, now: () => 3_000 }, { ...snap, rows: [row({ signalAt: 2_000 })] })).toBe(0);
    } finally {
      await drop();
    }
  });
});
