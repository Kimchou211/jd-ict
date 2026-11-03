# ICT engine parity and verification

## Runtime contract

Both `app/ict_engine.py` and `worker/ict-engine.ts` load `shared/ict-engine-spec.json`. Advanced measurements are mirrored in `app/ict_advanced.py` and `worker/ict-advanced.ts`. Price parity is tested to `max(1e-8, abs(value) * 1e-10)`; strings, states, keys, arrays and timestamps must match exactly.

The Python/Worker parity test sends identical single- and multi-timeframe candle snapshots to both implementations and compares complete candidate lists, model discovery, stable IDs, ranking, coverage, lifecycle, plans, and replay results. DST and measurement checks use the same timestamps and candle values in each runtime.

## Scanner behavior

`/api/ict/scan` scans the requested symbol across the available W1/D1/H4/H1/M15/M5/M1 feeds. Query filters are `direction`, `model`, `timeframe`, `status`, and `min_score`; `symbol` selects the market. Missing frames are listed under `coverage` and `data_warnings`. Candidate lifecycle transitions are stored in the scan payload's `setup_lifecycle_history`.

The canonical registry lists all requested families, but only detectors with implemented algorithms are enabled. Currently enabled: ICT 2022, Liquidity Sweep Reversal, and Turtle Soup. This is deliberately not a claim that the remaining model families are implemented. The current detector provides every confirmed sweep/event/entry-array pairing within its lookback; model variants share an opportunity ID so they are not double-counted.

## Verification commands

From the project root:

```powershell
python -m pytest tests
npm test
npm run check
```

`npm run check` regenerates Cloudflare Worker types and runs the TypeScript compiler. It may print Wrangler's advisory about optional Node type definitions; the check result is determined by the command exit code.

## Backtest interpretation

`app/ict_backtest.py` and `worker/ict-backtest.ts` perform chronological replay with configurable spread, slippage, commission in R, and entry delay. They return ordered trades, summary statistics, and chronological 70/30 in-sample/out-of-sample summaries. The split is not walk-forward optimization and is not evidence that the rules are profitable. Candle-only fills, stop-first ambiguity, no tick data, and no partial targets are explicit assumptions.

Historical performance is illustrative only; it is not a forecast or a probability of success. Provider history limits and missing intervals can prevent a timeframe from being sufficient for a particular backtest or higher-timeframe level.
