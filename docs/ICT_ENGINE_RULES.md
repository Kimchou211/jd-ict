# ICT Engine 3.0 rules

## Canonical settings

`shared/ict-engine-spec.json` is loaded by the Python and Worker engines. It owns timeframe lengths, swing strengths, ATR and FVG thresholds, displacement tiers, New York session windows, scoring caps, minimum theoretical R:R, and data-coverage thresholds. Algorithmic calculations are implemented in both runtimes and checked against identical candles with a price tolerance of `max(1e-8, abs(value) * 1e-10)`.

All timestamps are UTC milliseconds. Session classification converts them to `America/New_York` through IANA timezone data, so DST transitions are applied automatically. Default windows are Asia 20:00–00:00, London Kill Zone 02:00–05:00, and New York Kill Zone 07:00–10:00 New York time.

## Measurements and event order

- Confirmed swings use the configured left/right candles. A swing is not available before its right-side confirmation candle. Internal structure uses strength 2; external structure uses strength 5. The existing default-strength structure events remain the source of the legacy setup flow.
- BOS is a close through a confirmed swing in the current structure direction. MSS is a close through the opposing swing; `CHoCH` is an alternative label for that same event, not an additional event.
- Displacement is measured by candle body/ATR, full range/ATR, directional close location, wick/body ratio, and consecutive directional closes. The configured tier thresholds are reported with the values and reasons.
- CISD is distinct from MSS: the last one-to-three consecutive opposing candles define a reference at the open of the earliest candle in that sequence. A close through that reference is confirmed only when the confirming candle also meets at least the MODERATE displacement tier.
- A liquidity sweep requires a wick through a mapped level and a close back across it, either on that bar or within two following bars. Otherwise the level is classified as broken. Prior day/week/month, swing, equal-high/low, Asia, and CRT levels are ranked separately.
- FVG bounds come from the three-candle gap. CE is the midpoint. Touch count, maximum mitigation, first touch, size/ATR, and lifecycle are reported. A close through the far boundary invalidates the zone. IFVG requires an invalidated FVG followed by a retest and a close on the flipped side of its midpoint. BPR requires a non-empty overlap between opposite-direction FVGs.
- OTE is produced only from a confirmed structure-event leg with at least MODERATE displacement; it uses the configured 62%–79% retracement. The anchors, retracement and displacement tier are returned. The old arbitrary fallback range is removed.
- Regime labels use structure, recent directional closes, and recent true-range expansion/contraction. They are descriptive and not a trade trigger.

## Scores and plans

The setup score is capped by the shared evidence-group profile: higher-timeframe bias, sweep quality, structure/displacement, PD-array confluence, session context, target liquidity, and data quality. Related evidence is capped by group; it is not a win probability. Data quality and entry readiness are separate scores.

Stops remain beyond the observed sweep extreme with the symbol profile's ATR buffer. Targets prefer active opposing liquidity and require the shared minimum theoretical R:R; the existing R-extension fallback is explicitly labeled when no qualifying liquidity is present. AI remains a secondary reviewer and cannot create prices or bypass engine risk checks.

## Full-coverage scanner

The shared scanner registry in `shared/ict-engine-spec.json` is the source of model names, families, enabled/implemented state, event sequences, requirements, and eligible entry timeframes. Each requested symbol is scanned over all available configured feeds (W1/D1/H4/H1/M15/M5/M1); missing or short-history frames are reported in `coverage` and are not passed to detectors. Higher-timeframe context is reused from the same feed snapshot.

Only ICT 2022 (sweep -> MSS -> displacement -> FVG -> retracement), Liquidity Sweep Reversal (sweep -> structure confirmation -> entry array -> risk plan), and Turtle Soup (prior-period extreme -> false break -> structure confirmation -> opposing target) are enabled. All other listed models remain disabled/unavailable until their own algorithm and inputs are implemented. The registry still reports their requirements and event sequence; it does not fabricate candidates.

Candidates have stable IDs based on symbol, timeframe, direction, sweep time, structure-event time, and model classification. Multiple classifications of the same sweep/event share an `opportunity_id`; aggregate opportunity counts use that key. The scanner applies the configured ranking fields without dropping lower-ranked candidates. API and UI filters cover symbol, direction, model, timeframe, lifecycle state, and minimum score.

Candidate `lifecycle` maps the confirmed detector output to WAITING_FOR_RETRACE, ENTRY_READY, TARGET_REACHED, INVALIDATED, or EXPIRED. Routes persist state transitions by setup ID in `setup_lifecycle_history`; missing prior candidates are rechecked against current price and expiry. DETECTED/FORMING/ACTIVE transitions are not emitted because the current detectors do not produce those states.

## Candle quality and replay

Feeds discard incomplete candles, normalize ordering, reject invalid OHLC values, and expose duplicates, missing intervals, history coverage, aggregation source, staleness and market status. Aggregation uses UTC boundaries, OHLCV aggregation rules and a configured coverage threshold; incomplete buckets are omitted or explicitly marked degraded.

Historical replay evaluates each signal using only candles complete at that timestamp. Entries require a later candle to overlap the planned zone. When a candle touches both stop and target, stop is evaluated first. The replay does not model tick ordering, partial exits, financing or venue-specific costs.

## Not yet trade-ready

The model registry reports missing confirmations rather than manufacturing signals. Silver Bullet, Unicorn, breaker continuation, SMT, Power of Three, Judas Swing, OTE/FVG/OB/trend continuation, ICT Macros, MMXM, OSOK, and BPR remain disabled until their model-specific requirements and detectors are implemented.

The current provider profiles support XAUUSD and BTCUSD only. XAGUSD/ETHUSD are not substituted for missing correlated feeds.
