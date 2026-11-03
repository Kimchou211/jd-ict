"""Live XAUUSD quote retrieval and deterministic multi-indicator scan.

Candles use the configured Twelve Data provider with Yahoo Finance fallback. The source
timestamp is carried through so stale data is flagged rather than silently called live.
This is market-data analysis only; it never places orders.
"""
from __future__ import annotations

from typing import Any

from .market_data import fetch_candles

INTERVALS = {"1m": "M1", "5m": "M5", "15m": "M15", "60m": "H1"}


async def fetch_live_market(interval: str = "1m") -> dict[str, Any]:
    """Fetch live-terminal candles through the shared configured-provider fallback."""
    timeframe = INTERVALS.get(interval)
    if timeframe is None:
        raise ValueError("Unsupported interval. Choose 1m, 5m, 15m or 60m.")
    feed = await fetch_candles(timeframe)
    source = feed["source"]
    feed_symbol = "XAU/USD" if source.startswith("Twelve Data") else "XAUUSD=X"
    return {
        "symbol": "XAUUSD",
        "feed_symbol": feed_symbol,
        "source": source,
        "provider_url": ("https://twelvedata.com/" if feed_symbol == "XAU/USD"
                         else "https://finance.yahoo.com/quote/XAUUSD=X/"),
        "currency": "USD",
        "exchange_timezone": "UTC",
        "interval": interval,
        "timeframe": timeframe,
        "price": feed["price"],
        "provider_market_price": None,
        "last_bar_time": feed["last_bar_time"],
        "last_bar_timestamp_ms": feed["last_bar_ms"],
        "fetched_at": feed["fetched_at"],
        "age_seconds": feed["age_seconds"],
        "is_stale": feed["is_stale"],
        "bars": feed["bars"][-120:],
        **{
            key: feed[key]
            for key in ("fallback_reason", "data_quality_status", "missing_candle_count", "aggregation_source")
            if key in feed
        },
    }


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2.0 / (period + 1.0)
    out = [values[0]]
    for value in values[1:]:
        out.append(alpha * value + (1.0 - alpha) * out[-1])
    return out


def _rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) <= period:
        return None
    gains: list[float] = []
    losses: list[float] = []
    for prev, current in zip(values[:-1], values[1:]):
        change = current - prev
        gains.append(max(0.0, change))
        losses.append(max(0.0, -change))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for gain, loss in zip(gains[period:], losses[period:]):
        avg_gain = ((period - 1) * avg_gain + gain) / period
        avg_loss = ((period - 1) * avg_loss + loss) / period
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def _atr(bars: list[dict[str, Any]], period: int = 14) -> float | None:
    if len(bars) <= period:
        return None
    true_ranges = []
    for index in range(1, len(bars)):
        candle = bars[index]
        previous_close = bars[index - 1]["close"]
        true_ranges.append(max(candle["high"] - candle["low"], abs(candle["high"] - previous_close), abs(candle["low"] - previous_close)))
    recent = true_ranges[-period:]
    return sum(recent) / len(recent) if recent else None


