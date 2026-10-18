// The RSI framework's RSI length (owner 2026-10-18: "we could test our rsi14 system against a rsi 21 and rsi30 for most
// things we've built"). 14 is the live length. portfolio.ts --rsi-len 21 | 30 changes it for one research run: every
// study that builds the framework's setups (frameworkSetups in rsisignals.ts, momentumEvents' weekly RSI), the
// thresholds unchanged. The worker never changes it.
export const RSI_FRAMEWORK = { len: 14 };
