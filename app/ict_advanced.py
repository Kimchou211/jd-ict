"""Shared-spec advanced ICT measurements used by the Python engine."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SPEC = json.loads((Path(__file__).resolve().parent.parent / "shared" / "ict-engine-spec.json").read_text(encoding="utf-8"))
_NY = ZoneInfo(SPEC["sessions"]["timezone"])


def session_info(timestamp_ms: int) -> dict:
    local = datetime.fromtimestamp(timestamp_ms / 1000, tz=_NY)
    minute = local.hour * 60 + local.minute

    def contains(window: dict) -> bool:
        start_h, start_m = map(int, window["start"].split(":"))
        end_h, end_m = map(int, window["end"].split(":"))
        start, end = start_h * 60 + start_m, end_h * 60 + end_m
        return start <= minute < end if start < end else minute >= start or minute < end

    windows = SPEC["sessions"]
    if contains(windows["asia"]):
        name, killzone = "ASIA", False
    elif contains(windows["london_killzone"]):
        name, killzone = "LONDON_KZ", True
    elif contains(windows["new_york_killzone"]):
        name, killzone = "NY_KZ", True
    elif contains(windows["london"]):
        name, killzone = "LONDON", False
    elif contains(windows["new_york"]):
        name, killzone = "NEW_YORK", False
    else:
        name, killzone = "OFF_HOURS", False
    return {
        "name": name,
        "in_killzone": killzone,
        "utc_hour": round(datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).hour
                          + datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).minute / 60, 2),
        "local_time": local.strftime("%H:%M"),
        "timezone": SPEC["sessions"]["timezone"],
        "utc_offset_minutes": int(local.utcoffset().total_seconds() / 60),
    }


def new_york_datetime(timestamp_ms: int) -> datetime:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=_NY)


def detect_displacement(bars: list[dict], atr: float, index: int | None = None) -> dict:
    thresholds = SPEC["displacement"]
    if not bars or atr <= 0:
        return {"direction": None, "classification": "WEAK", "body_atr": 0.0, "range_atr": 0.0,
                "close_location": 0.5, "wick_body_ratio": 0.0, "consecutive_directional_closes": 0, "reasons": ["ATR or candle data unavailable"]}
    end = len(bars) - 1 if index is None else index
    candle = bars[end]
    body = abs(candle["close"] - candle["open"])
    span = candle["high"] - candle["low"]
    direction = "bull" if candle["close"] > candle["open"] else "bear" if candle["close"] < candle["open"] else None
    body_atr = body / atr
    range_atr = span / atr
    close_location = 0.5 if span <= 0 else (candle["close"] - candle["low"]) / span
    wick_body_ratio = max(0.0, span - body) / max(body, 1e-12)
    run = 0
    for bar in reversed(bars[:end + 1]):
        if direction == "bull" and bar["close"] > bar["open"] or direction == "bear" and bar["close"] < bar["open"]:
            run += 1
        else:
            break
    favorable_close = close_location if direction == "bull" else 1 - close_location if direction == "bear" else 0
    if (body_atr >= thresholds["extreme_body_atr"] and range_atr >= thresholds["extreme_range_atr"]
            and favorable_close >= thresholds["extreme_close_location"] and run >= thresholds["extreme_consecutive_closes"]):
        classification = "EXTREME"
    elif (body_atr >= thresholds["strong_body_atr"] and range_atr >= thresholds["strong_range_atr"]
          and favorable_close >= thresholds["strong_close_location"]):
        classification = "STRONG"
    elif (body_atr >= thresholds["moderate_body_atr"] and range_atr >= thresholds["moderate_range_atr"]
          and favorable_close >= thresholds["moderate_close_location"]):
        classification = "MODERATE"
    else:
        classification = "WEAK"
    reasons = [f"body/ATR={body_atr:.3f}", f"range/ATR={range_atr:.3f}", f"close_location={close_location:.3f}"]
    if run >= 2:
        reasons.append(f"{run} consecutive directional closes")
    return {"direction": direction, "classification": classification, "body_atr": body_atr, "range_atr": range_atr,
            "close_location": close_location, "wick_body_ratio": wick_body_ratio,
            "consecutive_directional_closes": run, "reasons": reasons}


def detect_cisd(bars: list[dict], atr: float) -> dict:
    if len(bars) < 2:
        return {"status": "unavailable", "direction": None, "reference_open": None, "confirmation_price": None,
                "sequence": [], "displacement": "WEAK"}
    i = len(bars) - 1
    current = bars[i]
    direction = "bull" if current["close"] > current["open"] else "bear" if current["close"] < current["open"] else None
    opposing = (lambda b: b["close"] < b["open"]) if direction == "bull" else (lambda b: b["close"] > b["open"])
    if direction is None:
        return {"status": "pending", "direction": None, "reference_open": None, "confirmation_price": current["close"],
                "sequence": [], "displacement": "WEAK"}
    start = i
    limit = SPEC["indicators"]["cisd_max_opposing_candles"]
    while start > 0 and i - start < limit and opposing(bars[start - 1]):
        start -= 1
    if start == i:
        return {"status": "pending", "direction": direction, "reference_open": None, "confirmation_price": current["close"],
                "sequence": [], "displacement": detect_displacement(bars, atr)["classification"]}
    reference = bars[start]["open"]
    displacement = detect_displacement(bars, atr)
    confirmed = current["close"] > reference if direction == "bull" else current["close"] < reference
    confirmed = confirmed and displacement["classification"] in ("MODERATE", "STRONG", "EXTREME")
    return {"status": "confirmed" if confirmed else "pending", "direction": direction, "reference_open": reference,
            "confirmation_price": current["close"], "ts": current["timestamp_ms"],
            "sequence": list(range(start, i)), "displacement": displacement["classification"]}


def classify_regime(bars: list[dict], trend: str | None, atr: float) -> dict:
    minimum = SPEC["data_quality"]["minimum_bars_for_regime"]
    if len(bars) < minimum or atr <= 0:
        return {"regime": "UNKNOWN", "confidence": 0, "start_ts": None, "duration": 0, "reason": "Insufficient valid candles"}
    recent = bars[-10:]
    directional = [1 if b["close"] > b["open"] else -1 if b["close"] < b["open"] else 0 for b in recent]
    consistency = max(directional.count(1), directional.count(-1)) / len(directional)
    true_ranges = [max(b["high"] - b["low"], abs(b["high"] - bars[i - 1]["close"]), abs(b["low"] - bars[i - 1]["close"]))
                   for i, b in enumerate(bars) if i > 0]
    recent_atr = sum(true_ranges[-5:]) / min(5, len(true_ranges))
    baseline = sum(true_ranges[-20:]) / min(20, len(true_ranges))
    ratio = recent_atr / baseline if baseline else 1.0
    if ratio >= 1.5:
        regime, reason = "HIGH_VOLATILITY", "Recent true range expanded to at least 1.5x its 20-bar baseline"
    elif ratio <= 0.65:
        regime, reason = "LOW_VOLATILITY", "Recent true range contracted to at most 0.65x its 20-bar baseline"
    elif trend == "bull" and consistency >= 0.6:
        regime, reason = "TRENDING_BULLISH", "Confirmed bullish structure with consistent directional closes"
    elif trend == "bear" and consistency >= 0.6:
        regime, reason = "TRENDING_BEARISH", "Confirmed bearish structure with consistent directional closes"
    elif consistency <= 0.5:
        regime, reason = "RANGING", "No confirmed directional structure and mixed recent closes"
    else:
        regime, reason = "TRANSITIONAL", "Structure and recent candle delivery are not aligned"
    confidence = min(100, round(50 + abs(consistency - 0.5) * 100 + abs(ratio - 1) * 20))
    return {"regime": regime, "confidence": confidence, "start_ts": recent[0]["timestamp_ms"], "duration": len(recent),
            "reason": reason, "atr_expansion_ratio": ratio, "directional_consistency": consistency}


def advanced_pd_arrays(bars: list[dict], fvgs: list[dict], atr: float) -> dict:
    bprs = []
    for i, first in enumerate(fvgs):
        for second in fvgs[i + 1:]:
            if first["dir"] == second["dir"]:
                continue
            low, high = max(first["low"], second["low"]), min(first["high"], second["high"])
            if low >= high:
                continue
            bprs.append({"bull_fvg_i": first["i"] if first["dir"] == "bull" else second["i"],
                         "bear_fvg_i": first["i"] if first["dir"] == "bear" else second["i"],
                         "low": low, "high": high, "midpoint": (low + high) / 2, "width": high - low,
                         "size_atr": (high - low) / atr if atr else 0,
                         "formed_i": max(first["i"], second["i"]), "mitigated": False})
    for bpr in bprs:
        for bar in bars[bpr["formed_i"] + 2:]:
            if bar["low"] <= bpr["high"] and bar["high"] >= bpr["low"]:
                bpr["mitigated"] = True
                break
    if not bars or atr <= 0:
        return {"ifvgs": [], "bprs": bprs, "ote": None}
    ifvgs = []
    for fvg in fvgs:
        if fvg.get("end_i") is None:
            continue
        direction = "bear" if fvg["dir"] == "bull" else "bull"
        for i in range(fvg["end_i"] + 1, len(bars)):
            bar = bars[i]
            if bar["low"] <= fvg["high"] and bar["high"] >= fvg["low"]:
                confirms = bar["close"] < (fvg["low"] + fvg["high"]) / 2 if direction == "bear" else bar["close"] > (fvg["low"] + fvg["high"]) / 2
                if confirms:
                    ifvgs.append({"original_fvg_i": fvg["i"], "direction": direction, "low": fvg["low"], "high": fvg["high"],
                                  "reversal_i": fvg["end_i"], "retest_i": i, "status": "confirmed"})
                break
    return {"ifvgs": ifvgs, "bprs": bprs}


def enrich_fvgs(bars: list[dict], fvgs: list[dict], atr: float) -> None:
    for fvg in fvgs:
        width = fvg["high"] - fvg["low"]
        ce = (fvg["low"] + fvg["high"]) / 2
        touched = 0
        mitigation = 0.0
        first_touch = None
        lifecycle = "UNTOUCHED"
        for i in range(fvg["i"] + 2, len(bars)):
            bar = bars[i]
            if bar["low"] <= fvg["high"] and bar["high"] >= fvg["low"]:
                touched += 1
                first_touch = i if first_touch is None else first_touch
                progress = ((fvg["high"] - bar["low"]) if fvg["dir"] == "bull" else (bar["high"] - fvg["low"])) / width if width else 1
                mitigation = max(mitigation, min(1.0, max(0.0, progress)))
                if mitigation >= 1:
                    lifecycle = "FULLY_FILLED"
                elif bar["low"] <= ce <= bar["high"]:
                    lifecycle = "CONSEQUENT_ENCROACHMENT"
                else:
                    lifecycle = "PARTIALLY_MITIGATED"
            if (fvg["dir"] == "bull" and bar["close"] < fvg["low"]) or (fvg["dir"] == "bear" and bar["close"] > fvg["high"]):
                lifecycle = "INVALIDATED"
                fvg["invalidation_i"] = i
                break
        fvg.update(ce=ce, size=width, size_atr=width / atr if atr else 0, first_touch_i=first_touch,
                   retest_count=touched, mitigation_pct=mitigation * 100, lifecycle=lifecycle)


def validated_ote(bars: list[dict], event: dict | None, atr: float) -> dict | None:
    if not event or atr <= 0:
        return None
    event_bars = bars[:event["i"] + 1]
    displacement = detect_displacement(event_bars, _atr(event_bars))
    if displacement["classification"] not in ("MODERATE", "STRONG", "EXTREME"):
        return None
    start, end = event["leg_start_i"], event["i"]
    leg = bars[start:end + 1]
    if len(leg) < 2:
        return None
    low, high = min(bar["low"] for bar in leg), max(bar["high"] for bar in leg)
    span = high - low
    if span <= 0:
        return None
    levels = SPEC["fvg"]["ote_levels"]
    if event["dir"] == "bull":
        zone = (high - levels[-1] * span, high - levels[0] * span)
        retracement = (high - bars[-1]["close"]) / span * 100
    else:
        zone = (low + levels[0] * span, low + levels[-1] * span)
        retracement = (bars[-1]["close"] - low) / span * 100
    return {"low": zone[0], "high": zone[1], "midpoint": sum(zone) / 2,
            "anchor_start_i": start, "anchor_end_i": end, "event_i": event["i"],
            "retracement_pct": retracement, "displacement": displacement["classification"], "valid": True}


def _atr(bars: list[dict], period: int = 14) -> float:
    if len(bars) < 2:
        return 0.0
    ranges = []
    for i in range(1, len(bars)):
        current, previous = bars[i], bars[i - 1]
        ranges.append(max(current["high"] - current["low"], abs(current["high"] - previous["close"]),
                          abs(current["low"] - previous["close"])))
    recent = ranges[-period:]
    return sum(recent) / len(recent) if recent else 0.0


def data_quality(bars: list[dict], timeframe: str) -> dict:
    minutes = SPEC["timeframes_minutes"][timeframe]
    step_ms = minutes * 60_000
    gaps = 0
    for previous, current in zip(bars, bars[1:]):
        difference = current["timestamp_ms"] - previous["timestamp_ms"]
        if difference <= step_ms:
            continue
        missing = max(0, round(difference / step_ms) - 1)
        if difference <= 24 * 60 * 60_000:
            gaps += missing
    score = max(0, 100 - gaps * 10)
    return {"score": score, "missing_intervals": gaps,
            "status": "GOOD" if score >= 90 else "DEGRADED" if score >= 70 else "POOR",
            "last_candle_complete": True}
