import asyncio
import base64
import io
import json
import secrets
import uuid
import time
from typing import Any, Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Generator

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Depends, Query
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session
from sqlalchemy import text

from .config import (APP_NAME, STATIC_DIR, UPLOAD_DIR, MAX_UPLOAD_MB, GEMINI_API_KEY, DEEPSEEK_API_KEY, FORCE_SIGNAL,
                     IMAGE_FORCE_SIGNAL, ICT_MIN_SCORE, APP_USER, APP_PASSWORD, TWELVEDATA_API_KEY, AUTO_TRACK, AUTO_TRACK_SECONDS)
from .database import Base, engine, SessionLocal, AnalysisRecord
from .ai_service import analyze_images, chat_with_deepseek, analyze_live_market_with_deepseek, chat_with_live_market
from .live_market import fetch_live_market, calculate_live_scan
from .trade_engine import build_trade_read
from .schemas import ChatRequest, OutcomeRequest
from . import ict_routes, news_routes, symbols
from .tracker import run_tracker_once
from . import ict_engine
from .market_data import TFS, fetch_candles

IMAGE_ANALYSIS_SPEC = json.loads((Path(__file__).resolve().parent.parent / "shared" / "image-analysis-spec.json").read_text(encoding="utf-8"))

app = FastAPI(title=APP_NAME, version="2.0.0", description="XAUUSD live market terminal, ICT engine + AI mentor, and separate screenshot chart analyzer")
app.include_router(ict_routes.router)
app.include_router(news_routes.router)


@app.middleware("http")
async def optional_login(request, call_next):
    """HTTP Basic login for the whole app, active only when APP_PASSWORD is set in .env."""
    if not APP_PASSWORD:
        return await call_next(request)
    header = request.headers.get("authorization", "")
    ok = False
    if header.lower().startswith("basic "):
        try:
            user, _, password = base64.b64decode(header[6:]).decode("utf-8").partition(":")
            ok = secrets.compare_digest(user, APP_USER) and secrets.compare_digest(password, APP_PASSWORD)
        except Exception:
            ok = False
    if not ok:
        return Response("Login required", status_code=401, headers={"WWW-Authenticate": 'Basic realm="JD ANALYSIS"'})
    return await call_next(request)

# The live terminal state is isolated from screenshot-analysis state. It is a convenience
# cache for chat context only; the persisted journal remains the source for signal history.
LATEST_LIVE_SCAN: dict | None = None
LATEST_LIVE_MARKET: dict | None = None
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

@app.on_event("startup")
def startup() -> None:
    try:
        Base.metadata.create_all(bind=engine)
    except Exception as exc:
        # Keep the dashboard available when Neon is unreachable; health/history will show the DB issue.
        print(f"[JD ANALYSIS] Database initialization failed: {str(exc)[:300]}")
    if AUTO_TRACK:
        asyncio.create_task(_tracker_loop())


async def _tracker_loop() -> None:
    """Background: close open ICT plans automatically when price hits their SL / TP."""
    while True:
        await asyncio.sleep(max(30, AUTO_TRACK_SECONDS))
        try:
            await run_tracker_once(SessionLocal, AnalysisRecord)
        except Exception as exc:  # never let the loop die
            print(f"[JD ANALYSIS] tracker error: {str(exc)[:200]}")

