"""ICT terminal API: candles, scan (engine + optional AI mentor), tracker trigger."""
from __future__ import annotations

import json
import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

from . import ict_engine as engine
from . import news
from . import symbols
from .ai_service import analyze_ict_with_deepseek
from .database import AnalysisRecord, SessionLocal
from .market_data import TFS, fetch_candles
from .tracker import run_tracker_once

router = APIRouter(prefix="/api/ict", tags=["ict"])
LATEST_ICT: dict | None = None


def _feed_meta(feed: dict) -> dict:
    return {k: feed.get(k) for k in ("symbol", "tf", "source", "last_bar_time", "age_seconds", "fetched_at", "market_closed",
                                     "is_stale", "fallback_reason", "price", "missing_candle_count", "historical_coverage",
                                     "aggregation_source", "data_quality_status", "duplicate_candle_count", "out_of_order_candle_count")}


def _grade(score: int) -> str:
    return "A" if score >= 80 else "B" if score >= 65 else "C" if score >= 50 else "D"


def _attach_setup_history(result: dict, previous: dict | None) -> None:
    history = list((previous or {}).get("setup_lifecycle_history", []))
    last_state = {}
    for event in history:
        last_state[event["setup_id"]] = event["lifecycle"]

    current_ids = set()
    for setup in result["setups"]:
        setup_id = setup["id"]
        current_ids.add(setup_id)
        lifecycle = setup["lifecycle"]
        if last_state.get(setup_id) != lifecycle:
            history.append({"setup_id": setup_id, "opportunity_id": setup["opportunity_id"],
                            "lifecycle": lifecycle, "observed_at_ms": result["time_ms"]})
            last_state[setup_id] = lifecycle

    previous_setups = (previous or {}).get("setups", [])
    for setup in previous_setups:
        setup_id = setup.get("id")
        if not setup_id or setup_id in current_ids or setup.get("lifecycle") in (
            "TARGET_REACHED", "INVALIDATED", "EXPIRED",
        ):
            continue
        plan = setup.get("plan") or {}
        price = result["price"]
        direction = setup.get("direction")
        state = setup.get("lifecycle")
        if result["time_ms"] >= plan.get("valid_until_ms", float("inf")):
            state = "EXPIRED"
        elif direction == "bull" and price <= plan.get("stop", float("-inf")):
            state = "INVALIDATED"
        elif direction == "bear" and price >= plan.get("stop", float("inf")):
            state = "INVALIDATED"
        elif direction == "bull" and price >= plan.get("tp1", float("inf")):
            state = "TARGET_REACHED"
        elif direction == "bear" and price <= plan.get("tp1", float("-inf")):
            state = "TARGET_REACHED"
        if state != last_state.get(setup_id):
            history.append({"setup_id": setup_id, "opportunity_id": setup.get("opportunity_id"),
                            "lifecycle": state, "observed_at_ms": result["time_ms"]})
            last_state[setup_id] = state

    result["setup_lifecycle_history"] = history[-2000:]
    events_by_setup = {}
    for event in result["setup_lifecycle_history"]:
        events_by_setup.setdefault(event["setup_id"], []).append(event)
    for setup in result["setups"]:
        setup["lifecycle_history"] = events_by_setup.get(setup["id"], [])[-50:]


@router.get("/candles")
async def candles(tf: str = Query(default="M5"), symbol: str = Query(default="XAUUSD")) -> dict:
    try:
        feed = await fetch_candles(tf, symbol=symbol)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Candle feed unavailable: {str(exc)[:350]}") from exc
    return {"feed": _feed_meta(feed), "bars": feed["bars"][-300:]}


