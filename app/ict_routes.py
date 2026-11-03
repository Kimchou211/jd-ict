"""ICT terminal API: candles, scan (engine + optional AI mentor), tracker trigger."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

from . import ict_engine as engine
from . import news
from . import symbols
from .ai_service import analyze_ict_with_deepseek
from .database import AnalysisRecord, SessionLocal
from .market_data import fetch_candles, fetch_many
from .tracker import run_tracker_once

router = APIRouter(prefix="/api/ict", tags=["ict"])
LATEST_ICT: dict | None = None


def _feed_meta(feed: dict) -> dict:
    return {k: feed.get(k) for k in ("symbol", "tf", "source", "last_bar_time", "age_seconds", "fetched_at", "market_closed", "is_stale", "fallback_reason", "price")}


def _grade(score: int) -> str:
    return "A" if score >= 80 else "B" if score >= 65 else "C" if score >= 50 else "D"


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
async def scan(tf: str = Query(default="M5"), ai: bool = Query(default=True), symbol: str = Query(default="XAUUSD")) -> dict:
    global LATEST_ICT
    if tf not in ("M1", "M5", "M15"):
        raise HTTPException(status_code=400, detail="Entry timeframe must be M1, M5 or M15.")
    try:
        symbol = symbols.normalize(symbol)
        feeds = await fetch_many(["H1", "M15", tf], symbol)
        result = engine.scan({k: v["bars"] for k, v in feeds.items()}, tf, symbol)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"ICT scan failed: {str(exc)[:350]}") from exc

    # News is context, never a gate: a blackout window changes what the UI shows and what the AI is told, not the signal.
    result["news"] = await news.context()
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
    record = AnalysisRecord(
        created_at=created_at, symbol=symbol, tf_primary=tf, tf_secondary="ICT", direction=verdict["final_direction"],
        confidence=float(verdict["final_confidence"]), entry_low=plan["entry_low"] if tradable else None, entry_high=plan["entry_high"] if tradable else None,
        stop_loss=plan["stop"] if tradable else None, take_profit_1=plan["tp1"] if tradable else None, take_profit_2=plan["tp2"] if tradable else None,
        image_primary="", image_secondary="", payload_json=json.dumps(result, ensure_ascii=False))
    saved, err = True, None
    db = SessionLocal()
    try:
        db.add(record)
        db.commit()
        db.refresh(record)
    except Exception as exc:
        db.rollback()
        saved, err = False, str(exc)[:240]
    finally:
        db.close()
    LATEST_ICT = result
    return {"id": record.id if saved else None, "created_at": created_at.isoformat(), "history_saved": saved, "history_error": err,
            "tf_primary": tf, "tf_secondary": "ICT", "analysis": result}


@router.get("/latest")
def latest() -> dict:
    if LATEST_ICT is None:
        raise HTTPException(status_code=404, detail="No ICT scan yet. Press Analyzer first.")
    return {"analysis": LATEST_ICT}


@router.post("/track-now")
async def track_now() -> dict:
    return await run_tracker_once(SessionLocal, AnalysisRecord)
