"""Chronological, candle-close backtesting for the deterministic ICT engine."""
from __future__ import annotations

from math import floor

from .ict_advanced import SPEC
from .ict_engine import scan


def _metrics(trades: list[dict]) -> dict:
    resolved = [trade for trade in trades if trade["result"] in ("TP1", "TP2", "SL")]
    wins = [trade for trade in resolved if trade["net_r"] > 0]
    losses = [trade for trade in resolved if trade["net_r"] < 0]
    gross_profit = sum(trade["net_r"] for trade in wins)
    gross_loss = abs(sum(trade["net_r"] for trade in losses))
    equity, peak, max_drawdown, losing_streak, max_losing_streak = 0.0, 0.0, 0.0, 0, 0
    for trade in resolved:
        equity += trade["net_r"]
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)
        losing_streak = losing_streak + 1 if trade["net_r"] < 0 else 0
        max_losing_streak = max(max_losing_streak, losing_streak)
    return {
        "trades": len(trades), "resolved": len(resolved), "wins": len(wins), "losses": len(losses),
        "not_taken": sum(trade["result"] == "NOT_TAKEN" for trade in trades),
        "open_or_expired": sum(trade["result"] in ("OPEN", "EXPIRED") for trade in trades),
        "win_rate": len(wins) / len(resolved) if resolved else 0,
        "profit_factor": gross_profit / gross_loss if gross_loss else None,
        "total_r": sum(trade["net_r"] for trade in trades),
        "average_r": sum(trade["net_r"] for trade in resolved) / len(resolved) if resolved else 0,
        "expectancy_r": sum(trade["net_r"] for trade in resolved) / len(resolved) if resolved else 0,
        "maximum_drawdown_r": max_drawdown,
        "maximum_consecutive_losses": max_losing_streak,
        "trade_count_for_metrics": len(resolved),
    }


def backtest_ict(
    feeds: dict[str, list[dict]],
    ltf: str = "M5",
    symbol: str = "XAUUSD",
    *,
    spread: float = 0,
    slippage: float = 0,
    commission_r: float = 0,
    entry_delay_bars: int = 1,
) -> dict:
    """Replay closed candles in order; each scan receives only candles complete at its as-of time."""
    minutes = SPEC["timeframes_minutes"].get(ltf)
    if not minutes or ltf not in feeds:
        raise ValueError(f"Unsupported or missing backtest timeframe '{ltf}'.")
    if min(spread, slippage, commission_r) < 0 or entry_delay_bars < 1:
        raise ValueError("Spread, slippage and commission must be non-negative; entry delay must be at least one bar.")
    base = feeds[ltf]
    if len(base) < 61:
        raise ValueError("Need at least 61 candles to backtest a setup and its execution.")
    interval_ms = minutes * 60_000
    trades, seen = [], set()
    for index in range(59, len(base) - 1):
        as_of = base[index]["timestamp_ms"] + interval_ms
        available: dict[str, list[dict]] = {}
        for timeframe, bars in feeds.items():
            duration = SPEC["timeframes_minutes"].get(timeframe)
            if duration:
                available[timeframe] = [bar for bar in bars if bar["timestamp_ms"] + duration * 60_000 <= as_of]
        result = scan(available, ltf, symbol)
        for setup in result["setups"]:
            key = (setup["direction"], setup["sweep"]["ts"], setup["event"]["ts"])
            if (key in seen or setup["score"] < result["min_score"]
                    or setup["status"] not in ("AWAITING_RETRACE", "IN_ENTRY_ZONE")):
                continue
            seen.add(key)
            plan = setup["plan"]
            fill_index, fill_price = None, None
            outcome, net_r, exit_index = "OPEN", 0.0, None
            adverse_entry = spread / 2 + slippage
            exit_cost = spread / 2 + slippage
            entry = plan["entry"] + adverse_entry if setup["direction"] == "bull" else plan["entry"] - adverse_entry
            risk = abs(plan["stop"] - entry)
            if risk <= 0:
                continue
            expiry = min(len(base) - 1, index + max(1, floor((plan["valid_until_ms"] - as_of) / interval_ms)))
            for future_index in range(index + entry_delay_bars, expiry + 1):
                bar = base[future_index]
                if fill_index is None:
                    intersects = bar["low"] <= plan["entry_high"] and bar["high"] >= plan["entry_low"]
                    target_before_fill = bar["low"] <= plan["tp1"] if setup["direction"] == "bear" else bar["high"] >= plan["tp1"]
                    if not intersects:
                        if target_before_fill:
                            outcome, exit_index = "NOT_TAKEN", future_index
                            break
                        continue
                    fill_index, fill_price = future_index, entry
                stop_hit = bar["high"] >= plan["stop"] if setup["direction"] == "bear" else bar["low"] <= plan["stop"]
                tp1_hit = bar["low"] <= plan["tp1"] if setup["direction"] == "bear" else bar["high"] >= plan["tp1"]
                tp2_hit = bar["low"] <= plan["tp2"] if setup["direction"] == "bear" else bar["high"] >= plan["tp2"]
                if stop_hit:
                    outcome, exit_index = "SL", future_index
                    net_r = -1 - exit_cost / risk - commission_r
                    break
                if tp1_hit:
                    outcome, exit_index = "TP1", future_index
                    net_r = abs(plan["tp1"] - (fill_price or plan["entry"])) / risk - exit_cost / risk - commission_r
                    break
                if tp2_hit:
                    outcome, exit_index = "TP2", future_index
                    net_r = abs(plan["tp2"] - (fill_price or plan["entry"])) / risk - exit_cost / risk - commission_r
                    break
            trades.append({
                "setup_id": f"{symbol}:{ltf}:{setup['direction']}:{setup['sweep']['ts']}:{setup['event']['ts']}",
                "direction": setup["action"], "signal_time_ms": as_of, "entry_time_ms": base[fill_index]["timestamp_ms"] if fill_index is not None else None,
                "exit_time_ms": base[exit_index]["timestamp_ms"] if exit_index is not None else None,
                "fill_price": fill_price, "result": outcome, "net_r": net_r,
                "assumption": "closed-candle signal; next-bar limit-zone fill; stop-first on ambiguous OHLC bars",
            })
    cut = floor(len(trades) * 0.7)
    return {
        "engine_version": SPEC["engine_version"], "symbol": symbol, "timeframe": ltf, "trades": trades,
        "statistics": _metrics(trades), "in_sample": _metrics(trades[:cut]), "out_of_sample": _metrics(trades[cut:]),
        "split_ratio": 0.7, "assumptions": ["No look-ahead: each scan uses only completed candles at its as-of timestamp.",
                                              "Limit fills require a later candle to overlap the entry zone.",
                                              "If stop and target touch in one candle, stop is evaluated first.",
                                              "No tick-level order, partial fills, financing or venue-specific commission model."],
    }