@router.post("/scan")
async def scan(
    tf: str = Query(default="M5"),
    ai: bool = Query(default=True),
    symbol: str = Query(default="XAUUSD"),
    direction: str | None = Query(default=None),
    model: str | None = Query(default=None),
    timeframe: str | None = Query(default=None),
    status: str | None = Query(default=None),
    min_score: float | None = Query(default=None, ge=0, le=100),
) -> dict:
    global LATEST_ICT
    if tf not in TFS:
        raise HTTPException(status_code=400, detail="Unsupported entry timeframe. Use M1, M5, M15, H1, H4, D1 or W1.")
    try:
        symbol = symbols.normalize(symbol)
        frames = engine.SPEC["scanner"]["coverage_timeframes"]
        fetched = await asyncio.gather(
            *(fetch_candles(frame, symbol=symbol) for frame in frames),
            return_exceptions=True,
        )
        feeds, data_warnings = {}, []
        for frame, feed in zip(frames, fetched):
            if isinstance(feed, Exception):
                if frame == tf:
                    raise feed
                data_warnings.append(f"{frame} timeframe unavailable: {str(feed)[:160]}")
            else:
                feeds[frame] = feed
        if direction and direction.upper() not in ("BUY", "SELL", "WAIT"):
            raise ValueError("direction filter must be BUY, SELL or WAIT.")
        if model and model.upper() not in {entry["id"] for entry in engine.SPEC["scanner"]["models"]}:
            raise ValueError("Unknown ICT model filter.")
        if timeframe and timeframe.upper() not in TFS:
            raise ValueError("Unknown ICT timeframe filter.")
        if status and status.upper() not in {
            "DETECTED", "FORMING", "WAITING_FOR_CONFIRMATION", "CONFIRMED", "WAITING_FOR_RETRACE",
            "ENTRY_READY", "ACTIVE", "TARGET_REACHED", "INVALIDATED", "EXPIRED",
        }:
            raise ValueError("Unknown setup lifecycle status filter.")
        filters = {key: value for key, value in {
            "direction": direction, "model": model, "timeframe": timeframe, "status": status, "min_score": min_score,
        }.items() if value is not None}
        result = engine.scan({k: v["bars"] for k, v in feeds.items()}, tf, symbol, filters)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"ICT scan failed: {str(exc)[:350]}") from exc

    # News is context, never a gate: a blackout window changes what the UI shows and what the AI is told, not the signal.
    result["news"] = await news.context()
    result["data_warnings"] = data_warnings
    ltf_feed = feeds[tf]
    feed_ok = not ltf_feed["is_stale"] and not ltf_feed["market_closed"]
    review = validation = None
    if ai:
        review = await analyze_ict_with_deepseek(result, ltf_feed["bars"])
        if review.get("ok"):
            validation = engine.validate_ai_review(review, result)
    verdict = engine.combine_verdict(result, review, validation, feed_ok)
    result.update(verdict)
    result.update(engine_direction=result["direction"], feed=_feed_meta(ltf_feed), ai_review=review, ai_validation=validation, ict_scan=True,
                  signal_grade=_grade(verdict["final_confidence"]), scan_source="ict_engine" + ("+deepseek" if review and review.get("ok") else ""))
    result["feeds"] = {k: _feed_meta(v) for k, v in feeds.items()}
    result["bars"] = ltf_feed["bars"][-160:]
    plan = result.get("plan")
    tradable = verdict["final_direction"] in ("BUY", "SELL") and plan
    if tradable:
        result["ict_plan"] = plan
        result["ict_track"] = {"state": "PENDING"}
    created_at = datetime.now(timezone.utc)
    record = None
    saved, err = True, None
    db = SessionLocal()
    try:
        previous_record = (db.query(AnalysisRecord).filter(
            AnalysisRecord.symbol == symbol, AnalysisRecord.tf_secondary == "ICT",
        ).order_by(AnalysisRecord.id.desc()).first())
        previous = None
        if previous_record:
            try:
                previous = json.loads(previous_record.payload_json)
            except json.JSONDecodeError:
                data_warnings.append("Previous scan lifecycle history was invalid and could not be reused.")
                result["data_warnings"] = data_warnings
        _attach_setup_history(result, previous)
        record = AnalysisRecord(
            created_at=created_at, symbol=symbol, tf_primary=tf, tf_secondary="ICT", direction=verdict["final_direction"],
            confidence=float(verdict["final_confidence"]), entry_low=plan["entry_low"] if tradable else None, entry_high=plan["entry_high"] if tradable else None,
            stop_loss=plan["stop"] if tradable else None, take_profit_1=plan["tp1"] if tradable else None, take_profit_2=plan["tp2"] if tradable else None,
            image_primary="", image_secondary="", payload_json=json.dumps(result, ensure_ascii=False))
        db.add(record)
        db.commit()
        db.refresh(record)
    except Exception as exc:
        db.rollback()
        saved, err = False, str(exc)[:240]
    finally:
        db.close()
    LATEST_ICT = result
    return {"id": record.id if saved and record else None, "created_at": created_at.isoformat(), "history_saved": saved, "history_error": err,
            "tf_primary": tf, "tf_secondary": "ICT", "analysis": result}


@router.get("/latest")
def latest() -> dict:
    if LATEST_ICT is None:
        raise HTTPException(status_code=404, detail="No ICT scan yet. Press Analyzer first.")
    return {"analysis": LATEST_ICT}


@router.post("/track-now")
async def track_now() -> dict:
    return await run_tracker_once(SessionLocal, AnalysisRecord)
