import spec from "../shared/ict-engine-spec.json" with { type: "json" };
import { scanIct, type IctFeeds, type IctTimeframe } from "./ict-engine.ts";

type BacktestTrade = {
  setup_id: string;
  direction: "BUY" | "SELL";
  signal_time_ms: number;
  entry_time_ms: number | null;
  exit_time_ms: number | null;
  fill_price: number | null;
  result: "TP1" | "TP2" | "SL" | "NOT_TAKEN" | "OPEN";
  net_r: number;
  assumption: string;
};

function metrics(trades: BacktestTrade[]) {
  const resolved = trades.filter(trade => ["TP1", "TP2", "SL"].includes(trade.result));
  const wins = resolved.filter(trade => trade.net_r > 0), losses = resolved.filter(trade => trade.net_r < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.net_r, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.net_r, 0));
  let equity = 0, peak = 0, drawdown = 0, streak = 0, maxStreak = 0;
  for (const trade of resolved) {
    equity += trade.net_r;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
    streak = trade.net_r < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const totalR = trades.reduce((sum, trade) => sum + trade.net_r, 0);
  const averageR = resolved.length ? resolved.reduce((sum, trade) => sum + trade.net_r, 0) / resolved.length : 0;
  return {
    trades: trades.length, resolved: resolved.length, wins: wins.length, losses: losses.length,
    not_taken: trades.filter(trade => trade.result === "NOT_TAKEN").length,
    open_or_expired: trades.filter(trade => ["OPEN", "EXPIRED"].includes(trade.result)).length,
    win_rate: resolved.length ? wins.length / resolved.length : 0,
    profit_factor: grossLoss ? grossProfit / grossLoss : null, total_r: totalR, average_r: averageR,
    expectancy_r: averageR, maximum_drawdown_r: drawdown, maximum_consecutive_losses: maxStreak,
    trade_count_for_metrics: resolved.length,
  };
}

export function backtestIct(
  feeds: IctFeeds,
  timeframe: IctTimeframe = "M5",
  symbol = "XAUUSD",
  options: { spread?: number; slippage?: number; commissionR?: number; entryDelayBars?: number } = {},
) {
  const minutes = spec.timeframes_minutes[timeframe];
  const input = feeds[timeframe];
  const base = Array.isArray(input) ? input : input?.bars;
  if (!minutes || !base) throw new Error(`Unsupported or missing backtest timeframe '${timeframe}'.`);
  const spread = options.spread ?? 0, slippage = options.slippage ?? 0;
  const commissionR = options.commissionR ?? 0, entryDelay = options.entryDelayBars ?? 1;
  if (Math.min(spread, slippage, commissionR) < 0 || !Number.isInteger(entryDelay) || entryDelay < 1) {
    throw new Error("Spread, slippage and commission must be non-negative; entry delay must be at least one bar.");
  }
  if (base.length < 61) throw new Error("Need at least 61 candles to backtest a setup and its execution.");
  const intervalMs = minutes * 60_000, trades: BacktestTrade[] = [], seen = new Set<string>();
  for (let index = 59; index < base.length - 1; index++) {
    const asOf = base[index].timestamp_ms + intervalMs, available: IctFeeds = {};
    for (const [tf, feed] of Object.entries(feeds)) {
      const duration = spec.timeframes_minutes[tf as keyof typeof spec.timeframes_minutes];
      const bars = Array.isArray(feed) ? feed : feed?.bars;
      if (duration && bars) available[tf] = bars.filter(bar => bar.timestamp_ms + duration * 60_000 <= asOf);
    }
    const result = scanIct(available, timeframe, symbol);
    for (const setup of result.setups) {
      if (!["AWAITING_RETRACE", "IN_ENTRY_ZONE"].includes(setup.status) || setup.score < result.min_score) continue;
      const key = `${setup.direction}:${setup.sweep.ts}:${setup.event.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const plan = setup.plan, entryCost = spread / 2 + slippage, exitCost = spread / 2 + slippage;
      const entry = plan.entry + (setup.direction === "bull" ? entryCost : -entryCost);
      const risk = Math.abs(plan.stop - entry);
      if (risk <= 0) continue;
      const expiry = Math.min(base.length - 1, index + Math.max(1, Math.floor((plan.valid_until_ms - asOf) / intervalMs)));
      let fillIndex: number | null = null, exitIndex: number | null = null;
      let outcome: BacktestTrade["result"] = "OPEN", netR = 0;
      for (let futureIndex = index + entryDelay; futureIndex <= expiry; futureIndex++) {
        const bar = base[futureIndex];
        if (fillIndex === null) {
          const intersects = bar.low <= plan.entry_high && bar.high >= plan.entry_low;
          const targetBeforeFill = setup.direction === "bear" ? bar.low <= plan.tp1 : bar.high >= plan.tp1;
          if (!intersects) {
            if (targetBeforeFill) { outcome = "NOT_TAKEN"; exitIndex = futureIndex; break; }
            continue;
          }
          fillIndex = futureIndex;
        }
        const stopHit = setup.direction === "bear" ? bar.high >= plan.stop : bar.low <= plan.stop;
        const tp1Hit = setup.direction === "bear" ? bar.low <= plan.tp1 : bar.high >= plan.tp1;
        const tp2Hit = setup.direction === "bear" ? bar.low <= plan.tp2 : bar.high >= plan.tp2;
        if (stopHit) {
          outcome = "SL"; exitIndex = futureIndex; netR = -1 - exitCost / risk - commissionR; break;
        }
        if (tp1Hit) {
          outcome = "TP1"; exitIndex = futureIndex;
          netR = Math.abs(plan.tp1 - entry) / risk - exitCost / risk - commissionR; break;
        }
        if (tp2Hit) {
          outcome = "TP2"; exitIndex = futureIndex;
          netR = Math.abs(plan.tp2 - entry) / risk - exitCost / risk - commissionR; break;
        }
      }
      trades.push({
        setup_id: `${symbol}:${timeframe}:${setup.direction}:${setup.sweep.ts}:${setup.event.ts}`,
        direction: setup.action, signal_time_ms: asOf,
        entry_time_ms: fillIndex === null ? null : base[fillIndex].timestamp_ms,
        exit_time_ms: exitIndex === null ? null : base[exitIndex].timestamp_ms,
        fill_price: fillIndex === null ? null : entry, result: outcome, net_r: netR,
        assumption: "closed-candle signal; next-bar limit-zone fill; stop-first on ambiguous OHLC bars",
      });
    }
  }
  const split = Math.floor(trades.length * 0.7);
  return {
    engine_version: spec.engine_version, symbol, timeframe, trades, statistics: metrics(trades),
    in_sample: metrics(trades.slice(0, split)), out_of_sample: metrics(trades.slice(split)), split_ratio: 0.7,
    assumptions: [
      "No look-ahead: each scan uses only completed candles at its as-of timestamp.",
      "Limit fills require a later candle to overlap the entry zone.",
      "If stop and target touch in one candle, stop is evaluated first.",
      "No tick-level order, partial fills, financing or venue-specific commission model.",
    ],
  };
}