def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def _load_image(
    upload: UploadFile,
    raw: bytes,
    analysis_raw: bytes | None = None,
    preparation: dict | None = None,
) -> tuple[str, dict, dict]:
    if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Each image must be under {MAX_UPLOAD_MB} MB.")
    try:
        with Image.open(io.BytesIO(raw)) as source:
            if source.format not in {"PNG", "JPEG", "WEBP"}:
                raise HTTPException(status_code=415, detail="Use PNG, JPG/JPEG or WEBP chart screenshots.")
            source.verify()
        with Image.open(io.BytesIO(raw)) as source:
            image = ImageOps.exif_transpose(source)
            source_width, source_height = image.size
            if source_width < IMAGE_ANALYSIS_SPEC["normalization"]["minimum_width"] or source_height < IMAGE_ANALYSIS_SPEC["normalization"]["minimum_height"]:
                raise HTTPException(status_code=400, detail="The chart image is too small. Upload at least 320×200 pixels.")
            image_format = source.format
        ext = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}[image_format]
        filename = f"{uuid.uuid4().hex}.{ext}"

        warnings = []
        ratio = source_width / source_height
        policy = IMAGE_ANALYSIS_SPEC["normalization"]
        unusual_ratio = ratio < policy["unusual_aspect_ratio_below"] or ratio > policy["unusual_aspect_ratio_above"]
        if unusual_ratio:
            warnings.append("Unusual image aspect ratio; chart visibility should be reviewed.")

        if analysis_raw:
            if len(analysis_raw) > MAX_UPLOAD_MB * 1024 * 1024:
                raise HTTPException(status_code=413, detail=f"Each normalized image must be under {MAX_UPLOAD_MB} MB.")
            with Image.open(io.BytesIO(analysis_raw)) as normalized:
                if normalized.format != "JPEG":
                    raise HTTPException(status_code=415, detail="Normalized analysis images must be JPEG.")
                normalized.verify()
            with Image.open(io.BytesIO(analysis_raw)) as normalized:
                normalized_width, normalized_height = normalized.size
                if (normalized_width < policy["minimum_width"] or normalized_height < policy["minimum_height"]
                    or max(normalized_width, normalized_height) > policy["max_dimension"]):
                    raise HTTPException(status_code=400, detail="Normalized image dimensions do not match the shared preparation policy.")
                if abs((normalized_width / normalized_height) - ratio) > max(0.01, ratio * 0.02):
                    raise HTTPException(status_code=400, detail="Normalized image aspect ratio changed; stretched images are not accepted.")
            payload_bytes = analysis_raw
            mode = "browser_canvas" if (preparation or {}).get("mode") == "browser_canvas" else "provided_normalized_image"
        else:
            with Image.open(io.BytesIO(raw)) as source:
                image = ImageOps.exif_transpose(source)
                if image.mode in ("RGBA", "LA") or "transparency" in image.info:
                    rgba = image.convert("RGBA")
                    background = Image.new("RGB", rgba.size, policy["background"])
                    background.paste(rgba, mask=rgba.getchannel("A"))
                    image = background
                else:
                    image = image.convert("RGB")
                image.thumbnail((policy["max_dimension"], policy["max_dimension"]), Image.Resampling.LANCZOS)
                stream = io.BytesIO()
                image.save(stream, "JPEG", quality=round(policy["jpeg_quality"] * 100), optimize=True)
                payload_bytes = stream.getvalue()
                normalized_width, normalized_height = image.size
            mode = "server_fallback"
            warnings.append("Browser-normalized analysis image was not provided; server fallback normalization was used.")

        metadata = {
            "mode": mode,
            "source_format": image_format,
            "source_width": source_width,
            "source_height": source_height,
            "source_bytes": len(raw),
            "normalized_format": "image/jpeg",
            "normalized_width": normalized_width,
            "normalized_height": normalized_height,
            "normalized_bytes": len(payload_bytes),
            "aspect_ratio": round(ratio, 5),
            "unusual_aspect_ratio": unusual_ratio,
            "orientation_applied": True,
            "blur_risk": (preparation or {}).get("blur_risk", "unavailable"),
            "glare_risk": (preparation or {}).get("glare_risk", "not_assessed"),
            "crop_risk": (preparation or {}).get("crop_risk", "not_assessed"),
            "exif_orientation": (preparation or {}).get("exif_orientation"),
            "color_space": (preparation or {}).get("color_space", policy["color_space"]),
            "browser_quality": preparation or {},
            "decode_verified": True,
            "warnings": warnings,
        }
        (UPLOAD_DIR / filename).write_bytes(raw)
        return filename, {"mime_type": "image/jpeg", "base64": base64.b64encode(payload_bytes).decode("ascii")}, metadata
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise HTTPException(status_code=415, detail="That file is not a readable chart image.") from exc


class AnalysisProgress:
    def __init__(self, send: Callable[[dict], Awaitable[None]] | None = None):
        self.stages: list[dict] = []
        self.current: dict | None = None
        self.started = 0.0
        self.send = send

    async def start(self, stage_id: str, inputs: dict) -> None:
        stage_spec = next(item for item in IMAGE_ANALYSIS_SPEC["stages"] if item["id"] == stage_id)
        self.current = {
            "id": stage_id, "name": stage_spec["name"], "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat(), "duration_ms": None,
            "input": inputs, "output": None, "error": None,
        }
        self.started = time.perf_counter()
        self.stages.append(self.current)
        if self.send:
            await self.send({"type": "stage", "stage": dict(self.current)})

    async def finish(self, output: dict) -> None:
        if self.current is None:
            return
        self.current.update(status="complete", duration_ms=round((time.perf_counter() - self.started) * 1000, 2), output=output)
        if self.send:
            await self.send({"type": "stage", "stage": dict(self.current)})
        self.current = None

    async def fail(self, error: Exception) -> None:
        if self.current is None:
            return
        self.current.update(status="failed", duration_ms=round((time.perf_counter() - self.started) * 1000, 2), error=str(error)[:350])
        if self.send:
            await self.send({"type": "stage", "stage": dict(self.current)})
        self.current = None

@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> Response:
    # No custom icon asset is required; return an empty response instead of a noisy 404.
    return Response(status_code=204)

@app.get("/api/health")
def health(db: Session = Depends(get_db)) -> dict:
    database = "connected"
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        database = "offline"
    return {"app": APP_NAME, "database": database,
            "providers": {"gemini_configured": bool(GEMINI_API_KEY), "deepseek_configured": bool(DEEPSEEK_API_KEY), "twelvedata_configured": bool(TWELVEDATA_API_KEY)},
            "auth_enabled": bool(APP_PASSWORD), "auto_track": AUTO_TRACK,
            "mode": "live-market-and-image-analysis", "symbol": "XAUUSD", "symbols": list(symbols.PROFILES),
            "force_signal": FORCE_SIGNAL, "image_force_signal": IMAGE_FORCE_SIGNAL,
            "live_market_provider": ("Twelve Data with Yahoo Finance fallback" if TWELVEDATA_API_KEY
                                     else "Yahoo Finance XAUUSD=X"), "live_terminal": True}




