"""Candle feed for the ICT terminal: Twelve Data first (if a key is set), Yahoo Finance as fallback.

Every result carries the provider, the last-bar time and a stale / market-closed flag, so the
UI never presents old data as live. Results are cached briefly to protect free-tier rate limits.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from math import isfinite
from typing import Any

import httpx

from urllib.parse import quote

from . import symbols
from .config import TWELVEDATA_API_KEY, TWELVEDATA_SYMBOL

# tf -> (twelvedata interval, yahoo interval, yahoo range, minutes, cache seconds, bars to request)
TFS: dict[str, tuple[str, str, str, int, int, int]] = {
    "M1": ("1min", "1m", "5d", 1, 20, 500),
    "M5": ("5min", "5m", "5d", 5, 25, 500),
    "M15": ("15min", "15m", "1mo", 15, 60, 500),
    "H1": ("1h", "60m", "3mo", 60, 180, 500),
}
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


def _finish(tf: str, source: str, bars: list[dict], symbol: str = "XAUUSD") -> dict:
    minutes = TFS[tf][3]
    now = datetime.now(timezone.utc)
    age = max(0, int(now.timestamp() - bars[-1]["timestamp_ms"] / 1000))
    closed = market_closed(now, symbol)
    return {"symbol": symbol, "tf": tf, "source": source, "bars": bars, "last_bar_time": bars[-1]["time"], "last_bar_ms": bars[-1]["timestamp_ms"],
            "age_seconds": age, "fetched_at": now.isoformat(), "market_closed": closed,
            "is_stale": (age > max(300, minutes * 150)) and not closed, "price": bars[-1]["close"]}


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
        raise ValueError("Unsupported timeframe. Use M1, M5, M15 or H1.")
    key = f"{symbol}:{tf}"
    hit = _CACHE.get(key)
    if hit and not force and time.monotonic() - hit[0] < TFS[tf][4]:
        return hit[1]
    errors: list[str] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(14.0, connect=6.0), headers=UA, follow_redirects=True) as client:
        for provider in ((_twelvedata,) if TWELVEDATA_API_KEY else ()) + (_yahoo,):
            try:
                result = await provider(tf, client, symbol)
                if errors:
                    result["fallback_reason"] = errors[0]
                _CACHE[key] = (time.monotonic(), result)
                return result
            except Exception as exc:  # try the next provider
                errors.append(str(exc)[:220])
    if hit:  # serve the last good copy rather than nothing, flagged stale by its own age
        stale = dict(hit[1])
        stale["fallback_reason"] = "; ".join(errors)
        return stale
    raise RuntimeError("No candle provider available: " + " | ".join(errors))


async def fetch_many(tfs: list[str], symbol: str = "XAUUSD") -> dict[str, dict]:
    out: dict[str, dict] = {}
    for tf in dict.fromkeys(tfs):
        out[tf] = await fetch_candles(tf, symbol=symbol)
    return out
