// The RSI framework's RSI length (owner 2026-10-18: "we could test our rsi14 system against a rsi 21 and rsi30 for most
// things we've built"). 14 is the live length. portfolio.ts --rsi-len 21 | 30 changes it for one research run: every
// study that builds the framework's setups (frameworkSetups in rsisignals.ts, momentumEvents' weekly RSI) and the
// 15M-RSI10 model's 4H / 1H / 15m / daily RSI (rsi10.ts; RSI 14 as live: the "10" in its name is not the length, owner
// 2026-10-18), the thresholds unchanged. The worker never changes it.
export const RSI_FRAMEWORK = { len: 14 };