@app.get("/api/image-analysis-spec")
def image_analysis_spec() -> dict:
    return IMAGE_ANALYSIS_SPEC


async def _run_image_analysis(
    primary_image: UploadFile,
    secondary_image: UploadFile,
    tf_primary: str,
    tf_secondary: str,
    symbol: str,
    primary_analysis_image: UploadFile | None,
    secondary_analysis_image: UploadFile | None,
    image_preparation: str,
    db: Session,
    progress: AnalysisProgress,
) -> dict:
    try:
        symbol = symbols.normalize(symbol)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    allowed_tfs = {"M1", "M2", "M3", "M5", "M10", "M15", "M30", "H1", "H2", "H4", "D1", "W1", "MN1"}
    tf_primary, tf_secondary = tf_primary.upper(), tf_secondary.upper()
    if tf_primary not in allowed_tfs or tf_secondary not in allowed_tfs or tf_primary == tf_secondary:
        raise HTTPException(status_code=400, detail="Choose two different supported timeframes.")

    try:
        preparation = json.loads(image_preparation) if image_preparation else {}
        if not isinstance(preparation, list) or len(preparation) != 2:
            preparation = [{}, {}]
        await progress.start("image_intake", {"symbol": symbol, "timeframes": [tf_primary, tf_secondary]})
        raw_1, raw_2 = await primary_image.read(), await secondary_image.read()
        if not raw_1 or not raw_2:
            raise HTTPException(status_code=400, detail="Upload both timeframe screenshots before analyzing.")
        normalized_1 = await primary_analysis_image.read() if primary_analysis_image else None
        normalized_2 = await secondary_analysis_image.read() if secondary_analysis_image else None
        name_1, image_1, quality_1 = _load_image(primary_image, raw_1, normalized_1, preparation[0])
        name_2, image_2, quality_2 = _load_image(secondary_image, raw_2, normalized_2, preparation[1])
        image_quality = [quality_1, quality_2]
        await progress.finish({"images": image_quality, "originals_preserved": True})

        await progress.start("visual_extraction", {"providers": ["Gemini", "DeepSeek"], "image_count": 2})
        try:
            ai_results = await analyze_images([image_1, image_2], tf_primary, tf_secondary, symbol)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        provider_results = ai_results.get("provider_results", [])
        provider_errors = ai_results.get("provider_errors", {})
        if not provider_results:
            errors = " | ".join(f"{key}: {value}" for key, value in provider_errors.items())
            raise HTTPException(status_code=502, detail="All configured AI providers failed. " + (errors or "Check API keys/model names."))
        visual_quality = []
        for index, timeframe in enumerate((tf_primary, tf_secondary)):
            observations = []
            for result in provider_results:
                reads = result.get("chart_reads")
                read = reads[index] if isinstance(reads, list) and len(reads) > index and isinstance(reads[index], dict) else {}
                observations.append({
                    "provider": str(result.get("provider", "unknown")),
                    **{field: read.get(field) for field in (
                        "symbol_header_visible", "timeframe_label_visible", "chart_area_visibility",
                        "price_axis_visibility", "indicator_panel_visibility", "glare", "rotated",
                        "cropped", "blur_risk",
                    )},
                })
            visual_quality.append({"timeframe": timeframe, "observations": observations})
        await progress.finish({
            "providers_succeeded": [str(item.get("provider", "unknown")) for item in provider_results],
            "provider_errors": provider_errors,
            "chart_reads": sum(len(item.get("chart_reads", [])) for item in provider_results),
            "visual_quality": visual_quality,
        })

        await progress.start("chart_reconstruction", {"timeframes": [tf_primary, tf_secondary]})
        reconstruction = []
        for index, timeframe in enumerate((tf_primary, tf_secondary)):
            reads = [
                (result.get("chart_reads") or [])[index]
                for result in provider_results
                if isinstance(result.get("chart_reads"), list) and len(result["chart_reads"]) > index
            ]
            reconstruction.append({
                "timeframe": timeframe,
                "readable_price_labels": [
                    read.get("current_price") for read in reads
                    if read.get("current_price_readable") is True and isinstance(read.get("current_price"), (int, float))
                ],
                "axis_scale": [
                    {"top": read.get("price_scale_top"), "bottom": read.get("price_scale_bottom"),
                     "readable": read.get("price_scale_readable") is True}
                    for read in reads
                ],
                "reconstructed_ohlc": None,
                "missing_data": ["OHLC candles are not reconstructed from screenshot pixels; use validated market-feed candles."],
            })
        await progress.finish({"charts": reconstruction})

        await progress.start("live_verification", {"requested_timeframes": [tf_primary, tf_secondary]})
        supported_frames = [tf for tf in dict.fromkeys((tf_primary, tf_secondary)) if tf in TFS]
        fetches = await asyncio.gather(
            *(fetch_candles(tf, symbol=symbol) for tf in supported_frames),
            return_exceptions=True,
        )
        feeds, feed_errors = {}, {}
        for timeframe, result in zip(supported_frames, fetches):
            if isinstance(result, Exception):
                feed_errors[timeframe] = str(result)[:260]
            else:
                feeds[timeframe] = result
        comparisons = []
        profile = symbols.profile(symbol)
        for index, timeframe in enumerate((tf_primary, tf_secondary)):
            feed = feeds.get(timeframe)
            screenshot_values = [
                (result.get("chart_reads") or [])[index]
                for result in provider_results
                if isinstance(result.get("chart_reads"), list) and len(result["chart_reads"]) > index
            ]
            screenshot_price = next((
                float(read["current_price"]) for read in screenshot_values
                if read.get("current_price_readable") is True
                and isinstance(read.get("current_price"), (int, float))
            ), None)
            live_price = float(feed["price"]) if feed else None
            if not feed:
                comparison = "feed_unavailable"
            elif screenshot_price is None:
                comparison = "screenshot_quote_unreadable"
            elif abs(screenshot_price - live_price) <= max(profile["price_abs"], live_price * profile["price_pct"]):
                comparison = "match"
            else:
                comparison = "mismatch"
            comparisons.append({
                "timeframe": timeframe, "status": comparison, "screenshot_price": screenshot_price,
                "live_price": live_price, "feed_timestamp": feed.get("last_bar_time") if feed else None,
                "feed_source": feed.get("source") if feed else None,
                "is_stale": feed.get("is_stale") if feed else None,
                "market_closed": feed.get("market_closed") if feed else None,
                "data_quality_status": feed.get("data_quality_status") if feed else None,
            })
        market_verification = {
            "available": len(feeds) == 2,
            "feeds": comparisons,
            "errors": feed_errors,
            "warning": "Screenshot prices are visual reads; live prices come only from the stated candle feed.",
        }
        await progress.finish(market_verification)

        await progress.start("ict_evaluation", {"entry_timeframe": tf_primary, "minimum_score": ICT_MIN_SCORE})
        market_scan = None
        scan_error = None
        if tf_primary not in feeds:
            scan_error = feed_errors.get(tf_primary, "Entry timeframe is unsupported by the configured market-data providers.")
        elif len(feeds[tf_primary]["bars"]) < ict_engine.SPEC["scanner"]["minimum_candles"]:
            scan_error = f"Not enough completed {tf_primary} candles for a validated ICT scan."
        else:
            try:
                market_scan = ict_engine.scan(
                    {tf: feed["bars"] for tf, feed in feeds.items()},
                    tf_primary,
                    symbol,
                )
            except (ValueError, RuntimeError) as exc:
                scan_error = str(exc)[:260]
        await progress.finish({
            "status": "scanned" if market_scan else "unavailable",
            "candidate_count": len(market_scan.get("setups", [])) if market_scan else 0,
            "selected_setup": market_scan.get("selected") if market_scan else None,
            "direction": market_scan.get("direction", "WAIT") if market_scan else "WAIT",
            "error": scan_error,
            "source": "completed market-feed candles; deterministic ICT engine",
        })

        await progress.start("final_report", {"annotation_source": "visual evidence only", "trade_levels_source": "validated market candles only"})
        analysis = build_trade_read(provider_results, provider_errors, tf_primary, tf_secondary, symbol)
        candidate = None
        if market_scan and market_scan.get("selected"):
            candidate = next((setup for setup in market_scan["setups"]
                              if setup.get("id") == market_scan["selected"]
                              and setup.get("timeframe") == tf_primary), None)
        feed_quality_ok = all(
            timeframe in feeds
            and not feeds[timeframe]["is_stale"]
            and not feeds[timeframe]["market_closed"]
            and feeds[timeframe]["data_quality_status"] == "GOOD"
            for timeframe in (tf_primary, tf_secondary)
        )
        normalization_ok = all(item["mode"] == "browser_canvas" for item in image_quality)
        quote_mismatch = any(item["status"] == "mismatch" for item in comparisons)
        detected_other_symbol = any(
            read.get("symbol_detected") not in (None, "", "unknown", symbol)
            and not symbols.matches(str(read.get("symbol_detected")), symbol)
            for result in provider_results
            for read in (result.get("chart_reads") or [])
        )
        trade_ready = bool(candidate and feed_quality_ok and normalization_ok and not quote_mismatch and not detected_other_symbol)
        plan = candidate.get("plan") if trade_ready and candidate else None
        direction = candidate.get("action", "WAIT") if trade_ready and candidate else "WAIT"
        analysis.update({
            "symbol": symbol,
            "mode": "LIVE_MARKET_VERIFIED" if len(feeds) == 2 else "IMAGE_ONLY",
            "direction": direction,
            "model_bias": direction,
            "trade_ready": trade_ready,
            "forced_signal": False,
            "force_signal_used": False,
            "levels_available": bool(plan),
            "signal_status": "ICT_SETUP_VALIDATED" if trade_ready else "WAIT_FOR_CONFIRMATION",
            "entry_price": plan.get("entry") if plan else None,
            "entry_low": plan.get("entry_low") if plan else None,
            "entry_high": plan.get("entry_high") if plan else None,
            "stop_loss": plan.get("stop") if plan else None,
            "take_profit_1": plan.get("tp1") if plan else None,
            "take_profit_2": plan.get("tp2") if plan else None,
            "atr_method": "No ATR-derived plan. Entry, structural invalidation and liquidity targets come from a validated ICT setup on completed market candles.",
            "price_source": "Live candle feed" if plan else "Screenshot values are not live quotes.",
            "market_verification": market_verification,
            "market_ict_scan": {
                "candidate_count": len(market_scan.get("setups", [])) if market_scan else 0,
                "selected_setup": candidate,
                "error": scan_error,
                "trade_blockers": [
                    *(["market feed is stale, closed, missing, or degraded"] if not feed_quality_ok else []),
                    *(["images were not prepared by the shared browser normalizer"] if not normalization_ok else []),
                    *(["screenshot quote does not match the live candle"] if quote_mismatch else []),
                    *(["image symbol conflicts with the user-selected symbol"] if detected_other_symbol else []),
                    *(["no valid ICT setup on the selected entry timeframe"] if not candidate else []),
                ],
            },
            "pipeline_stages": progress.stages,
            "force_settings": {"live_terminal_force_signal": FORCE_SIGNAL, "image_force_signal": IMAGE_FORCE_SIGNAL},
        })
        if plan:
            analysis["confidence"] = candidate.get("score", 0)
            analysis["setup_rationale"] = "Validated market-candle ICT setup: " + "; ".join(candidate.get("reasons", []))
            for read in analysis.get("chart_reads", []):
                scale = read.get("price_scale", {})
                if scale.get("verified"):
                    for label, value in (("ENTRY", plan["entry"]), ("SL", plan["stop"]), ("TP1", plan["tp1"]), ("TP2", plan["tp2"])):
                        if scale["bottom"] <= value <= scale["top"]:
                            read.setdefault("annotations", []).append({"type": "price_line", "price": value, "label": f"{label} {value:.2f}"})
        else:
            analysis["risk_notes"] = list(dict.fromkeys([
                *analysis.get("risk_notes", []),
                "No actionable trade levels were issued. Review the pipeline stage outputs and trade blockers.",
            ]))
        analysis["provider_errors"] = provider_errors
        analysis["chart_reconstruction"] = reconstruction
        analysis["live_feeds"] = comparisons

        record = AnalysisRecord(
            created_at=datetime.now(timezone.utc), symbol=symbol, tf_primary=tf_primary, tf_secondary=tf_secondary,
            direction=analysis["direction"], confidence=float(analysis.get("confidence", 0)),
            entry_low=analysis.get("entry_low"), entry_high=analysis.get("entry_high"), stop_loss=analysis.get("stop_loss"),
            take_profit_1=analysis.get("take_profit_1"), take_profit_2=analysis.get("take_profit_2"),
            image_primary=name_1, image_secondary=name_2, payload_json=json.dumps(analysis, ensure_ascii=False),
        )
        history_saved, history_error = True, None
        try:
            db.add(record)
            db.commit()
            db.refresh(record)
        except Exception as exc:
            db.rollback()
            history_saved, history_error = False, str(exc)[:300]
        await progress.finish({"decision": direction, "trade_ready": trade_ready, "history_saved": history_saved})
        analysis["pipeline_stages"] = progress.stages
        if history_saved:
            record.payload_json = json.dumps(analysis, ensure_ascii=False)
            try:
                db.commit()
            except Exception:
                db.rollback()
                history_saved = False
                history_error = "Analysis was saved, but its final stage metadata could not be updated."
        return {
            "id": record.id if history_saved else None,
            "created_at": record.created_at.isoformat(),
            "symbol": symbol,
            "tf_primary": tf_primary,
            "tf_secondary": tf_secondary,
            "direction": analysis["direction"],
            "confidence": analysis.get("confidence", 0),
            "entry_low": analysis.get("entry_low"),
            "entry_high": analysis.get("entry_high"),
            "stop_loss": analysis.get("stop_loss"),
            "take_profit_1": analysis.get("take_profit_1"),
            "take_profit_2": analysis.get("take_profit_2"),
            "image_primary": name_1,
            "image_secondary": name_2,
            "image_primary_url": f"/uploads/{name_1}",
            "image_secondary_url": f"/uploads/{name_2}",
            "history_saved": history_saved,
            "history_error": history_error,
            "analysis": analysis,
        }
    except Exception as exc:
        await progress.fail(exc)
        raise


