"""Automatic TP/SL tracking for saved ICT plans.

A plan is PENDING until price trades into its entry zone, then FILLED; after that the first of
SL / TP1 / TP2 touched decides the result. If one candle touches both SL and a target we assume
the stop came first (pessimistic). Candles are M5, so intra-candle order is unknowable.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any


def evaluate_plan(plan: dict, track: dict, bars: list[dict], now_ms: int) -> dict:
    """Return the updated track dict. track = {state, filled_ms, checked_ms, result?, r?}."""
    t = dict(track or {})
    t.setdefault("state", "PENDING")
    bear = plan["direction"] == "bear"
    lo, hi, sl, tp1, tp2 = plan["entry_low"], plan["entry_high"], plan["stop"], plan["tp1"], plan["tp2"]
    start = max(t.get("checked_ms", 0), plan["ts_start"])
    for b in bars:
        ts = b["timestamp_ms"]
        if ts < start - 1 or t["state"] == "DONE":
            continue
        if t["state"] == "PENDING":
            sl_hit = b["high"] >= sl if bear else b["low"] <= sl
            tp_hit = b["low"] <= tp1 if bear else b["high"] >= tp1
            touched = b["low"] <= hi and b["high"] >= lo
            if not touched and (sl_hit or tp_hit):
                t.update(state="DONE", result="SKIP", r=0.0, reason="price left without filling the entry zone", done_ms=ts)
                break
            if touched:
                t.update(state="FILLED", filled_ms=ts)
            else:
                continue
        if t["state"] == "FILLED":
            sl_hit = b["high"] >= sl if bear else b["low"] <= sl
            t2 = b["low"] <= tp2 if bear else b["high"] >= tp2
            t1 = b["low"] <= tp1 if bear else b["high"] >= tp1
            if sl_hit:
                t.update(state="DONE", result="SL", r=-1.0, done_ms=ts)
            elif t2:
                t.update(state="DONE", result="TP2", r=plan["rr2"], done_ms=ts)
            elif t1:
                t.update(state="DONE", result="TP1", r=plan["rr1"], done_ms=ts)
            if t["state"] == "DONE":
                break
    if t["state"] == "PENDING" and now_ms > plan.get("valid_until_ms", 0):
        t.update(state="DONE", result="SKIP", r=0.0, reason="plan expired before the entry zone was touched", done_ms=now_ms)
    if bars:
        t["checked_ms"] = bars[-1]["timestamp_ms"]
    return t


MAX_AGE_HOURS = 36          # M5 candles cover ~40 h; older signals are left for manual marking
VALID_HOURS = 6             # an unfilled signal expires after this long


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
    return {"direction": "bear" if bear else "bull", "entry_low": lo, "entry_high": hi, "stop": sl, "tp1": tp1, "tp2": tp2,
            "rr1": round(abs(tp1 - mid) / risk, 2), "rr2": round(abs(tp2 - mid) / risk, 2), "ts_start": ts, "valid_until_ms": ts + VALID_HOURS * 3_600_000}


async def run_tracker_once(db_session_factory, AnalysisRecord) -> dict:
    """Check every open signal (ICT, screenshot or live) against fresh M5 candles and write TP1/TP2/SL results."""
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
            if payload.get("outcome") or (payload.get(key) or {}).get("state") == "DONE":
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
                feeds[sym] = (await fetch_candles("M5", symbol=sym))["bars"]
            summary["checked"] += 1
            new = evaluate_plan(plan, payload.get(key) or {}, feeds[sym], now_ms)
            payload[key] = new
            if new.get("state") == "DONE":
                at = datetime.fromtimestamp(new.get("done_ms", now_ms) / 1000, timezone.utc).isoformat()
                payload["outcome"] = {"result": new["result"], "r": new.get("r"), "at": at, "auto": True}
                summary["closed"] += 1
            row.payload_json = json.dumps(payload, ensure_ascii=False)
        db.commit()
    except Exception as exc:
        db.rollback()
        summary["error"] = str(exc)[:200]
    finally:
        db.close()
    return summary
