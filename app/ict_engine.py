"""Deterministic ICT engine for XAUUSD.

Everything here is computed from candles only (no AI, no screenshots):
swings, BOS/MSS, liquidity (equal highs/lows, previous-day, Asia range) and sweeps, FVG,
order blocks, premium/discount, CRT range, sessions/kill zones, multi-timeframe bias,
a scored trade plan (entry / stop / TP1 / TP2) and the drawing primitives the chart renders.

Bars are dicts with timestamp_ms, open, high, low, close. Output prices are real candle prices.
This is market analysis, not a guarantee: a score is confluence, never a win probability.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import isfinite
from typing import Any

from . import symbols
from .config import ICT_MIN_SCORE
from .ict_advanced import (
    SPEC,
    advanced_pd_arrays,
    classify_regime,
    data_quality,
    detect_cisd,
    detect_displacement,
    enrich_fvgs,
    new_york_datetime,
    session_info as _session_info,
    validated_ote,
)

TF_MIN = SPEC["timeframes_minutes"]
LOOKBACK = SPEC["setup_lookback_bars"]
VALID_HOURS = SPEC["setup_validity_hours"]


# ----------------------------------------------------------------------------- basics
def calc_atr(bars: list[dict], period: int = SPEC["indicators"]["atr_period"]) -> float:
    if len(bars) < 2:
        return 0.0
    trs = []
    for i in range(1, len(bars)):
        h, l, pc = bars[i]["high"], bars[i]["low"], bars[i - 1]["close"]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    tail = trs[-period:]
    return sum(tail) / len(tail) if tail else 0.0


def _dt(ts_ms: int) -> datetime:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)


def session_info(ts_ms: int) -> dict:
    return _session_info(ts_ms)


# ----------------------------------------------------------------------------- structure
def find_swings(
    bars: list[dict],
    left: int = SPEC["indicators"]["swing_left"],
    right: int = SPEC["indicators"]["swing_right"],
) -> list[dict]:
    out = []
    n = len(bars)
    for i in range(left, n - right):
        h, l = bars[i]["high"], bars[i]["low"]
        if all(h > bars[j]["high"] for j in range(i - left, i)) and all(h >= bars[j]["high"] for j in range(i + 1, i + right + 1)):
            out.append({"i": i, "type": "high", "price": h, "ts": bars[i]["timestamp_ms"], "confirmed_at": i + right})
        if all(l < bars[j]["low"] for j in range(i - left, i)) and all(l <= bars[j]["low"] for j in range(i + 1, i + right + 1)):
            out.append({"i": i, "type": "low", "price": l, "ts": bars[i]["timestamp_ms"], "confirmed_at": i + right})
    return sorted(out, key=lambda s: s["i"])


def market_structure(bars: list[dict], swings: list[dict]) -> dict:
    """BOS = break in trend direction, MSS (CHoCH) = first close through the opposite swing. Closes only."""
    by_conf: dict[int, list[dict]] = {}
    for s in swings:
        by_conf.setdefault(s["confirmed_at"], []).append(s)
    events: list[dict] = []
    trend = None
    hi = lo = None
    for i, b in enumerate(bars):
        for s in by_conf.get(i, ()):
            if s["type"] == "high":
                hi = s
            else:
                lo = s
        c = b["close"]
        if hi is not None and c > hi["price"]:
            start = min(range(hi["i"], i + 1), key=lambda k: bars[k]["low"])
            events.append({"i": i, "ts": b["timestamp_ms"], "kind": "BOS" if trend in (None, "bull") else "MSS", "dir": "bull",
                           "level": hi["price"], "origin_i": hi["i"], "origin_ts": hi["ts"], "leg_start_i": start})
            trend, hi = "bull", None
        elif lo is not None and c < lo["price"]:
            start = max(range(lo["i"], i + 1), key=lambda k: bars[k]["high"])
            events.append({"i": i, "ts": b["timestamp_ms"], "kind": "BOS" if trend in (None, "bear") else "MSS", "dir": "bear",
                           "level": lo["price"], "origin_i": lo["i"], "origin_ts": lo["ts"], "leg_start_i": start})
            trend, lo = "bear", None
    return {"trend": trend, "events": events}


def layered_structure(bars: list[dict]) -> dict:
    layers = {}
    for name, strength in (("internal", SPEC["indicators"]["internal_swing_strength"]),
                           ("external", SPEC["indicators"]["external_swing_strength"])):
        swings = find_swings(bars, strength, strength)
        structure = market_structure(bars, swings)
        layers[name] = {
            "trend": structure["trend"],
            "swings": swings[-8:],
            "events": [{**event, "label": "CHoCH" if event["kind"] == "MSS" else "BOS"}
                       for event in structure["events"][-8:]],
        }
    return layers


# ----------------------------------------------------------------------------- FVG / OB
def find_fvgs(bars: list[dict], atr: float) -> list[dict]:
    min_gap = max(SPEC["fvg"]["min_size_atr"] * atr, symbols.profile()["gap_floor"])
    out = []
    for i in range(1, len(bars) - 1):
        p, nx = bars[i - 1], bars[i + 1]
        if nx["low"] - p["high"] >= min_gap:
            out.append({"dir": "bull", "low": p["high"], "high": nx["low"], "i": i, "ts": bars[i]["timestamp_ms"]})
        elif p["low"] - nx["high"] >= min_gap:
            out.append({"dir": "bear", "low": nx["high"], "high": p["low"], "i": i, "ts": bars[i]["timestamp_ms"]})
    for f in out:
        f["end_i"], f["touched"] = None, False
        for j in range(f["i"] + 2, len(bars)):
            b = bars[j]
            if b["low"] <= f["high"] and b["high"] >= f["low"]:
                f["touched"] = True
            # inversion: close fully through the gap kills it
            if (f["dir"] == "bull" and b["close"] < f["low"]) or (f["dir"] == "bear" and b["close"] > f["high"]):
                f["end_i"] = j
                break
    return out


def order_block_for(bars: list[dict], event: dict) -> dict | None:
    """Last opposite-colour candle at the start of the displacement leg that produced the break."""
    s = event["leg_start_i"]
    want_down = event["dir"] == "bull"            # bullish break -> last bearish candle
    order = [s] + [s - k for k in (1, 2, 3)] + [s + k for k in (1, 2, 3)]
    for j in order:
        if 0 <= j < len(bars) and j < event["i"]:
            b = bars[j]
            if (b["close"] < b["open"]) == want_down and b["close"] != b["open"]:
                if want_down:
                    low, high = b["low"], b["open"]
                else:
                    low, high = b["open"], b["high"]
                ob = {"dir": event["dir"], "low": low, "high": high, "i": j, "ts": b["timestamp_ms"], "event_i": event["i"], "end_i": None, "touched": False}
                for k in range(event["i"] + 1, len(bars)):
                    bb = bars[k]
                    if bb["low"] <= high and bb["high"] >= low:
                        ob["touched"] = True
                    if (ob["dir"] == "bull" and bb["close"] < low) or (ob["dir"] == "bear" and bb["close"] > high):
                        ob["end_i"] = k
                        break
                return ob
    return None


# ----------------------------------------------------------------------------- liquidity
def _cluster(swings: list[dict], tol: float) -> list[list[dict]]:
    groups: list[list[dict]] = []
    for s in sorted(swings, key=lambda x: x["price"]):
        if groups and s["price"] - groups[-1][-1]["price"] <= tol:
            groups[-1].append(s)
        else:
            groups.append([s])
    return [g for g in groups if len(g) >= 2]


def _day_levels(bars: list[dict], last_ts: int, minimum_bars: int = 18) -> dict:
    """Previous UTC day high/low from the given bars."""
    today = _dt(last_ts).date()
    days: dict[Any, list[dict]] = {}
    for b in bars:
        days.setdefault(_dt(b["timestamp_ms"]).date(), []).append(b)
    prev_days = sorted(d for d in days if d < today)
    if not prev_days:
        return {}
    pd_bars = days[prev_days[-1]]
    if len(pd_bars) < minimum_bars:
        return {}
    start = _dt(pd_bars[0]["timestamp_ms"]).replace(hour=0, minute=0, second=0, microsecond=0)
    return {"high": max(b["high"] for b in pd_bars), "low": min(b["low"] for b in pd_bars), "ts": int(start.timestamp() * 1000)}


def _previous_period_levels(bars: list[dict], last_ts: int, period: str, weekend_closed: bool) -> dict:
    current = _dt(last_ts)
    if period == "week":
        end = current.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=current.weekday())
        start = end - timedelta(days=7)
        expected_days = 5 if weekend_closed else 7
    else:
        end = current.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        previous_month_last = end - timedelta(days=1)
        start = previous_month_last.replace(day=1)
        trading_days = sum(1 for offset in range((end.date() - start.date()).days)
                           if not weekend_closed or (start + timedelta(days=offset)).weekday() < 5)
        expected_days = trading_days
    selected = [bar for bar in bars if start.timestamp() * 1000 <= bar["timestamp_ms"] < end.timestamp() * 1000]
    by_day: dict[Any, list[dict]] = {}
    for bar in selected:
        by_day.setdefault(_dt(bar["timestamp_ms"]).date(), []).append(bar)
    daily_minimum = 18 if weekend_closed else 20
    valid_days = [items for items in by_day.values() if len(items) >= daily_minimum]
    if len(valid_days) < int(expected_days * SPEC["data_quality"]["aggregation_min_coverage"] + 0.999999):
        return {}
    return {"high": max(bar["high"] for items in valid_days for bar in items),
            "low": min(bar["low"] for items in valid_days for bar in items), "ts": int(start.timestamp() * 1000),
            "end_ts": int(end.timestamp() * 1000)}


def _asia_range(bars: list[dict], last_ts: int) -> dict:
    previous_date = new_york_datetime(last_ts).date() - timedelta(days=1)
    sel = [b for b in bars if new_york_datetime(b["timestamp_ms"]).date() == previous_date
           and new_york_datetime(b["timestamp_ms"]).hour >= 20]
    if len(sel) < 3:
        return {}
    step_ms = bars[1]["timestamp_ms"] - bars[0]["timestamp_ms"] if len(bars) > 1 else 300_000
    return {"high": max(b["high"] for b in sel), "low": min(b["low"] for b in sel), "ts": sel[0]["timestamp_ms"],
            "end_ts": sel[-1]["timestamp_ms"] + step_ms}


def _first_index_at_or_after(bars: list[dict], ts: int) -> int:
    for i, b in enumerate(bars):
        if b["timestamp_ms"] >= ts:
            return i
    return len(bars) - 1


def build_liquidity(bars: list[dict], swings: list[dict], atr: float, htf_bars: list[dict] | None, crt: dict) -> tuple[list[dict], list[dict]]:
    n = len(bars)
    tol = max(0.25 * atr, symbols.profile()["tol_floor"])
    recent = [s for s in swings if s["i"] >= n - 160]
    levels: list[dict] = []
    for typ, kind_eq, side in (("high", "EQH", "buy"), ("low", "EQL", "sell")):
        pts = [s for s in recent if s["type"] == typ]
        for g in _cluster(pts, tol):
            price = max(s["price"] for s in g) if typ == "high" else min(s["price"] for s in g)
            levels.append({"kind": kind_eq, "side": side, "price": price, "i": max(s["i"] for s in g) + 3, "ts": g[0]["ts"]})
        used = {id(s) for g in _cluster(pts, tol) for s in g}
        for s in pts:
            if id(s) not in used:
                levels.append({"kind": "SWH" if typ == "high" else "SWL", "side": side, "price": s["price"], "i": s["i"] + 3, "ts": s["ts"]})
    last_ts = bars[-1]["timestamp_ms"]
    reference_bars = htf_bars or bars
    closed_market = symbols.profile()["weekend_closed"]
    day = _day_levels(reference_bars, last_ts, 18 if closed_market else 20)
    if day:
        i0 = _first_index_at_or_after(bars, day["ts"] + 86_400_000)
        levels.append({"kind": "PDH", "side": "buy", "price": day["high"], "i": i0, "ts": day["ts"]})
        levels.append({"kind": "PDL", "side": "sell", "price": day["low"], "i": i0, "ts": day["ts"]})
    for period, high_kind, low_kind in (("week", "PWH", "PWL"), ("month", "PMH", "PML")):
        levels_for_period = _previous_period_levels(reference_bars, last_ts, period, closed_market)
        if levels_for_period:
            i0 = _first_index_at_or_after(bars, levels_for_period["end_ts"])
            levels.append({"kind": high_kind, "side": "buy", "price": levels_for_period["high"], "i": i0, "ts": levels_for_period["ts"]})
            levels.append({"kind": low_kind, "side": "sell", "price": levels_for_period["low"], "i": i0, "ts": levels_for_period["ts"]})
    asia = _asia_range(bars, last_ts)
    if asia:
        i0 = min(n - 1, _first_index_at_or_after(bars, asia["end_ts"]))
        levels.append({"kind": "ASIA_H", "side": "buy", "price": asia["high"], "i": i0, "ts": asia["ts"]})
        levels.append({"kind": "ASIA_L", "side": "sell", "price": asia["low"], "i": i0, "ts": asia["ts"]})
    if crt.get("high") is not None:
        i0 = _first_index_at_or_after(bars, crt["ts2"])
        levels.append({"kind": "CRT_H", "side": "buy", "price": crt["high"], "i": i0, "ts": crt["ts1"]})
        levels.append({"kind": "CRT_L", "side": "sell", "price": crt["low"], "i": i0, "ts": crt["ts1"]})
    # sweep status
    sweeps: list[dict] = []
    for lv in levels:
        lv["status"], lv["swept_i"] = "active", None
        start = max(0, min(n - 1, lv["i"] + 1))
        for j in range(start, n):
            b = bars[j]
            hit = b["high"] > lv["price"] if lv["side"] == "buy" else b["low"] < lv["price"]
            if not hit:
                continue
            closes_back = b["close"] < lv["price"] if lv["side"] == "buy" else b["close"] > lv["price"]
            confirm = j if closes_back else None
            if confirm is None:
                for k in range(j + 1, min(n, j + 3)):
                    if (bars[k]["close"] < lv["price"]) if lv["side"] == "buy" else (bars[k]["close"] > lv["price"]):
                        confirm = k
                        break
            if confirm is not None:
                lv["status"], lv["swept_i"] = "swept", j
                extreme = max(bars[x]["high"] for x in range(j, confirm + 1)) if lv["side"] == "buy" else min(bars[x]["low"] for x in range(j, confirm + 1))
                sweeps.append({"i": j, "confirm_i": confirm, "side": lv["side"], "kind": lv["kind"], "level": lv["price"], "extreme": extreme, "ts": bars[j]["timestamp_ms"]})
            else:
                lv["status"], lv["swept_i"] = "broken", j
            break
    sweeps.sort(key=lambda s: s["i"])
    # keep one sweep per (bar, side): the most significant level kind
    rank = {"PMH": 7, "PML": 7, "PWH": 6, "PWL": 6, "PDH": 5, "PDL": 5,
            "ASIA_H": 4, "ASIA_L": 4, "CRT_H": 4, "CRT_L": 4, "EQH": 3, "EQL": 3, "SWH": 1, "SWL": 1}
    best: dict[tuple, dict] = {}
    for s in sweeps:
        key = (s["i"], s["side"])
        if key not in best or rank[s["kind"]] > rank[best[key]["kind"]]:
            best[key] = s
    return levels, sorted(best.values(), key=lambda s: s["i"])


# ----------------------------------------------------------------------------- range / CRT / bias
def premium_discount(bars: list[dict], price: float, window: int = 100) -> dict:
    seg = bars[-window:]
    hi, lo = max(b["high"] for b in seg), min(b["low"] for b in seg)
    eq = (hi + lo) / 2
    pct = 0.0 if hi == lo else (price - lo) / (hi - lo) * 100
    return {"high": hi, "low": lo, "eq": eq, "pct": round(pct, 1), "zone": "PREMIUM" if price > eq else "DISCOUNT",
            "ts1": seg[0]["timestamp_ms"], "ts2": seg[-1]["timestamp_ms"]}


def crt_range(htf: list[dict] | None) -> dict:
    """CRT: previous closed HTF candle = range. A wick beyond one side that closes back inside = manipulation."""
    if not htf or len(htf) < 3:
        return {"state": "unavailable", "dir": None, "high": None, "low": None}
    c1, c2 = htf[-2], htf[-1]
    out = {"high": c1["high"], "low": c1["low"], "ts1": c1["timestamp_ms"], "ts2": c2["timestamp_ms"], "state": "inside", "dir": None}
    if c2["high"] > c1["high"] and c2["close"] <= c1["high"]:
        out.update(state="swept_high", dir="bear")
    elif c2["low"] < c1["low"] and c2["close"] >= c1["low"]:
        out.update(state="swept_low", dir="bull")
    elif c2["close"] > c1["high"]:
        out.update(state="expansion_up")
    elif c2["close"] < c1["low"]:
        out.update(state="expansion_down")
    return out


def _dir_num(trend: str | None) -> int:
    return {"bull": 1, "bear": -1}.get(trend or "", 0)


def mtf_bias(structure: dict[str, dict], pd_htf: dict | None) -> dict:
    s = 2 * _dir_num(structure.get("H1", {}).get("trend")) + _dir_num(structure.get("M15", {}).get("trend"))
    label = "BULLISH" if s >= 2 else "BEARISH" if s <= -2 else "NEUTRAL"
    return {"label": label, "score": s, "h1": structure.get("H1", {}).get("trend"), "m15": structure.get("M15", {}).get("trend"),
            "h1_zone": (pd_htf or {}).get("zone")}


# ----------------------------------------------------------------------------- setups
def _status(direction: str, price: float, zone: tuple[float, float], stop: float, tp1: float) -> str:
    lo, hi = zone
    if direction == "bear":
        if price >= stop:
            return "INVALIDATED"
        if price <= tp1:
            return "TARGET_REACHED"
        if lo <= price <= hi:
            return "IN_ENTRY_ZONE"
        return "AWAITING_RETRACE" if price < lo else "ZONE_TRADED_THROUGH"
    if price <= stop:
        return "INVALIDATED"
    if price >= tp1:
        return "TARGET_REACHED"
    if lo <= price <= hi:
        return "IN_ENTRY_ZONE"
    return "AWAITING_RETRACE" if price > hi else "ZONE_TRADED_THROUGH"


ACTIONABLE = {"AWAITING_RETRACE", "IN_ENTRY_ZONE"}


def _build_setup(direction: str, ctx: dict, selected_sweep: dict | None = None,
                 selected_event: dict | None = None) -> dict | None:
    bars, n, atr, price = ctx["bars"], len(ctx["bars"]), ctx["atr"], ctx["price"]
    look = LOOKBACK.get(ctx["ltf"], 80)
    side = "buy" if direction == "bear" else "sell"
    sweeps = [s for s in ctx["sweeps"] if s["side"] == side and s["confirm_i"] >= n - look]
    sweeps.sort(key=lambda s: s["i"], reverse=True)
    chosen, event = selected_sweep, selected_event
    if chosen is None or event is None:
        chosen, event = None, None
        for sw in sweeps:
            ev = next((e for e in ctx["events"] if e["dir"] == direction and e["i"] >= sw["confirm_i"] - 1 and e["i"] <= sw["i"] + 60), None)
            if ev:
                chosen, event = sw, ev
                break
    if chosen is None:
        return None
    sw = chosen
    ext = max(bars[k]["high"] for k in range(sw["i"], event["i"] + 1)) if direction == "bear" else min(bars[k]["low"] for k in range(sw["i"], event["i"] + 1))
    buf = max(0.15 * atr, symbols.profile()["buf_floor"])
    stop = ext + buf if direction == "bear" else ext - buf
    event_bars = bars[:event["i"] + 1]
    displacement = detect_displacement(event_bars, calc_atr(event_bars))
    ote = validated_ote(bars, event, atr)

    fv = [f for f in ctx["fvgs"] if f["dir"] == direction and sw["i"] <= f["i"] <= event["i"] + 1 and f["end_i"] is None]
    fvg = max(fv, key=lambda f: (f["high"] - f["low"], f["i"])) if fv else None
    ob = next((o for o in ctx["obs"] if o["event_i"] == event["i"] and o["end_i"] is None), None)
    arrays: list[str] = []
    ov_lo, ov_hi = (max(fvg["low"], ob["low"]), min(fvg["high"], ob["high"])) if (fvg and ob) else (0, 0)
    if fvg and ob and ov_hi > ov_lo:
        arrays = ["FVG", "OB"]
        zone = (ov_lo, ov_hi) if (ov_hi - ov_lo) >= 0.3 * (fvg["high"] - fvg["low"]) else (fvg["low"], fvg["high"])
    elif fvg:
        zone, arrays = (fvg["low"], fvg["high"]), ["FVG"]
    elif ob:
        zone, arrays = (ob["low"], ob["high"]), ["OB"]
    elif ote:
        zone, arrays = (ote["low"], ote["high"]), ["OTE"]
    else:
        return None
    entry = round((zone[0] + zone[1]) / 2, 2)
    risk = abs(stop - entry)
    if risk < 0.4 * atr:
        stop = entry + 0.4 * atr if direction == "bear" else entry - 0.4 * atr
        risk = 0.4 * atr
    sign = -1 if direction == "bear" else 1
    cands = sorted(
        [lv for lv in ctx["liquidity"] if lv["side"] == ("sell" if direction == "bear" else "buy") and lv["status"] == "active"
         and (lv["price"] - entry) * sign >= SPEC["risk"]["minimum_theoretical_rr"] * risk],
        key=lambda lv: abs(lv["price"] - entry))
    if cands:
        tp1, tp1_kind = cands[0]["price"], cands[0]["kind"]
    else:
        tp1, tp1_kind = entry + sign * 2 * risk, "2R"
    beyond = [lv for lv in cands if (lv["price"] - tp1) * sign > 0.3 * risk]
    if beyond:
        tp2, tp2_kind = beyond[0]["price"], beyond[0]["kind"]
    else:
        tp2, tp2_kind = entry + sign * (abs(tp1 - entry) / risk + 1) * risk, "R-extension"
    rr1, rr2 = round(abs(tp1 - entry) / risk, 2), round(abs(tp2 - entry) / risk, 2)
    status = _status(direction, price, zone, stop, tp1)

    reasons, components = [], {}
    bias = ctx["bias"]["label"]
    aligned = (bias == "BEARISH" and direction == "bear") or (bias == "BULLISH" and direction == "bull")
    if aligned:
        components["higher_timeframe_bias"] = SPEC["scoring"]["groups"]["higher_timeframe_bias"]
        reasons.append(f"HTF bias {bias} (H1/M15 structure) aligned")
    elif bias == "NEUTRAL":
        components["higher_timeframe_bias"] = 7
        reasons.append("HTF bias neutral/mixed")
    else:
        components["higher_timeframe_bias"] = 0
        reasons.append(f"Counter-trend vs HTF bias {bias}")
    big = sw["kind"] in ("PDH", "PDL", "PWH", "PWL", "PMH", "PML", "ASIA_H", "ASIA_L", "CRT_H", "CRT_L", "EQH", "EQL")
    components["liquidity_sweep_quality"] = SPEC["scoring"]["groups"]["liquidity_sweep_quality"] if big else 14
    reasons.append(f"Liquidity sweep of {sw['kind']} @ {sw['level']:.2f}")
    structure_score = 10 if event["kind"] == "MSS" else 6
    if displacement["classification"] in ("STRONG", "EXTREME"):
        structure_score += 10
    elif displacement["classification"] == "MODERATE":
        structure_score += 6
    components["structure_displacement"] = min(SPEC["scoring"]["groups"]["structure_displacement"], structure_score)
    if event["kind"] == "MSS":
        reasons.append("MSS (CHoCH) after sweep")
    else:
        reasons.append("BOS after sweep")
    reasons.append(f"{displacement['classification']} displacement")
    pd_score = 0
    if "FVG" in arrays:
        pd_score += 10; reasons.append("Entry on unfilled FVG")
    if "OB" in arrays:
        pd_score += 7; reasons.append("Order block in entry zone")
    if arrays == ["OTE"]:
        pd_score += 6; reasons.append("Validated displacement-leg OTE retracement")
    components["pd_array_confluence"] = min(SPEC["scoring"]["groups"]["pd_array_confluence"], pd_score)
    if ctx["session"]["in_killzone"]:
        components["session_context"] = SPEC["scoring"]["groups"]["session_context"]
        reasons.append(f"Inside {ctx['session']['name']} kill zone")
    else:
        components["session_context"] = 0
    components["target_liquidity"] = SPEC["scoring"]["groups"]["target_liquidity"] if cands else 0
    quality_max = SPEC["scoring"]["groups"]["data_quality"]
    components["data_quality"] = quality_max if ctx["data_quality"]["score"] >= 90 else round(quality_max * 0.6) if ctx["data_quality"]["score"] >= 70 else 0
    if event["i"] < n - look:
        status = "EXPIRED"
    score = max(0, min(SPEC["scoring"]["setup_max"], sum(components.values())))
    ltf_min = TF_MIN.get(ctx["ltf"], 5)
    return {
        "direction": direction, "action": "SELL" if direction == "bear" else "BUY", "status": status, "score": score, "reasons": reasons,
        "sweep": sw, "event": {k: event[k] for k in ("i", "ts", "kind", "dir", "level")}, "arrays": arrays,
        "fvg": fvg, "ob": ob, "displacement": displacement, "ote": ote, "score_components": components,
        "plan": {"direction": direction, "action": "SELL" if direction == "bear" else "BUY", "entry": entry,
                 "entry_low": round(zone[0], 2), "entry_high": round(zone[1], 2), "stop": round(stop, 2),
                 "tp1": round(tp1, 2), "tp2": round(tp2, 2), "tp1_basis": tp1_kind, "tp2_basis": tp2_kind,
                 "rr1": rr1, "rr2": rr2, "risk": round(risk, 2), "ts_start": bars[-1]["timestamp_ms"],
                 "bars_ahead": 30, "valid_until_ms": bars[-1]["timestamp_ms"] + VALID_HOURS.get(ctx["ltf"], 6) * 3_600_000,
                 "ltf_minutes": ltf_min},
    }


def _build_setups(direction: str, ctx: dict) -> list[dict]:
    bars, n = ctx["bars"], len(ctx["bars"])
    look = LOOKBACK.get(ctx["ltf"], 80)
    side = "buy" if direction == "bear" else "sell"
    sweeps = sorted(
        (s for s in ctx["sweeps"] if s["side"] == side and s["confirm_i"] >= n - look),
        key=lambda sweep: sweep["i"],
    )
    results, seen = [], set()
    for sweep in sweeps:
        event = next((candidate for candidate in ctx["events"]
                      if candidate["dir"] == direction and candidate["i"] >= sweep["confirm_i"] - 1
                      and candidate["i"] <= sweep["i"] + 60), None)
        if not event:
            continue
        key = (sweep["ts"], event["ts"])
        if key in seen:
            continue
        seen.add(key)
        setup = _build_setup(direction, ctx, sweep, event)
        if setup:
            results.append(setup)
    return results


# ----------------------------------------------------------------------------- drawings
def _build(bars, ctx, levels, setups, best) -> tuple[list[dict], dict]:
    d: list[dict] = []
    table: dict[str, dict] = {}
    cnt: dict[str, int] = {}

    def reg(prefix: str, **vals) -> str:
        cnt[prefix] = cnt.get(prefix, 0) + 1
        key = f"{prefix}{cnt[prefix]}" if prefix not in ("PDH", "PDL", "ASIA_H", "ASIA_L", "CRT_H", "CRT_L", "ENTRY", "SL", "TP1", "TP2", "PD_EQ") else prefix
        table[key] = vals
        return key

    def add(**kw):
        kw["id"] = f"D{len(d) + 1}"
        d.append(kw)

    n = len(bars)
    ts = lambda i: bars[max(0, min(n - 1, i))]["timestamp_ms"]  # noqa: E731
    # liquidity layer
    drawn = 0
    for lv in sorted(levels, key=lambda l: abs(l["price"] - ctx["price"])):
        if lv["kind"] in ("SWH", "SWL"):
            continue
        if lv["status"] == "broken":
            continue
        if lv["status"] == "active" and drawn >= 7 and lv["kind"] in ("EQH", "EQL"):
            continue
        key = reg(lv["kind"], price=round(lv["price"], 2))
        label = lv["kind"].replace("_", " ") + (" swept" if lv["status"] == "swept" else "")
        add(layer="liquidity" if not lv["kind"].startswith("CRT") else "range", type="hline", ts1=lv["ts"],
            ts2=ts(lv["swept_i"]) if lv["swept_i"] is not None else None, p1=round(lv["price"], 2),
            label=f"{label} {lv['price']:.2f}" if lv["kind"].startswith("CRT") else label, tone="liq" if lv["side"] == "buy" else "liq2",
            style="dotted" if lv["status"] == "swept" else "dashed", ref=key)
        drawn += 1
    for s in ctx["sweeps"][-4:]:
        key = reg("SWEEP", price=round(s["extreme"], 2), level=round(s["level"], 2))
        add(layer="liquidity", type="tag", ts=s["ts"], p1=round(s["extreme"], 2), label="Sweep", tone="liq", pos="above" if s["side"] == "buy" else "below", ref=key)
    # range layer
    pd = ctx["pd"]
    for nm, p in (("Range High", pd["high"]), ("Equilibrium", pd["eq"]), ("Range Low", pd["low"])):
        add(layer="range", type="hline", ts1=pd["ts1"], ts2=None, p1=round(p, 2), label=f"{nm} {p:.2f}", tone="muted", style="dotted")
    table["PD_EQ"] = {"price": round(pd["eq"], 2)}
    # structure layer
    for s in ctx["swings"][-10:]:
        add(layer="structure", type="swing", ts=s["ts"], p1=round(s["price"], 2), side=s["type"], tone="muted")
    for e in ctx["events"][-6:]:
        key = reg(e["kind"], price=round(e["level"], 2))
        add(layer="structure", type="hline", ts1=e["origin_ts"], ts2=e["ts"], p1=round(e["level"], 2), label=e["kind"], tone=e["dir"], style="solid", tag=True, ref=key)
    # zones layer
    shown = 0
    keep = {id(s_["fvg"]) for s_ in setups if s_.get("fvg")}
    for f in sorted([f for f in ctx["fvgs"] if f["end_i"] is None and f["i"] >= n - 160 and (f["high"] - f["low"] >= 0.35 * ctx["atr"] or id(f) in keep)], key=lambda f: -f["i"]):
        if shown >= 4:
            break
        key = reg("FVG", low=round(f["low"], 2), high=round(f["high"], 2))
        add(layer="zones", type="box", ts1=f["ts"], ts2=None, p1=round(f["high"], 2), p2=round(f["low"], 2), label="FVG", tone=f["dir"], ref=key)
        f["ref"] = key
        shown += 1
    for o in [o for o in ctx["obs"] if o["end_i"] is None][-2:]:
        key = reg("OB", low=round(o["low"], 2), high=round(o["high"], 2))
        add(layer="zones", type="box", ts1=o["ts"], ts2=None, p1=round(o["high"], 2), p2=round(o["low"], 2), label="OB", tone=o["dir"], ref=key)
        o["ref"] = key
    # plan layer
    if best:
        p = best["plan"]
        for k, v in (("ENTRY", p["entry"]), ("SL", p["stop"]), ("TP1", p["tp1"]), ("TP2", p["tp2"])):
            table[k] = {"price": v}
        table["ENTRY"].update(low=p["entry_low"], high=p["entry_high"])
        add(layer="plan", type="plan", ts_start=p["ts_start"], bars_ahead=p["bars_ahead"], direction=p["direction"], entry=p["entry"],
            entry_low=p["entry_low"], entry_high=p["entry_high"], stop=p["stop"], tp1=p["tp1"], tp2=p["tp2"], rr1=p["rr1"], rr2=p["rr2"],
            status=best["status"], ltf_minutes=p["ltf_minutes"])
    return d, table


# ----------------------------------------------------------------------------- main entry
def _validated_candles(bars_by_tf: dict[str, list[dict]]) -> dict[str, list[dict]]:
    normalized = {}
    for tf, source in bars_by_tf.items():
        if tf not in TF_MIN:
            raise ValueError(f"Unsupported candle timeframe '{tf}'.")
        bars = list(source)
        if bars and bars[-1].get("complete") is False:
            bars.pop()
        if any(bar.get("complete") is False for bar in bars):
            raise ValueError(f"{tf} contains an incomplete candle before the latest bar.")
        previous = None
        for bar in bars:
            values = [bar.get(key) for key in ("open", "high", "low", "close", "timestamp_ms")]
            if any(not isinstance(value, (int, float)) or not isfinite(value) for value in values):
                raise ValueError(f"{tf} contains a non-finite OHLC value or timestamp.")
            if bar["timestamp_ms"] <= (previous if previous is not None else -1):
                raise ValueError(f"{tf} candles must have unique, increasing timestamps.")
            if (bar["high"] < max(bar["open"], bar["close"], bar["low"])
                    or bar["low"] > min(bar["open"], bar["close"], bar["high"])):
                raise ValueError(f"{tf} contains invalid OHLC bounds.")
            previous = bar["timestamp_ms"]
        normalized[tf] = bars
    return normalized


def _scan_single(bars_by_tf: dict[str, list[dict]], ltf: str = "M5", symbol: str = "XAUUSD") -> dict:
    symbols.set_active(symbol)
    if ltf not in TF_MIN:
        raise ValueError(f"Unsupported entry timeframe '{ltf}'.")
    bars_by_tf = _validated_candles(bars_by_tf)
    if ltf not in bars_by_tf:
        raise ValueError(f"Missing {ltf} candles.")
    bars = bars_by_tf[ltf]
    if len(bars) < 60:
        raise ValueError(f"Need at least 60 {ltf} candles for an ICT scan (got {len(bars)}).")
    htf = bars_by_tf.get("H1")
    price = bars[-1]["close"]
    atr = calc_atr(bars)
    swings = find_swings(bars)
    struct = market_structure(bars, swings)
    structure_layers = layered_structure(bars)
    structure_by_tf: dict[str, dict] = {ltf: {"trend": struct["trend"], "last_event": struct["events"][-1] if struct["events"] else None}}
    pd_by_tf: dict[str, dict] = {}
    for tf in ("D1", "H4", "H1", "M15"):
        tb = bars_by_tf.get(tf)
        if tb and len(tb) >= 30 and tf != ltf:
            st = market_structure(tb, find_swings(tb))
            structure_by_tf[tf] = {"trend": st["trend"], "last_event": st["events"][-1] if st["events"] else None}
            pd_by_tf[tf] = premium_discount(tb, tb[-1]["close"], 60)
    if ltf == "M15":
        pd_by_tf["M15"] = premium_discount(bars, price, 60)
    bias = mtf_bias(structure_by_tf, pd_by_tf.get("H1"))
    crt = crt_range(htf)
    levels, sweeps = build_liquidity(bars, swings, atr, htf, crt)
    fvgs = find_fvgs(bars, atr)
    enrich_fvgs(bars, fvgs, atr)
    obs = [o for o in (order_block_for(bars, e) for e in struct["events"][-8:]) if o]
    pd = premium_discount(bars, price)
    session = session_info(bars[-1]["timestamp_ms"])
    quality = data_quality(bars, ltf)
    displacement = detect_displacement(bars, atr)
    cisd = detect_cisd(bars, atr)
    regime = classify_regime(bars, struct["trend"], atr)
    pd_arrays = advanced_pd_arrays(bars, fvgs, atr)
    pd_arrays["ote"] = validated_ote(bars, struct["events"][-1] if struct["events"] else None, atr)
    ctx = {"bars": bars, "ltf": ltf, "atr": atr, "price": price, "swings": swings, "events": struct["events"], "sweeps": sweeps, "fvgs": fvgs,
           "obs": obs, "liquidity": levels, "pd": pd, "crt": crt, "bias": bias, "session": session, "data_quality": quality}
    setups = _build_setups("bear", ctx) + _build_setups("bull", ctx)
    for i, s in enumerate(sorted(setups, key=lambda x: -x["score"]), 1):
        s["id"] = f"S{i}"
    setups.sort(key=lambda x: x["id"])
    live = [s for s in setups if s["status"] in ACTIONABLE and s["score"] >= ICT_MIN_SCORE]
    best = max(live, key=lambda s: s["score"]) if live else None
    show = best or (max(setups, key=lambda s: s["score"]) if setups else None)
    drawings, table = _build(bars, ctx, levels, setups, show)
    for s in setups:                       # level ids the AI is allowed to cite for each setup
        s["refs"] = {"sweep": next((k for k, v in table.items() if k.startswith("SWEEP") and abs(v["level"] - s["sweep"]["level"]) < 0.01), None),
                     "event": next((k for k, v in table.items() if k.startswith(s["event"]["kind"]) and abs(v["price"] - s["event"]["level"]) < 0.01), None)}
        if s["fvg"] and s["fvg"].get("ref"):
            s["refs"]["fvg"] = s["fvg"]["ref"]
        if s["ob"] and s["ob"].get("ref"):
            s["refs"]["ob"] = s["ob"]["ref"]
    if best:
        direction, action = best["action"], "ENTER_ON_RETRACE" if best["status"] == "AWAITING_RETRACE" else "PRICE_IN_ENTRY_ZONE"
        reasons = best["reasons"]
        score = best["score"]
    else:
        direction, score = "WAIT", max((s["score"] for s in setups), default=0)
        if not setups:
            reasons = ["No liquidity sweep followed by MSS/BOS in the lookback window"]
        else:
            top = max(setups, key=lambda s: s["score"])
            reasons = [f"Best candidate {top['action']} is {top['status']} / score {top['score']} (< {ICT_MIN_SCORE} or not actionable)"] + top["reasons"]
        action = "WAIT_FOR_SETUP"

    def slim(s: dict) -> dict:
        out = {k: s[k] for k in ("id", "direction", "action", "status", "score", "reasons", "arrays", "plan", "refs",
                                 "displacement", "ote", "score_components")}
        out["sweep"] = {k: s["sweep"][k] for k in ("kind", "level", "extreme", "ts")}
        out["event"] = s["event"]
        return out

    advanced = {"regime": regime, "displacement": displacement, "cisd": cisd,
                "ifvgs": pd_arrays["ifvgs"], "bprs": pd_arrays["bprs"], "ote": pd_arrays["ote"]}
    readiness = 100 if show and show["status"] == "IN_ENTRY_ZONE" else 65 if show and show["status"] == "AWAITING_RETRACE" else 0
    return {
        "scan_type": "ict", "symbol": symbols.profile()["name"], "ltf": ltf, "price": round(price, 2), "atr": round(atr, 3), "time_ms": bars[-1]["timestamp_ms"],
        "session": session, "bias": bias, "structure": structure_by_tf, "pd": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in pd.items()},
        "pd_htf": pd_by_tf, "crt": crt, "setups": [slim(s) for s in setups], "selected": show["id"] if show else None,
        "direction": direction, "action": action, "confluence_score": score, "reasons": reasons,
        "plan": show["plan"] if show else None, "plan_status": show["status"] if show else None,
        "drawings": drawings, "level_table": table, "min_score": ICT_MIN_SCORE,
        "engine_version": SPEC["engine_version"], "setup_score": score, "entry_readiness_score": readiness,
        "data_quality": quality, "data_quality_score": quality["score"], "advanced": advanced,
        "model_registry": [], "structure_layers": structure_layers,
    }


def _lifecycle(status: str) -> str:
    return {
        "IN_ENTRY_ZONE": "ENTRY_READY",
        "AWAITING_RETRACE": "WAITING_FOR_RETRACE",
        "TARGET_REACHED": "TARGET_REACHED",
        "INVALIDATED": "INVALIDATED",
        "EXPIRED": "EXPIRED",
        "ZONE_TRADED_THROUGH": "INVALIDATED",
    }.get(status, "WAITING_FOR_CONFIRMATION")


def _classify_setup(model_id: str, setup: dict) -> tuple[bool, list[str]]:
    plan = setup["plan"]
    checks = {
        "liquidity_sweep": bool(setup.get("sweep")),
        "structure_confirmation": setup.get("event", {}).get("kind") in ("MSS", "BOS"),
        "structure_shift": setup.get("event", {}).get("kind") == "MSS",
        "displacement": setup.get("displacement", {}).get("classification") in ("MODERATE", "STRONG", "EXTREME"),
        "fvg": "FVG" in setup.get("arrays", []),
        "entry_array": bool(setup.get("arrays")),
        "risk_plan": plan["stop"] != plan["entry"] and plan["tp1"] != plan["entry"],
        "valid_retrace": setup.get("status") in ACTIONABLE,
        "prior_period_extreme": setup.get("sweep", {}).get("kind") in ("PDH", "PDL", "PWH", "PWL", "PMH", "PML"),
        "opposing_target": plan.get("tp1_basis") not in ("2R", "R-extension"),
    }
    requirements = {
        "LIQUIDITY_SWEEP_REVERSAL": ("liquidity_sweep", "structure_confirmation", "entry_array", "risk_plan"),
        "ICT_2022": ("liquidity_sweep", "structure_shift", "displacement", "fvg", "valid_retrace"),
        "TURTLE_SOUP": ("prior_period_extreme", "liquidity_sweep", "structure_confirmation", "opposing_target"),
    }.get(model_id, ())
    missing = [requirement for requirement in requirements if not checks.get(requirement, False)]
    return not missing, missing


def _rank_setup(setup: dict, result: dict) -> tuple:
    plan = setup["plan"]
    direction = setup["direction"]
    bias = result.get("bias", {}).get("label")
    aligned = int((direction == "bull" and bias == "BULLISH") or (direction == "bear" and bias == "BEARISH"))
    target_quality = int(plan.get("tp1_basis") not in ("2R", "R-extension"))
    freshness = max(0, 100 - int(max(0, result["time_ms"] - setup["event"]["ts"]) / (plan["ltf_minutes"] * 60_000)))
    ranking = {
        "setup_score": setup["score"],
        "data_quality": result["data_quality_score"],
        "entry_readiness": 100 if setup["lifecycle"] == "ENTRY_READY" else 65 if setup["lifecycle"] == "WAITING_FOR_RETRACE" else 0,
        "higher_timeframe_alignment": aligned,
        "liquidity_target_quality": target_quality,
        "risk_reward": plan["rr2"],
        "freshness": freshness,
    }
    setup["ranking"] = ranking
    return (-ranking["setup_score"], -ranking["data_quality"], -ranking["entry_readiness"],
            -ranking["higher_timeframe_alignment"], -ranking["liquidity_target_quality"],
            -ranking["risk_reward"], -ranking["freshness"], setup["id"])


def scan(
    bars_by_tf: dict[str, list[dict]],
    ltf: str = "M5",
    symbol: str = "XAUUSD",
    filters: dict[str, Any] | None = None,
) -> dict:
    """Scan every eligible configured timeframe and return all enabled model classifications."""
    if ltf not in TF_MIN:
        raise ValueError(f"Unsupported entry timeframe '{ltf}'.")
    normalized = _validated_candles(bars_by_tf)
    if ltf not in normalized:
        raise ValueError(f"Missing {ltf} candles.")
    if len(normalized[ltf]) < SPEC["scanner"]["minimum_candles"]:
        raise ValueError(f"Need at least {SPEC['scanner']['minimum_candles']} {ltf} candles for an ICT scan (got {len(normalized[ltf])}).")

    frames = SPEC["scanner"]["coverage_timeframes"]
    coverage = {}
    frame_results = {}
    for timeframe in frames:
        bars = normalized.get(timeframe)
        if bars is None:
            coverage[timeframe] = {"status": "UNAVAILABLE", "candles": 0}
            continue
        if len(bars) < SPEC["scanner"]["minimum_candles"]:
            coverage[timeframe] = {"status": "INSUFFICIENT_HISTORY", "candles": len(bars)}
            continue
        frame_result = _scan_single(normalized, timeframe, symbol)
        frame_results[timeframe] = frame_result
        coverage[timeframe] = {"status": "SCANNED", "candles": len(bars), "time_ms": frame_result["time_ms"]}

    primary = frame_results[ltf]
    model_specs = SPEC["scanner"]["models"]
    candidates = []
    model_candidate_ids = {model["id"]: [] for model in model_specs}
    for timeframe, frame_result in frame_results.items():
        for base in frame_result["setups"]:
            event = base["event"]
            opportunity_id = f"{symbol}:{timeframe}:{base['direction']}:{base['sweep']['ts']}:{event['ts']}"
            for model in model_specs:
                if not model["enabled"] or timeframe not in model["timeframes"]:
                    continue
                valid, _ = _classify_setup(model["id"], base)
                if not valid:
                    continue
                candidate = {**base}
                candidate.update({
                    "id": f"{opportunity_id}:{model['id']}",
                    "legacy_setup_id": base["id"],
                    "opportunity_id": opportunity_id,
                    "event_id": f"{symbol}:{timeframe}:{event['kind']}:{event['ts']}",
                    "model_id": model["id"],
                    "model_name": model["name"],
                    "model_family": model["family"],
                    "timeframe": timeframe,
                    "lifecycle": _lifecycle(base["status"]),
                    "entry_zone": {"low": base["plan"]["entry_low"], "high": base["plan"]["entry_high"]},
                    "invalidation": {"price": base["plan"]["stop"], "condition": "price reaches stop"},
                    "target": {"tp1": base["plan"]["tp1"], "tp2": base["plan"]["tp2"],
                               "liquidity_basis": base["plan"]["tp1_basis"]},
                    "expiry_ms": base["plan"]["valid_until_ms"],
                    "data_quality_score": frame_result["data_quality_score"],
                    "missing_confirmations": [],
                    "is_current": True,
                })
                candidates.append(candidate)
                model_candidate_ids[model["id"]].append(candidate["id"])

    def included(candidate: dict) -> bool:
        if not filters:
            return True
        minimum_score = filters.get("min_score")
        return (
            (not filters.get("symbol") or str(filters["symbol"]).upper() == str(primary["symbol"]).upper())
            and (not filters.get("direction") or candidate["action"] == str(filters["direction"]).upper())
            and (not filters.get("model") or candidate["model_id"] == str(filters["model"]).upper())
            and (not filters.get("timeframe") or candidate["timeframe"] == str(filters["timeframe"]).upper())
            and (not filters.get("status") or candidate["lifecycle"] == str(filters["status"]).upper())
            and candidate["score"] >= float(minimum_score if minimum_score is not None else 0)
        )

    candidates = [candidate for candidate in candidates if included(candidate)]
    candidates.sort(key=lambda candidate: _rank_setup(candidate, frame_results[candidate["timeframe"]]))
    for rank, candidate in enumerate(candidates, 1):
        candidate["rank"] = rank
    requested_min_score = (filters or {}).get("min_score")
    ready_threshold = float(requested_min_score if requested_min_score is not None else ICT_MIN_SCORE)
    ready = [candidate for candidate in candidates
             if candidate["lifecycle"] in ("ENTRY_READY", "WAITING_FOR_RETRACE")
             and candidate["score"] >= ready_threshold]
    selected = ready[0] if ready else None
    displayed = selected or (candidates[0] if candidates else None)

    registry = []
    for model in model_specs:
        eligible = [tf for tf in model["timeframes"] if coverage.get(tf, {}).get("status") == "SCANNED"]
        missing_frames = [tf for tf in model["timeframes"] if tf not in eligible]
        found = model_candidate_ids[model["id"]]
        registry.append({
            **model,
            "output_contract": SPEC["scanner"]["output_contract"],
            "implemented": bool(model["enabled"] and model["detector"]),
            "available": bool(model["enabled"] and model["detector"] and eligible),
            "status": ("DISABLED" if not model["enabled"] else "CANDIDATES_FOUND" if found
                       else "SCANNED_NO_SETUP" if eligible else "DATA_UNAVAILABLE"),
            "eligible_timeframes": eligible,
            "missing_timeframes": missing_frames,
            "candidate_setup_ids": found,
            "missing_confirmations": [] if found else list(model["requirements"]),
        })

    result = dict(primary)
    result.update({
        "setups": candidates,
        "selected": selected["id"] if selected else None,
        "selected_timeframe": selected["timeframe"] if selected else None,
        "direction": selected["action"] if selected else "WAIT",
        "action": ("PRICE_IN_ENTRY_ZONE" if selected["lifecycle"] == "ENTRY_READY" else "ENTER_ON_RETRACE")
                  if selected else "WAIT_FOR_SETUP",
        "confluence_score": selected["score"] if selected else max((s["score"] for s in candidates), default=0),
        "setup_score": selected["score"] if selected else max((s["score"] for s in candidates), default=0),
        "entry_readiness_score": selected["ranking"]["entry_readiness"] if selected else 0,
        "plan": displayed["plan"] if displayed else None,
        "plan_status": displayed["status"] if displayed else None,
        "reasons": selected["reasons"] if selected else ["NO_VALID_SETUP" if not candidates else "No candidate meets the score and readiness threshold."],
        "scanner_status": "SETUPS_FOUND" if candidates else "NO_VALID_SETUP",
        "coverage": coverage,
        "model_registry": registry,
        "unique_opportunity_count": len({candidate["opportunity_id"] for candidate in candidates}),
        "model_classification_count": len(candidates),
        "filters_applied": filters or {},
    })
    return result


# ----------------------------------------------------------------------------- AI validation
import re  # noqa: E402

_PRICE_RE = re.compile(r"(?<![\d.,])(\d{3,7}(?:\.\d{1,3})?)(?![\d,])")


def validate_ai_review(review: dict, engine: dict, tolerance: float | None = None) -> dict:
    """The AI may only choose among engine setups and cite engine level ids/prices."""
    issues: list[str] = []
    tolerance = tolerance if tolerance is not None else max(0.6, 0.15 * float(engine.get("atr", 0) or 0))
    table = engine.get("level_table", {})
    prices: list[float] = []
    for v in table.values():
        prices += [x for x in (v.get("price"), v.get("low"), v.get("high")) if isinstance(x, (int, float))]
    for s in engine.get("setups", []):
        p = s["plan"]
        prices += [p["entry"], p["entry_low"], p["entry_high"], p["stop"], p["tp1"], p["tp2"]]
    prices.append(engine.get("price", 0))
    direction = str(review.get("direction", "WAIT")).upper()
    if direction not in ("BUY", "SELL", "WAIT"):
        issues.append(f"invalid direction '{direction}'")
    sel = review.get("selected_setup")
    ids = {setup_id for s in engine.get("setups", [])
           for setup_id in (s.get("id"), s.get("legacy_setup_id")) if setup_id}
    if sel not in (None, "NONE") and sel not in ids:
        issues.append(f"unknown setup '{sel}'")
    refs = review.get("referenced_levels") or []
    if not isinstance(refs, list):
        refs = []
        issues.append("referenced_levels is not a list")
    for r in refs:
        if r not in table:
            issues.append(f"unknown level id '{r}'")
    text = " ".join(str(review.get(k, "")) for k in ("narrative", "confirmation", "invalidation", "risk_note"))
    for m in _PRICE_RE.findall(text):
        val = float(m)
        if 0.5 * engine.get("price", 0) <= val <= 1.5 * engine.get("price", 0) and not any(abs(val - p) <= tolerance for p in prices):
            issues.append(f"price {val} is not an engine level")
    return {"accepted": not issues, "issues": issues[:8]}


def combine_verdict(engine: dict, review: dict | None, validation: dict | None, feed_ok: bool) -> dict:
    """Engine decides; AI can only confirm or veto. Disagreement => WAIT. Invalid AI output is discarded."""
    final, conf, notes, status = engine["direction"], int(engine["confluence_score"]), [], "ENGINE_ONLY"
    if review and review.get("ok"):
        if validation and validation["accepted"]:
            ai = review["direction"] if review.get("verdict") == "APPROVE" else "WAIT"
            if final == "WAIT":
                status = "ENGINE_WAIT"
                if ai in ("BUY", "SELL"):
                    notes.append("AI suggested a trade but the engine has no valid setup; AI cannot create levels, so WAIT.")
            elif ai == final:
                status, conf = "ALIGNED", round(0.6 * conf + 0.4 * review.get("confidence", conf))
            elif ai == "WAIT":
                status, final = "AI_VETO", "WAIT"
                notes.append("AI mentor vetoed the engine setup.")
            else:
                status, final = "CONFLICT", "WAIT"
                notes.append(f"AI says {ai} but the engine says {final}; showing WAIT.")
        else:
            status = "AI_REJECTED_BY_VALIDATOR"
            notes.append("AI answer was discarded (it referenced levels/prices that are not in the engine): " + "; ".join((validation or {}).get("issues", [])[:3]))
    elif review:
        notes.append("AI review unavailable: " + str(review.get("message", ""))[:160])
    if not feed_ok and final != "WAIT":
        final = "WAIT"
        notes.append("Feed is stale or the market is closed: analysis shown for the last available candles, not a live signal.")
    return {"final_direction": final, "final_confidence": max(0, min(100, conf)), "verdict_status": status, "verdict_notes": notes}
