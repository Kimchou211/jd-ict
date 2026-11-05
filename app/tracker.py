"""Automatic TP/SL tracking for saved ICT plans.

Canonical lifecycle: WAITING -> ACTIVE -> TP1_HIT / TP2_HIT / SL_HIT.
Legacy PENDING/FILLED states still map to the canonical names so older saved payloads keep working.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any


STATE_ALIASES = {
    "PENDING": "WAITING",
    "WAITING": "WAITING",
    "FILLED": "ACTIVE",
    "ACTIVE": "ACTIVE",
    "TP1": "TP1_HIT",
    "TP2": "TP2_HIT",
    "SL": "SL_HIT",
    "TP1_HIT": "TP1_HIT",
    "TP2_HIT": "TP2_HIT",
    "SL_HIT": "SL_HIT",
    "DONE": "ACTIVE",
}

FINAL_STATES = {"TP1_HIT", "TP2_HIT", "SL_HIT", "INVALIDATED", "EXPIRED", "NOT_TRACKABLE", "DATA_UNAVAILABLE"}


def normalize_state(state: Any) -> str:
    value = str(state or "WAITING").upper().replace(" ", "_")
    return STATE_ALIASES.get(value, value)


def _bar_timestamp(bar: dict) -> int:
    ts = bar.get("timestamp_ms")
    if ts is not None:
        return int(ts)
    ts = bar.get("time")
    if ts is None:
        return 0
    try:
        return int(ts)
    except (TypeError, ValueError):
        return 0


def evaluate_plan(plan: dict, track: dict, bars: list[dict], now_ms: int) -> dict:
    """Return the updated track dict. track = {state, checked_ms, activated_ms, result?, r?}."""
    t = dict(track or {})
    t["state"] = normalize_state(t.get("state", "WAITING"))
    if t["state"] in FINAL_STATES:
        t["checked_ms"] = max(t.get("checked_ms", 0), bars[-1]["timestamp_ms"] if bars else 0)
        return t

    bear = plan["direction"] == "bear"
    lo, hi, sl, tp1, tp2 = plan["entry_low"], plan["entry_high"], plan["stop"], plan["tp1"], plan["tp2"]
    start = max(t.get("checked_ms", 0), plan.get("ts_start", 0))

    for b in bars:
        ts = _bar_timestamp(b)
        if ts < start - 1:
            continue
        if t["state"] == "WAITING":
            bar_low, bar_high = float(b.get("low", 0.0)), float(b.get("high", 0.0))
            touched = bar_low <= hi and bar_high >= lo
            if touched:
                t.update(state="ACTIVE", activated_ms=ts, filled_ms=ts, entry_hit_ms=ts)
                continue
            if bear:
                stop_hit = bar_high >= sl
                tp_hit = bar_low <= tp1
            else:
                stop_hit = bar_low <= sl
                tp_hit = bar_high >= tp1
            if stop_hit or tp_hit:
                t.update(state="INVALIDATED", result="SKIP", r=0.0, reason="price reached a level before the entry zone was touched", invalidated_ms=ts, done_ms=ts)
                break
        if t["state"] == "ACTIVE":
            if bear:
                sl_hit = b["high"] >= sl
                tp2_hit = b["low"] <= tp2
                tp1_hit = b["low"] <= tp1
            else:
                sl_hit = b["low"] <= sl
                tp2_hit = b["high"] >= tp2
                tp1_hit = b["high"] >= tp1
            if sl_hit:
                t.update(state="SL_HIT", result="SL", r=-1.0, done_ms=ts, closed_at=ts)
                break
            if tp2_hit:
                t.update(state="TP2_HIT", result="TP2", r=plan.get("rr2", 0.0), done_ms=ts, closed_at=ts)
                break
            if tp1_hit:
                t.update(state="TP1_HIT", result="TP1", r=plan.get("rr1", 0.0), done_ms=ts, closed_at=ts)
                break

    if t["state"] == "WAITING" and plan.get("valid_until_ms") and now_ms > int(plan["valid_until_ms"]):
        t.update(state="EXPIRED", result="SKIP", r=0.0, reason="plan expired before the entry zone was touched", done_ms=now_ms, closed_at=now_ms)
    if bars:
        t["checked_ms"] = bars[-1]["timestamp_ms"]
    return t


MAX_AGE_HOURS = 36          # M1 candles cover ~40 h; older signals are left for manual marking
VALID_HOURS = 6             # legacy default used only when an explicit model/row expiry is specified


def plan_from_row(row: Any, payload: dict) -> dict | None:
    """Trackable plan for ANY saved signal: ICT plans keep their own; image/live signals use the saved entry zone, SL and TPs."""
    if payload.get("ict_plan"):
        return payload["ict_plan"]
    if row.direction not in ("BUY", "SELL") or None in (row.entry_low, row.entry_high, row.stop_loss, row.take_profit_1) or not row.created_at:
        return None
    lo, hi, sl, tp1 = float(row.entry_low), float(row.entry_high), float(row.stop_loss), float(row.take_profit_1)
    tp2 = float(row.take_profit_2) if row.take_profit_2 is not None else tp1
    bear = row.direction == "SELL"
    if lo > hi:
        lo, hi = hi, lo
    if (bear and not (sl > hi and tp1 < lo)) or (not bear and not (sl < lo and tp1 > hi)):
        return None                     # levels on the wrong side of the entry: cannot be tracked honestly
    mid, risk = (lo + hi) / 2, abs((lo + hi) / 2 - sl)
    if risk <= 0:
        return None
    created = row.created_at if row.created_at.tzinfo else row.created_at.replace(tzinfo=timezone.utc)
    ts = int(created.timestamp() * 1000)
    plan = {"direction": "bear" if bear else "bull", "entry_low": lo, "entry_high": hi, "stop": sl, "tp1": tp1, "tp2": tp2,
            "rr1": round(abs(tp1 - mid) / risk, 2), "rr2": round(abs(tp2 - mid) / risk, 2), "ts_start": ts}
    explicit_expiry = payload.get("valid_until_ms") or getattr(row, "valid_until_ms", None)
    if explicit_expiry:
        plan["valid_until_ms"] = int(explicit_expiry)
    return plan


async def run_tracker_once(db_session_factory, AnalysisRecord) -> dict:
    """Check every open signal (ICT, screenshot or live) against fresh M1 candles and write TP1/TP2/SL results."""
    from .market_data import fetch_candles
    db = db_session_factory()
    summary = {"checked": 0, "closed": 0}
    try:
        now = datetime.now(timezone.utc)
        rows = db.query(AnalysisRecord).order_by(AnalysisRecord.id.desc()).limit(300).all()
        open_rows = []
        for row in rows:
            created = row.created_at.replace(tzinfo=timezone.utc) if row.created_at and not row.created_at.tzinfo else row.created_at
            if not created or (now - created).total_seconds() > MAX_AGE_HOURS * 3600:
                continue
            try:
                payload = json.loads(row.payload_json)
            except (ValueError, TypeError):
                continue
            key = "ict_track" if "ict_track" in payload else "track"
            state = normalize_state((payload.get(key) or {}).get("state"))
            if payload.get("outcome") or state in FINAL_STATES:
                continue
            plan = plan_from_row(row, payload)
            if plan:
                open_rows.append((row, payload, plan, key))
        if not open_rows:
            return summary
        now_ms = int(now.timestamp() * 1000)
        feeds: dict[str, list[dict]] = {}
        for row, payload, plan, key in open_rows:
            sym = row.symbol or "XAUUSD"
            if sym not in feeds:
                feeds[sym] = (await fetch_candles("M1", symbol=sym))["bars"]
            summary["checked"] += 1
            new = evaluate_plan(plan, payload.get(key) or {}, feeds[sym], now_ms)
            payload[key] = new
            if new.get("state") in FINAL_STATES:
                result = new.get("result") or new.get("state").replace("_HIT", "")
                at = datetime.fromtimestamp(new.get("done_ms", now_ms) / 1000, timezone.utc).isoformat()
                payload["outcome"] = {"result": result, "r": new.get("r"), "at": at, "auto": True}
                summary["closed"] += 1
            row.payload_json = json.dumps(payload, ensure_ascii=False)
        db.commit()
    except Exception as exc:
        db.rollback()
        summary["error"] = str(exc)[:200]
    finally:
        db.close()
    return summary