@app.post("/api/analyze")
async def analyze(
    primary_image: UploadFile = File(...),
    secondary_image: UploadFile = File(...),
    tf_primary: str = Form("M1"),
    tf_secondary: str = Form("M5"),
    symbol: str = Form("XAUUSD"),
    primary_analysis_image: UploadFile | None = File(default=None),
    secondary_analysis_image: UploadFile | None = File(default=None),
    image_preparation: str = Form("[]"),
    db: Session = Depends(get_db),
) -> dict:
    return await _run_image_analysis(
        primary_image, secondary_image, tf_primary, tf_secondary, symbol,
        primary_analysis_image, secondary_analysis_image, image_preparation, db, AnalysisProgress(),
    )


@app.post("/api/analyze/stream")
async def analyze_stream(
    primary_image: UploadFile = File(...),
    secondary_image: UploadFile = File(...),
    tf_primary: str = Form("M1"),
    tf_secondary: str = Form("M5"),
    symbol: str = Form("XAUUSD"),
    primary_analysis_image: UploadFile | None = File(default=None),
    secondary_analysis_image: UploadFile | None = File(default=None),
    image_preparation: str = Form("[]"),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    async def events():
        queue: asyncio.Queue[dict | None] = asyncio.Queue()

        async def send(event: dict) -> None:
            await queue.put(event)

        async def run() -> None:
            try:
                result = await _run_image_analysis(
                    primary_image, secondary_image, tf_primary, tf_secondary, symbol,
                    primary_analysis_image, secondary_analysis_image, image_preparation, db, AnalysisProgress(send),
                )
                await queue.put({"type": "complete", "data": result})
            except HTTPException as exc:
                await queue.put({"type": "error", "status": exc.status_code, "detail": exc.detail})
            except Exception as exc:
                await queue.put({"type": "error", "status": 500, "detail": str(exc)[:350]})
            finally:
                await queue.put(None)

        task = asyncio.create_task(run())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

@app.get("/api/live-market")
async def live_market(interval: str = Query(default="1m")) -> dict:
    """Return quote-provider candles and a transparent indicator snapshot for the live terminal."""
    global LATEST_LIVE_MARKET
    try:
        market = await fetch_live_market(interval)
        scan = calculate_live_scan(market)
        LATEST_LIVE_MARKET = scan
        return scan
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Live market data unavailable: {str(exc)[:350]}") from exc


@app.post("/api/live-analyze")
async def live_analyze(interval: str = Query(default="1m"), db: Session = Depends(get_db)) -> dict:
    """Explicitly scan the independent live feed, optionally obtain an AI review, then journal it."""
    global LATEST_LIVE_SCAN, LATEST_LIVE_MARKET
    try:
        market = await fetch_live_market(interval)
        scan = calculate_live_scan(market)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Live market data unavailable: {str(exc)[:350]}") from exc

    scan["technical_direction"] = scan.get("direction", "WAIT")
    review = await analyze_live_market_with_deepseek(scan)
    scan["ai_review"] = review
    if review.get("ok"):
        ai_direction = review.get("direction", "WAIT")
        if ai_direction == scan["technical_direction"]:
            scan["confluence_status"] = "AI_AND_TECHNICAL_ALIGNED"
            scan["scan_source"] = "deepseek_plus_technical_scan"
        else:
            scan["confluence_status"] = "AI_TECHNICAL_CONFLICT"
            scan["direction"] = "WAIT"
            scan["action"] = "WAIT_FOR_CONFIRMATION"
            scan["setup_rationale"] = (scan.get("setup_rationale", "") + f"; AI review ({ai_direction}) conflicts with the technical scan ({scan['technical_direction']}); waiting for confirmation.").strip("; ")
    else:
        scan["confluence_status"] = "TECHNICAL_ONLY"
        scan["scan_source"] = "rule_based_technical_scan"
    LATEST_LIVE_SCAN = scan
    LATEST_LIVE_MARKET = scan

    created_at = datetime.now(timezone.utc)
    record = AnalysisRecord(
        created_at=created_at, symbol="XAUUSD", tf_primary=scan.get("feed", {}).get("timeframe", "M1"),
        tf_secondary="LIVE", direction=scan.get("direction", "WAIT"),
        confidence=float(scan.get("confidence", 0)), entry_low=scan.get("entry_low"), entry_high=scan.get("entry_high"),
        stop_loss=scan.get("stop_loss"), take_profit_1=scan.get("take_profit_1"), take_profit_2=scan.get("take_profit_2"),
        image_primary="", image_secondary="", payload_json=json.dumps(scan, ensure_ascii=False),
    )
    history_saved = True
    history_error = None
    try:
        db.add(record)
        db.commit()
        db.refresh(record)
    except Exception as exc:
        db.rollback()
        history_saved = False
        history_error = str(exc)[:260]
    return {"id": record.id if history_saved else None, "created_at": created_at.isoformat(),
            "tf_primary": scan.get("feed", {}).get("timeframe", "M1"), "tf_secondary": "LIVE",
            "history_saved": history_saved, "history_error": history_error, "analysis": scan}


@app.post("/api/live-chat")
async def live_chat(request: ChatRequest) -> dict:
    """Chat in the live terminal, using its latest real quote/indicator context—not uploaded images."""
    global LATEST_LIVE_SCAN, LATEST_LIVE_MARKET
    context = LATEST_LIVE_MARKET or LATEST_LIVE_SCAN
    if context is not None and LATEST_LIVE_SCAN is not None:
        context = dict(context)
        saved = LATEST_LIVE_SCAN
        context["latest_analyzer_scan"] = {key: saved.get(key) for key in (
            "direction", "technical_direction", "action", "entry_low", "entry_high", "stop_loss",
            "take_profit_1", "take_profit_2", "confluence_status", "ai_review",
        )} | {"feed_time": (saved.get("feed") or {}).get("last_bar_time")}
    if ict_routes.LATEST_ICT is not None:
        ict = ict_routes.LATEST_ICT
        context = dict(context or {})
        context["ict_scan"] = {k: ict.get(k) for k in ("ltf", "price", "session", "bias", "pd", "crt", "setups", "level_table", "engine_direction",
                                                      "final_direction", "final_confidence", "verdict_status", "plan", "plan_status", "reasons", "ai_review", "feed")}
    if context is None:
        try:
            context = calculate_live_scan(await fetch_live_market("1m"))
            LATEST_LIVE_MARKET = context
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Live market context is unavailable: {str(exc)[:300]}") from exc
    try:
        answer = await chat_with_live_market(request.message, context)
        return {"answer": answer, "provider": "DeepSeek", "context": "live-market-terminal", "feed_time": context.get("feed", {}).get("last_bar_time")}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/history")
def history(limit: int = Query(default=40, ge=1, le=150), db: Session = Depends(get_db)) -> dict:
    try:
        rows = db.query(AnalysisRecord).order_by(AnalysisRecord.id.desc()).limit(limit).all()
        return {"items": [_record_payload(row) for row in rows], "database": "connected"}
    except Exception as exc:
        return {"items": [], "database": "offline", "error": str(exc)[:240]}

def _record_payload(row: AnalysisRecord) -> dict:
    try:
        analysis = json.loads(row.payload_json)
    except (ValueError, TypeError):
        analysis = {}
    return {"id": row.id, "created_at": row.created_at.isoformat() if row.created_at else "",
            "symbol": row.symbol, "tf_primary": row.tf_primary, "tf_secondary": row.tf_secondary,
            "direction": row.direction, "confidence": row.confidence,
            "entry_low": row.entry_low, "entry_high": row.entry_high, "stop_loss": row.stop_loss,
            "take_profit_1": row.take_profit_1, "take_profit_2": row.take_profit_2,
            "image_primary": row.image_primary, "image_secondary": row.image_secondary,
            "image_primary_url": f"/uploads/{row.image_primary}", "image_secondary_url": f"/uploads/{row.image_secondary}",
            "analysis": analysis}

@app.get("/api/history/{record_id}")
def history_detail(record_id: int, db: Session = Depends(get_db)) -> dict:
    try:
        row = db.get(AnalysisRecord, record_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database unavailable: {str(exc)[:200]}") from exc
    if not row:
        raise HTTPException(status_code=404, detail="Signal history item was not found.")
    return _record_payload(row)

RESULT_R = {"TP1": 1.0, "TP2": 1.8, "SL": -1.0}  # R multiples (SL distance = 1R, TP1 = 1R, TP2 = 1.8R)


@app.post("/api/history/{record_id}/outcome")
def set_outcome(record_id: int, body: OutcomeRequest, db: Session = Depends(get_db)) -> dict:
    """Mark what actually happened to a signal (TP1 / TP2 / SL / SKIP / CLEAR) so the real win rate can be measured."""
    try:
        row = db.get(AnalysisRecord, record_id)
        if not row:
            raise HTTPException(status_code=404, detail="Signal history item was not found.")
        try:
            payload = json.loads(row.payload_json)
        except (ValueError, TypeError):
            payload = {}
        if body.result == "CLEAR":
            payload.pop("outcome", None)
        else:
            payload["outcome"] = {"result": body.result, "at": datetime.now(timezone.utc).isoformat()}
            plan = payload.get("ict_plan")
            if plan and body.result in ("TP1", "TP2"):
                payload["outcome"]["r"] = plan["rr1"] if body.result == "TP1" else plan["rr2"]
        row.payload_json = json.dumps(payload, ensure_ascii=False)
        db.commit()
        return _record_payload(row)
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail=f"Database unavailable: {str(exc)[:200]}") from exc


def _bucket() -> dict:
    return {"resolved": 0, "wins": 0, "losses": 0, "total_r": 0.0}


def _finish(b: dict) -> dict:
    n = b["resolved"]
    return {**b, "total_r": round(b["total_r"], 2), "win_rate": round(100 * b["wins"] / n, 1) if n else 0.0,
            "avg_r": round(b["total_r"] / n, 2) if n else 0.0}


@app.get("/api/stats")
def stats(db: Session = Depends(get_db)) -> dict:
    """Real results of the signals you marked: win rate and average R, overall and per grade / direction."""
    try:
        rows = db.query(AnalysisRecord).order_by(AnalysisRecord.id.desc()).limit(2000).all()
    except Exception as exc:
        return {"resolved": 0, "unresolved": 0, "error": str(exc)[:200], "by_grade": {}, "by_direction": {}}
    total, by_grade, by_dir, unresolved = _bucket(), {}, {}, 0
    for row in rows:
        if row.direction not in ("BUY", "SELL") or row.stop_loss is None:
            continue
        try:
            a = json.loads(row.payload_json)
        except (ValueError, TypeError):
            a = {}
        result = (a.get("outcome") or {}).get("result")
        if result not in RESULT_R:
            if result != "SKIP":
                unresolved += 1
            continue
        r_value = (a.get("outcome") or {}).get("r")
        r_value = float(r_value) if isinstance(r_value, (int, float)) else RESULT_R[result]
        for b in (total, by_grade.setdefault(a.get("signal_grade") or "-", _bucket()), by_dir.setdefault(row.direction, _bucket())):
            b["resolved"] += 1
            b["wins"] += 1 if r_value > 0 else 0
            b["losses"] += 1 if r_value < 0 else 0
            b["total_r"] += r_value
    return {**_finish(total), "unresolved": unresolved,
            "by_grade": {k: _finish(v) for k, v in sorted(by_grade.items())},
            "by_direction": {k: _finish(v) for k, v in by_dir.items()}}


@app.get("/api/stats/daily")
def stats_daily(days: int = Query(default=14, ge=1, le=60), tz_offset_min: int = Query(default=0, ge=-840, le=840),
                symbol: str | None = Query(default=None), db: Session = Depends(get_db)) -> dict:
    """Win rate per day (day = the signal's creation date in the viewer's timezone). TP1/TP2 = win, SL = loss; 'Not taken' and open signals are excluded from the rate."""
    from datetime import timedelta
    try:
        rows = db.query(AnalysisRecord).order_by(AnalysisRecord.id.desc()).limit(3000).all()
    except Exception as exc:
        return {"days": [], "today": None, "error": str(exc)[:200]}
    out: dict[str, dict] = {}
    for row in rows:
        if row.direction not in ("BUY", "SELL") or row.stop_loss is None or not row.created_at:
            continue
        if symbol and (row.symbol or "XAUUSD") != symbol:
            continue
        created = row.created_at if row.created_at.tzinfo else row.created_at.replace(tzinfo=timezone.utc)
        day = (created + timedelta(minutes=tz_offset_min)).date().isoformat()
        d = out.setdefault(day, {"date": day, "signals": 0, "tp1": 0, "tp2": 0, "sl": 0, "not_taken": 0, "open": 0, "total_r": 0.0})
        try:
            a = json.loads(row.payload_json)
        except (ValueError, TypeError):
            a = {}
        d["signals"] += 1
        outcome = a.get("outcome") or {}
        result = outcome.get("result")
        if result in RESULT_R:
            d[result.lower()] += 1
            r = outcome.get("r")
            d["total_r"] += float(r) if isinstance(r, (int, float)) else RESULT_R[result]
        elif result == "SKIP":
            d["not_taken"] += 1
        else:
            d["open"] += 1
    items = []
    for day in sorted(out, reverse=True)[:days]:
        d = out[day]
        wins, resolved = d["tp1"] + d["tp2"], d["tp1"] + d["tp2"] + d["sl"]
        d["wins"], d["resolved"] = wins, resolved
        d["win_rate"] = round(wins / resolved * 100, 1) if resolved else None
        d["total_r"] = round(d["total_r"], 2)
        items.append(d)
    today = (datetime.now(timezone.utc) + timedelta(minutes=tz_offset_min)).date().isoformat()
    return {"days": items, "today": next((d for d in items if d["date"] == today), {"date": today, "signals": 0, "wins": 0, "resolved": 0, "tp1": 0, "tp2": 0, "sl": 0, "open": 0, "not_taken": 0, "win_rate": None, "total_r": 0.0})}


@app.post("/api/chat")
async def chat(request: ChatRequest, db: Session = Depends(get_db)) -> dict:
    context = None
    row = None
    try:
        if request.analysis_id is not None:
            row = db.get(AnalysisRecord, request.analysis_id)
            if row:
                try:
                    context = json.loads(row.payload_json)
                except (ValueError, TypeError):
                    context = None
        if context is None:
            row = db.query(AnalysisRecord).order_by(AnalysisRecord.id.desc()).first()
            if row:
                try:
                    context = json.loads(row.payload_json)
                except (ValueError, TypeError):
                    context = None
    except Exception:
        # Chat remains available without database context if Neon is temporarily unreachable.
        context, row = None, None
    try:
        answer = await chat_with_deepseek(request.message, context)
        return {"answer": answer, "provider": "DeepSeek", "context_analysis_id": request.analysis_id or (row.id if 'row' in locals() and row else None)}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/{asset_name}", include_in_schema=False)
def root_asset(asset_name: str) -> FileResponse:
    """Serve ui.css / ict.js / news.js ... from the site root (the Cloudflare Worker does this via the assets binding)."""
    import re as _re
    path = STATIC_DIR / asset_name
    if not _re.fullmatch(r"[A-Za-z0-9_\-]+\.(js|css)", asset_name) or not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path)
