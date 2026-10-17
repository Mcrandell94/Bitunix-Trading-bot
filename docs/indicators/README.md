# Indicator script library

The owner's TradingView scripts, kept for testing and later use (owner 2026-10-16: "I'm going to leave indicator
scripts here to test and for later access"). Each original is stored as given, with its author's licence header, when
the licence allows it in this public repository (MPL 2.0, CC BY-NC-SA 4.0). Scripts marked "all rights reserved", or
without a licence that allows sharing, are listed here by name only.

The TypeScript ports live in `packages/backtest/src/screen/`; each port's header has its rules and notes. Results of
any tests are in `docs/RESULTS.md`.

Status: **saved** (stored, not ported) · **ported** (calculations ported, unit tests) · **on the cards** (feeds the
ETH / BTC card POIs) · **tested** (backtested, see RESULTS.md).

| Added | Script | Author | Licence | Original | Port | Status |
|---|---|---|---|---|---|---|
| 2026-10-16 | Open Liquidity Heatmap (v1.5) | BigBeluga | CC BY-NC-SA 4.0 (non-commercial) | [open-liquidity-heatmap-bigbeluga.pine](open-liquidity-heatmap-bigbeluga.pine) | `openliq.ts` | ported, on the cards (Liq, 4H and daily) |
| 2026-10-16 | Liquidity Trend Heatmap | BigBeluga | CC BY-NC-SA 4.0 (non-commercial) | [liquidity-trend-heatmap-bigbeluga.pine](liquidity-trend-heatmap-bigbeluga.pine) | `ltheat.ts` | ported, on the cards (Liq nodes from 50% of its POC, and its trend line as a level; 4H and daily) |
| 2026-10-16 | RedK Indicator Amplifier v1.0 (build v0.30) | RedKTrader | MPL 2.0 | [redk-indicator-amplifier-v1.pine](redk-indicator-amplifier-v1.pine) | `iamp.ts` | ported (all four presets and the external-source modes); not on the cards: an oscillator, it gives no price levels for the POIs. Its RSI 14 reading per timeframe is in the preview's chart check |
| 2026-10-16 | Liquidity Zones | BigBeluga | CC BY-NC-SA 4.0 (non-commercial) | [liquidity-zones-bigbeluga.pine](liquidity-zones-bigbeluga.pine) | `liqzones.ts` | ported, on the cards (Liq: its live lines at the pivot ± ATR(200) as levels; 4H and daily) |
| 2026-10-16 | Liquidity Structure & Order Flow | LuxAlgo | CC BY-NC-SA 4.0 (non-commercial) | [liquidity-structure-order-flow-luxalgo.pine](liquidity-structure-order-flow-luxalgo.pine) | `lsof.ts` | ported, on the cards (Liq: the 300-bar profile's POC, VAH and VAL as levels; 4H and daily). The void, mid, mass, delta and unusual-volume bars are in the chart check |
| 2026-10-16 | Squeeze Momentum Indicator (SQZMOM_LB) | LazyBear | none in the copy given (TradingView's default for open scripts: MPL 2.0) | [squeeze-momentum-lazybear.pine](squeeze-momentum-lazybear.pine) | `sqzmom.ts` | ported; not on the cards: a momentum oscillator, it gives no price levels for the POIs. Its reading (momentum, squeeze state, last release) per timeframe is in the preview's chart check |
| 2026-10-16 | Trend Lines v2 | LonesomeTheBlue | MPL 2.0 | [trend-lines-v2-lonesometheblue.pine](trend-lines-v2-lonesometheblue.pine) | `trendlines.ts` | ported, on the cards (S/R: each up / down line's value at the close as a level; W, D and 4H) |
| 2026-10-16 | AlphaTrend | KivancOzbilgic | MPL 2.0 | [alphatrend-kivancozbilgic.pine](alphatrend-kivancozbilgic.pine) | `alphatrend.ts` | ported, on the cards (Levels: its line at the close; W, D and 4H). Its BUY / SELL labels are in the chart check |
| 2026-10-16 | Volume Flow Indicator (VFI_LB) | LazyBear | none in the copy given (the author asks for a note when it is used; TradingView's default for open scripts: MPL 2.0) | [volume-flow-indicator-lazybear.pine](volume-flow-indicator-lazybear.pine) | `vfi.ts` | ported; not on the cards: a volume oscillator, it gives no price levels for the POIs. Its reading (VFI, signal, last crosses) per timeframe is in the preview's chart check |
| 2026-10-16 | Volumized Order Blocks | Flux Charts | MPL 2.0 | [volumized-order-blocks-fluxcharts.pine](volumized-order-blocks-fluxcharts.pine) | `fluxob.ts` | ported, on the cards (OB: the zones it shows, 3 a side, merged as the script does, not the broken ones; W, D and 4H) |
| 2026-10-16 | Support and Resistance Signals MTF | LuxAlgo | CC BY-NC-SA 4.0 (non-commercial) | [support-resistance-signals-mtf-luxalgo.pine](support-resistance-signals-mtf-luxalgo.pine) | `luxsrsignals.ts` | ported, on the cards (S/R: its newest and previous zone a side, not broken; W, D and 4H). Its breakout / test / retest / rejection signals are in the chart check; the manipulation boxes are not ported |
| 2026-10-17 | Dynamic Volume Adaptive Moving Average (MZ DVAMA) | MightyZinger | MPL 2.0 | [dvama-mightyzinger.pine](dvama-mightyzinger.pine) | `dvama.ts` | ported, on the cards (Levels: the line, its ±2.5 ATR(40) lines and the outer zones 4.25..5 ATR(40); W, D and 4H). Its colour and Long / Short signals are in the chart check |
| 2026-10-17 | ADX and DI | xdecow | none in the copy given (TradingView's default for open scripts: MPL 2.0) | [adx-di-xdecow.pine](adx-di-xdecow.pine) | `adxdi.ts` | ported; not on the cards: a trend-strength oscillator, it gives no price levels for the POIs. Its reading (ADX, +DI / -DI, trend) per timeframe is in the preview's chart check |
| 2026-10-17 | Heatmap Volume | xdecow | none in the copy given (TradingView's default for open scripts: MPL 2.0) | [heatmap-volume-xdecow.pine](heatmap-volume-xdecow.pine) | `volheatmap.ts` | ported earlier (2026-10-13, cards v2), the same script and defaults as this copy; not a POI script (volume only, no price levels). Its reading per timeframe is in the preview's chart check |
| 2026-10-17 | Momentum Ghost Machine | ChartPrime | MPL 2.0 | [momentum-ghost-machine-chartprime.pine](momentum-ghost-machine-chartprime.pine) | `mgm.ts` | ported; not on the cards: a momentum oscillator (windowed-sinc filter), it gives no price levels for the POIs. Its reading (momentum, MA, histogram colour, ghost bars) per timeframe is in the preview's chart check |
| 2026-10-17 | Volume Delta Pivot Matrix | BigBeluga | CC BY-NC-SA 4.0 (non-commercial) | [volume-delta-pivot-matrix-bigbeluga.pine](volume-delta-pivot-matrix-bigbeluga.pine) | `vdpm.ts` | ported, on the cards (S/R: the unbroken pivot levels it draws, the 10 newest with 20%+ of the largest delta; W, D and 4H) |
| 2026-10-17 | Buyside & Sellside Liquidity | LuxAlgo | CC BY-NC-SA 4.0 (non-commercial) | [buyside-sellside-liquidity-luxalgo.pine](buyside-sellside-liquidity-luxalgo.pine) | `luxbsl.ts` | ported, on the cards (Liq: its kept buyside / sellside levels not yet swept; W, D and 4H). Liquidity voids (off by default) are not ported |

Scripts sent before this library started are ported but their originals were not stored; they are listed in the
`coincard.ts` header (the scripts behind the card POIs) and in each port's header.