def calculate_live_scan(market: dict[str, Any]) -> dict[str, Any]:
    """Calculate transparent technical confluence, entry watch zone and risk levels."""
    bars = list(market.get("bars") or [])
    if len(bars) < 35:
        raise ValueError("Not enough candles to calculate the live scan.")
    closes = [float(b["close"]) for b in bars]
    ema9_series = _ema(closes, 9)
    ema21_series = _ema(closes, 21)
    ema50_series = _ema(closes, 50)
    macd_fast = _ema(closes, 12)
    macd_slow = _ema(closes, 26)
    macd_line_series = [a - b for a, b in zip(macd_fast, macd_slow)]
    macd_signal_series = _ema(macd_line_series, 9)
    price = float(market["price"])
    ema9, ema21, ema50 = ema9_series[-1], ema21_series[-1], ema50_series[-1]
    rsi = _rsi(closes, 14)
    atr = _atr(bars, 14)
    macd = macd_line_series[-1]
    macd_signal = macd_signal_series[-1]
    histogram = macd - macd_signal
    recent = bars[-21:-1]
    recent_high = max(b["high"] for b in recent)
    recent_low = min(b["low"] for b in recent)

    score = 0
    reasons: list[str] = []
    if price > ema9:
        score += 1; reasons.append("Price above EMA 9")
    elif price < ema9:
        score -= 1; reasons.append("Price below EMA 9")
    if ema9 > ema21:
        score += 1; reasons.append("EMA 9 above EMA 21")
    elif ema9 < ema21:
        score -= 1; reasons.append("EMA 9 below EMA 21")
    if ema21 > ema50:
        score += 1; reasons.append("EMA 21 above EMA 50")
    elif ema21 < ema50:
        score -= 1; reasons.append("EMA 21 below EMA 50")
    if rsi is not None:
        if 52 <= rsi <= 70:
            score += 1; reasons.append("RSI bullish momentum (52–70)")
        elif 30 <= rsi <= 48:
            score -= 1; reasons.append("RSI bearish momentum (30–48)")
        elif rsi > 75:
            score -= 1; reasons.append("RSI overbought; long entries need caution")
        elif rsi < 25:
            score += 1; reasons.append("RSI oversold; short entries need caution")
    if histogram > 0:
        score += 1; reasons.append("MACD histogram positive")
    elif histogram < 0:
        score -= 1; reasons.append("MACD histogram negative")
    if price > recent_high:
        score += 2; reasons.append("Break above previous 20-candle high")
    elif price < recent_low:
        score -= 2; reasons.append("Break below previous 20-candle low")

    direction = "BUY" if score >= 4 else "SELL" if score <= -4 else "WAIT"
    stale = bool(market.get("is_stale"))
    if stale:
        direction = "WAIT"
        reasons.insert(0, "Feed timestamp is stale; directional signals are disabled")
    confidence = min(88, 38 + abs(score) * 7) if direction != "WAIT" else min(48, 32 + abs(score) * 4)
    atr_value = atr or max(0.01, abs(price) * 0.0005)

    entry_low = entry_high = stop_loss = tp1 = tp2 = None
    action = "WAIT_FOR_CONFIRMATION"
    if direction == "BUY":
        entry_low, entry_high = sorted((ema9, ema21))
        entry_price = (entry_low + entry_high) / 2
        risk = max(atr_value * 1.2, entry_price - (recent_low - 0.1 * atr_value))
        stop_loss = entry_price - risk
        tp1, tp2 = entry_price + risk, entry_price + 1.8 * risk
        action = "WAIT_FOR_PULLBACK" if price > entry_high + 0.8 * atr_value else "BUY_SETUP_WATCH"
    elif direction == "SELL":
        entry_low, entry_high = sorted((ema9, ema21))
        entry_price = (entry_low + entry_high) / 2
        risk = max(atr_value * 1.2, (recent_high + 0.1 * atr_value) - entry_price)
        stop_loss = entry_price + risk
        tp1, tp2 = entry_price - risk, entry_price - 1.8 * risk
        action = "WAIT_FOR_PULLBACK" if price < entry_low - 0.8 * atr_value else "SELL_SETUP_WATCH"

    output_bars = []
    for index, bar in enumerate(bars):
        output_bars.append({**bar, "ema9": ema9_series[index], "ema21": ema21_series[index], "ema50": ema50_series[index]})
    current = output_bars[-1]
    return {
        "live_market_scan": True,
        "symbol": "XAUUSD",
        "direction": direction,
        "model_bias": direction,
        "confidence": confidence,
        "confluence_score": score,
        "confluence_max": 7,
        "action": action,
        "trade_ready": False,
        "levels_available": entry_low is not None and not stale,
        "entry_price": (entry_low + entry_high) / 2 if entry_low is not None else None,
        "entry_low": entry_low,
        "entry_high": entry_high,
        "stop_loss": stop_loss,
        "take_profit_1": tp1,
        "take_profit_2": tp2,
        "current_price": price,
        "ema9": ema9,
        "ema21": ema21,
        "ema50": ema50,
        "rsi14": rsi,
        "atr14": atr,
        "macd": macd,
        "macd_signal": macd_signal,
        "macd_histogram": histogram,
        "recent_resistance": recent_high,
        "recent_support": recent_low,
        "setup_rationale": "; ".join(reasons) if reasons else "No clear technical confluence yet.",
        "risk_notes": [
            "Technical confluence is a screening aid, not a win probability or guaranteed signal.",
            "Entry zone is based on EMA 9/21 pullback; verify live broker spread and candle close.",
            "Quote provider timestamps can lag your broker. Confirm XAUUSD in MT5 before trading.",
        ] + (["Live feed is stale; no directional setup is active."] if stale else []),
        "feed": {k: v for k, v in market.items() if k != "bars"},
        "bars": output_bars,
        "current_candle": current,
        "ai_review": None,
        "scan_source": "rule_based_technical_scan",
    }
