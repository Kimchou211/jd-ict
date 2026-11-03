"""Candle feed for the ICT terminal: Twelve Data first (if a key is set), Yahoo Finance as fallback.

Every result carries the provider, the last-bar time and a stale / market-closed flag, so the
UI never presents old data as live. Results are cached briefly to protect free-tier rate limits.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from math import isfinite
from typing import Any

import httpx

from urllib.parse import quote

from . import symbols
from .config import TWELVEDATA_API_KEY, TWELVEDATA_SYMBOL
from .ict_advanced import SPEC

# tf -> (twelvedata interval, yahoo interval, yahoo range, minutes, cache seconds, bars to request)
TFS: dict[str, tuple[str, str, str, int, int, int]] = {
    "M1": ("1min", "1m", "5d", SPEC["timeframes_minutes"]["M1"], 20, 500),
    "M5": ("5min", "5m", "5d", SPEC["timeframes_minutes"]["M5"], 25, 500),
    "M15": ("15min", "15m", "1mo", SPEC["timeframes_minutes"]["M15"], 60, 500),
    "H1": ("1h", "60m", "3mo", SPEC["timeframes_minutes"]["H1"], 180, 500),
    "H4": ("4h", "60m", "6mo", SPEC["timeframes_minutes"]["H4"], 240, 500),
    "D1": ("1day", "1d", "2y", SPEC["timeframes_minutes"]["D1"], 900, 500),
    "W1": ("1week", "1wk", "5y", SPEC["timeframes_minutes"]["W1"], 1800, 500),
}
AGGREGATE_FROM = {"H4": "H1", "D1": "H1", "W1": "D1"}
_CACHE: dict[str, tuple[float, dict]] = {}
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36", "Accept": "application/json,*/*"}


def _num(v: Any) -> float | None:
    try:
        f = float(v)
        return f if isfinite(f) else None
    except (TypeError, ValueError):
        return None


def market_closed(now: datetime | None = None, symbol: str = "XAUUSD") -> bool:
    """Spot gold: closed from Friday ~22:00 UTC to Sunday ~23:00 UTC. Bitcoin trades 24/7."""
    if not symbols.profile(symbol)["weekend_closed"]:
        return False
    n = now or datetime.now(timezone.utc)
    wd, h = n.weekday(), n.hour
    return (wd == 4 and h >= 22) or wd == 5 or (wd == 6 and h < 23)


def _normalize_bars(bars: list[dict]) -> tuple[list[dict], int, int]:
    ordered = sorted(bars, key=lambda bar: bar["timestamp_ms"])
    out, duplicates = [], 0
    for bar in ordered:
        if out and bar["timestamp_ms"] == out[-1]["timestamp_ms"]:
            duplicates += 1
            continue
        if (not all(isinstance(bar.get(key), (int, float)) and isfinite(bar[key]) for key in ("timestamp_ms", "open", "high", "low", "close"))
                or bar["high"] < max(bar["open"], bar["close"], bar["low"])
                or bar["low"] > min(bar["open"], bar["close"], bar["high"])):
            continue
        out.append(bar)
    reordered = sum(1 for i, bar in enumerate(bars[1:], 1) if bar["timestamp_ms"] < bars[i - 1]["timestamp_ms"])
    return out, duplicates, reordered


def _finish(tf: str, source: str, bars: list[dict], symbol: str = "XAUUSD", aggregation_source: str | None = None,
            missing_candle_count: int = 0) -> dict:
    bars, duplicates, reordered = _normalize_bars(bars)
    if not bars:
        raise RuntimeError(f"No valid, completed {tf} candles were returned.")
    minutes = TFS[tf][3]
    now = datetime.now(timezone.utc)
    age = max(0, int(now.timestamp() - bars[-1]["timestamp_ms"] / 1000))
    closed = market_closed(now, symbol)
    completed = [b for b in bars if b["timestamp_ms"] + minutes * 60_000 <= int(now.timestamp() * 1000)]
    if completed:
        bars = completed
        age = max(0, int(now.timestamp() - bars[-1]["timestamp_ms"] / 1000))
    if not bars:
        raise RuntimeError(f"No completed {tf} candles were returned.")
    step_ms = minutes * 60_000
    gaps = sum(max(0, round((current["timestamp_ms"] - previous["timestamp_ms"]) / step_ms) - 1)
               for previous, current in zip(bars, bars[1:])
               if step_ms < current["timestamp_ms"] - previous["timestamp_ms"] <= 24 * 60 * 60_000)
    missing_candle_count += gaps
    quality = "GOOD" if not missing_candle_count and not duplicates and not reordered else "DEGRADED"
    return {"symbol": symbol, "tf": tf, "source": source, "bars": bars, "last_bar_time": bars[-1]["time"], "last_bar_ms": bars[-1]["timestamp_ms"],
            "age_seconds": age, "fetched_at": now.isoformat(), "market_closed": closed,
            "is_stale": (age > max(300, minutes * 150)) and not closed, "price": bars[-1]["close"],
            "missing_candle_count": missing_candle_count, "historical_coverage": {"start_ms": bars[0]["timestamp_ms"], "end_ms": bars[-1]["timestamp_ms"]},
            "aggregation_source": aggregation_source, "data_quality_status": quality,
            "duplicate_candle_count": duplicates, "out_of_order_candle_count": reordered}


def aggregate_feed(feed: dict, tf: str, symbol: str) -> dict:
    source_tf = feed["tf"]
    source_minutes, target_minutes = TFS[source_tf][3], TFS[tf][3]
    if target_minutes % source_minutes:
        raise RuntimeError(f"Cannot aggregate {source_tf} candles into {tf}.")
    expected = 5 if tf == "W1" and symbols.profile(symbol)["weekend_closed"] else 7 if tf == "W1" else target_minutes // source_minutes
    buckets: dict[int, list[dict]] = {}
    target_ms = target_minutes * 60_000
    for bar in feed["bars"]:
        ts = bar["timestamp_ms"]
        if tf == "W1":
            dt = _dt(ts)
            start = dt.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=dt.weekday())
            bucket = int(start.timestamp() * 1000)
        else:
            bucket = ts // target_ms * target_ms
        buckets.setdefault(bucket, []).append(bar)
    out, missing_total = [], 0
    minimum = max(1, int(expected * SPEC["data_quality"]["aggregation_min_coverage"] + 0.999999))
    for bucket, group in sorted(buckets.items()):
        group.sort(key=lambda bar: bar["timestamp_ms"])
        if len(group) < minimum:
            continue
        missing = max(0, expected - len(group))
        missing_total += missing
        out.append({"time": datetime.fromtimestamp(bucket / 1000, timezone.utc).isoformat(), "timestamp_ms": bucket,
                    "open": group[0]["open"], "high": max(bar["high"] for bar in group),
                    "low": min(bar["low"] for bar in group), "close": group[-1]["close"],
                    "volume": sum(_num(bar.get("volume")) or 0 for bar in group)})
    if not out:
        raise RuntimeError(f"Insufficient completed {source_tf} history to aggregate {tf}.")
    return _finish(tf, f"{feed['source']} · aggregated", out, symbol, source_tf, missing_total)


async def _twelvedata(tf: str, client: httpx.AsyncClient, symbol: str = "XAUUSD") -> dict:
    td_symbol = TWELVEDATA_SYMBOL if symbol == "XAUUSD" else symbols.profile(symbol)["td"]
    interval, _, _, _, _, size = TFS[tf]
    r = await client.get("https://api.twelvedata.com/time_series", params={
        "symbol": td_symbol, "interval": interval, "outputsize": size, "order": "ASC", "timezone": "UTC", "apikey": TWELVEDATA_API_KEY})
    data = r.json()
    if r.status_code >= 400 or data.get("status") == "error" or "values" not in data:
        raise RuntimeError(f"Twelve Data: {str(data.get('message') or r.text)[:200]}")
    bars = []
    for v in data["values"]:
        try:
            dt = datetime.strptime(v["datetime"][:19], "%Y-%m-%d %H:%M:%S" if len(v["datetime"]) > 10 else "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        o, h, l, c = (_num(v.get(k)) for k in ("open", "high", "low", "close"))
        if None in (o, h, l, c) or h < l:
            continue
        bars.append({"time": dt.isoformat(), "timestamp_ms": int(dt.timestamp() * 1000), "open": o, "high": h, "low": l, "close": c, "volume": _num(v.get("volume")) or 0})
    if len(bars) < 30:
        raise RuntimeError("Twelve Data returned too few candles.")
    return _finish(tf, f"Twelve Data · {td_symbol}", bars, symbol)


async def _yahoo(tf: str, client: httpx.AsyncClient, symbol: str = "XAUUSD") -> dict:
    ysym = symbols.profile(symbol)["yahoo"]
    _, yint, yrange, _, _, size = TFS[tf]
    r = await client.get("https://query1.finance.yahoo.com/v8/finance/chart/" + quote(ysym, safe=""), params={"range": yrange, "interval": yint, "includePrePost": "true"})
    if r.status_code >= 400:
        raise RuntimeError(f"Yahoo Finance {r.status_code}")
    res = ((r.json().get("chart") or {}).get("result") or [None])[0]
    if not res:
        raise RuntimeError(f"Yahoo Finance returned no {symbol} data.")
    q = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    bars = []
    for i, ts in enumerate(res.get("timestamp") or []):
        try:
            o, h, l, c = (_num(q[k][i]) for k in ("open", "high", "low", "close"))
        except (KeyError, IndexError):
            continue
        if None in (o, h, l, c) or h < l:
            continue
        bars.append({"time": datetime.fromtimestamp(ts, timezone.utc).isoformat(), "timestamp_ms": int(ts) * 1000, "open": o, "high": h, "low": l, "close": c, "volume": 0})
    bars = bars[-size:]
    if len(bars) < 30:
        raise RuntimeError("Yahoo Finance returned too few candles.")
    return _finish(tf, f"Yahoo Finance · {ysym} (fallback)", bars, symbol)


async def fetch_candles(tf: str, force: bool = False, symbol: str = "XAUUSD") -> dict:
    symbol = symbols.normalize(symbol)
    if tf not in TFS:
        raise ValueError("Unsupported timeframe. Use M1, M5, M15, H1, H4, D1 or W1.")
    key = f"{symbol}:{tf}"
    hit = _CACHE.get(key)
    if hit and not force and time.monotonic() - hit[0] < TFS[tf][4]:
        return hit[1]
    errors: list[str] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(14.0, connect=6.0), headers=UA, follow_redirects=True) as client:
        providers = ((_twelvedata,) if TWELVEDATA_API_KEY else ()) + (() if tf == "H4" else (_yahoo,))
        for provider in providers:
            try:
                result = await provider(tf, client, symbol)
                if errors:
                    result["fallback_reason"] = errors[0]
                _CACHE[key] = (time.monotonic(), result)
                return result
            except Exception as exc:  # try the next provider
                errors.append(str(exc)[:220])
        source_tf = AGGREGATE_FROM.get(tf)
        if source_tf:
            try:
                base = await fetch_candles(source_tf, force=force, symbol=symbol)
                result = aggregate_feed(base, tf, symbol)
                if errors:
                    result["fallback_reason"] = errors[0]
                _CACHE[key] = (time.monotonic(), result)
                return result
            except Exception as exc:
                errors.append(str(exc)[:220])
    if hit:  # serve the last good copy rather than nothing, flagged stale by its own age
        stale = dict(hit[1])
        stale["fallback_reason"] = "; ".join(errors)
        age_seconds = max(0, int(datetime.now(timezone.utc).timestamp() - stale["last_bar_ms"] / 1000))
        stale["age_seconds"] = age_seconds
        stale["is_stale"] = age_seconds > max(300, TFS[tf][3] * 150) and not market_closed(symbol=symbol)
        return stale
    raise RuntimeError("No candle provider available: " + " | ".join(errors))


async def fetch_many(tfs: list[str], symbol: str = "XAUUSD") -> dict[str, dict]:
    out: dict[str, dict] = {}
    for tf in dict.fromkeys(tfs):
        out[tf] = await fetch_candles(tf, symbol=symbol)
    return out
