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

Scripts sent before this library started are ported but their originals were not stored; they are listed in the
`coincard.ts` header (the cards' 25 scripts) and in each port's header.
