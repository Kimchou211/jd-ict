from math import sqrt, isfinite
from typing import Any
from .config import CONFIDENCE_MINIMUM, PRICE_AGREEMENT_ABSOLUTE, ATR_AGREEMENT_PERCENT, FORCE_SIGNAL
from . import symbols

ANN_LAYERS = {"liquidity", "structure", "zones", "range", "plan"}
ICT_KINDS = {"BOS", "MSS", "SWEEP", "FVG", "OB", "EQH", "EQL", "PDH", "PDL", "CRT_H", "CRT_L", "SWING", "PREMIUM", "DISCOUNT"}
ICT_LAYER = {"BOS": "structure", "MSS": "structure", "SWING": "structure", "SWEEP": "liquidity", "EQH": "liquidity", "EQL": "liquidity", "PDH": "liquidity", "PDL": "liquidity",
             "FVG": "zones", "OB": "zones", "CRT_H": "range", "CRT_L": "range", "PREMIUM": "range", "DISCOUNT": "range"}

TF_MINUTES = {"M1": 1, "M2": 2, "M3": 3, "M5": 5, "M10": 10, "M15": 15, "M30": 30,
              "H1": 60, "H2": 120, "H4": 240, "D1": 1440, "W1": 10080, "MN1": 43200}


def num(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        out = float(value)
        return out if isfinite(out) else None
    except (TypeError, ValueError):
        return None


def _within(a: float, b: float, absolute: float, pct: float) -> bool:
    return abs(a - b) <= max(absolute, abs((a + b) / 2) * pct)


def _read_at(result: dict, index: int) -> dict:
    reads = result.get("chart_reads")
    if not isinstance(reads, list) or len(reads) <= index or not isinstance(reads[index], dict):
        return {}
    return reads[index]


def _provider_value(results: list[dict], i: int, key: str, readable_key: str | None = None) -> tuple[float | None, bool]:
    """Return a readable value. One model is sufficient for a provisional read, two must agree for corroboration."""
    vals = []
    for result in results:
        read = _read_at(result, i)
        if readable_key and read.get(readable_key) is not True:
            return None, False
        v = num(read.get(key))
        if v is None or v <= 0:
            return None, False
        vals.append(v)
    if not vals:
        return None, False
    if len(vals) == 1:
        return vals[0], True
    prof = symbols.profile()
    tolerance_abs = (PRICE_AGREEMENT_ABSOLUTE if prof['name'] == 'XAUUSD' else prof['price_abs']) if key in ("current_price", "price_scale_top", "price_scale_bottom") else prof['atr_abs']
    tolerance_pct = ATR_AGREEMENT_PERCENT if key == "atr_value" else (0.0005 if key in ("current_price", "price_scale_top", "price_scale_bottom") else 0.02)
    if not all(_within(vals[0], v, tolerance_abs, tolerance_pct) for v in vals[1:]):
        return None, False
    return sum(vals) / len(vals), True


def _consensus_direction(results: list[dict]) -> tuple[str, bool]:
    directions = [str(r.get("direction", "WAIT")).upper() for r in results]
    if len(directions) == 1:
        return (directions[0], False) if directions[0] in ("BUY", "SELL") else ("WAIT", False)
    if len(directions) >= 2 and directions[0] in ("BUY", "SELL") and all(d == directions[0] for d in directions):
        return directions[0], True
    return "WAIT", False


def _sanitize_annotations(read: dict) -> list[dict]:
    result = []
    for item in (read.get("annotations") if isinstance(read.get("annotations"), list) else [])[:14]:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind not in ("line", "rect", "text"):
            continue
        clean = {"type": kind, "label": str(item.get("label", ""))[:80]}
        ict = str(item.get("ict", "")).upper().replace(" ", "_")
        if ict in ICT_KINDS:
            clean["ict"] = ict
        layer = str(item.get("layer", "")).lower()
        clean["layer"] = layer if layer in ANN_LAYERS else ICT_LAYER.get(ict, "structure")
        keys = ("x1", "y1", "x2", "y2") if kind == "line" else (("x", "y", "w", "h") if kind == "rect" else ("x", "y"))
        valid = True
        for key in keys:
            val = num(item.get(key))
            if val is None or val < 0 or val > 1000:
                valid = False
                break
            clean[key] = val
        if valid:
            result.append(clean)
    return result


def _first_text(result: dict, key: str, fallback: str = "") -> str:
    value = result.get(key)
    return str(value).strip()[:1200] if isinstance(value, (str, int, float)) else fallback


def _pullback_setup(results: list[dict], direction: str) -> dict:
    candidates = []
    for result in results:
        zones = result.get("pullback_zones")
        zone = zones.get(direction) if isinstance(zones, dict) else None
        if not isinstance(zone, dict):
            continue
        low, high = num(zone.get("low")), num(zone.get("high"))
        if low is None or high is None or low < symbols.profile()['price_min'] or high > symbols.profile()['price_max'] or low >= high:
            continue
        quality = str(zone.get("quality", "")).lower()
        candidates.append({
            "low": low,
            "high": high,
            "quality": quality if quality in ("read", "estimated") else "estimated",
            "basis": str(zone.get("basis", "")).strip()[:240],
            "provider": str(result.get("provider", "AI"))[:40],
            "confidence": num(result.get("confidence")) or 0,
        })

    unavailable = {
        "pullback_low": None,
        "pullback_high": None,
        "pullback_quality": "unavailable",
        "pullback_basis": "No usable zone was returned for this side.",
        "pullback_provider": "",
        "pullback_agreement": "unavailable",
    }
    if not candidates:
        return unavailable

    candidates.sort(key=lambda item: (item["quality"] == "read", item["confidence"]), reverse=True)
    selected = candidates[0]
    if len(candidates) > 1:
        second = candidates[1]
        agree = _within(selected["low"], second["low"], 1.0, 0.001) and _within(
            selected["high"], second["high"], 1.0, 0.001
        )
        if agree:
            quality = "corroborated" if all(item["quality"] == "read" for item in candidates[:2]) else "axis_estimate"
            return {
                "pullback_low": round((selected["low"] + second["low"]) / 2, 2),
                "pullback_high": round((selected["high"] + second["high"]) / 2, 2),
                "pullback_quality": quality,
                "pullback_basis": selected["basis"] or second["basis"] or "Both AI readers identified a similar structure zone.",
                "pullback_provider": f"{selected['provider']} + {second['provider']}",
                "pullback_agreement": "agreed",
            }
        agreement = "models_differed"
    else:
        agreement = "single_model"

    return {
        "pullback_low": round(selected["low"], 2),
        "pullback_high": round(selected["high"], 2),
        "pullback_quality": "axis_estimate" if selected["quality"] == "estimated" else "single_read",
        "pullback_basis": selected["basis"] or "AI-identified support/resistance retest area.",
        "pullback_provider": selected["provider"],
        "pullback_agreement": agreement,
    }


def build_strict_read(provider_results: list[dict], provider_errors: dict, tf_primary: str, tf_secondary: str) -> dict:
    model_bias, direction_agreed = _consensus_direction(provider_results)
    primary_result = provider_results[0] if provider_results else {}
    # With provider disagreement, keep the final bias neutral but still expose conditional scenarios.
    if len(provider_results) >= 2 and not direction_agreed:
        model_bias = "WAIT"
    confidence_values = [num(x.get("confidence")) for x in provider_results]
    confidence_values = [max(0, min(100, x)) for x in confidence_values if x is not None]
    confidence = round(sum(confidence_values) / len(confidence_values)) if confidence_values else 0
    provider_count = len(provider_results)
    out = {
        "symbol": symbols.profile()["name"], "mode": "IMAGE_ONLY", "direction": "WAIT", "model_bias": model_bias,
        "trade_ready": False, "levels_available": False, "signal_status": "WAIT_FOR_CONFIRMATION",
        "confidence": confidence, "entry_price": None, "entry_low": None, "entry_high": None,
        "stop_loss": None, "take_profit_1": None, "take_profit_2": None,
        "atr_primary": None, "atr_secondary": None, "effective_atr": None,
        "price_source": "Uploaded screenshot only; not live market data",
        "atr_method": "Numeric levels require a clearly readable screenshot price and ATR value on both timeframes.",
        "setup_rationale": _first_text(primary_result, "setup_rationale", f"Upload clearer {symbols.profile()['name']} screenshots to receive a chart read."),
        "invalidation": _first_text(primary_result, "invalidation", "Wait for clear structural invalidation/confirmation."),
        "bull_case": _first_text(primary_result, "bull_case"),
        "bear_case": _first_text(primary_result, "bear_case"),
        "timeframe_alignment": _first_text(primary_result, "timeframe_alignment", "unclear"),
        "setup_type": _first_text(primary_result, "setup_type", "none"),
        "risk_notes": [],
        "validation": {"provider_count": provider_count, "provider_errors": provider_errors,
          "direction_agreement": direction_agreed, "current_price_agreement": False, "atr_agreement": False,
          "secondary_price_alignment": False, "symbol_confirmed": False, "atr_periods_visible": False,
          "levels_calculated": False, "single_provider_mode": provider_count == 1},
        "providers": [{"name": r.get("provider", "Unknown"), "model": r.get("model", ""),
                       "direction": r.get("direction", "WAIT"), "confidence": num(r.get("confidence")) or 0} for r in provider_results],
        "chart_reads": [], "conditional_setups": []
    }

    # Always construct conditional scenarios, including when only one provider worked or the verdict is WAIT.
    for direction, label, trigger_key, case_key in (
        ("BUY", "Bullish / BUY scenario", "entry_trigger_buy", "bull_case"),
        ("SELL", "Bearish / SELL scenario", "entry_trigger_sell", "bear_case"),
    ):
        trigger = _first_text(primary_result, trigger_key) or _first_text(primary_result, case_key)
        if not trigger:
            trigger = ("AI did not provide a chart-specific trigger. Wait for a visible break of structure and retest; no numeric level is verified."
                       if direction == "BUY" else
                       "AI did not provide a chart-specific trigger. Wait for a visible breakdown of structure and failed retest; no numeric level is verified.")
        scenario = {
            "direction": direction, "title": label, "trigger": trigger,
            "invalidation": _first_text(primary_result, "invalidation", "Require a clear structural invalidation level before considering entry."),
            "numeric_levels_available": False
        }
        scenario.update(_pullback_setup(provider_results, direction))
        out["conditional_setups"].append(scenario)

    tf_names = [tf_primary, tf_secondary]
    for i, tf in enumerate(tf_names):
        price, price_ok = _provider_value(provider_results, i, "current_price", "current_price_readable")
        atr, atr_ok = _provider_value(provider_results, i, "atr_value", "atr_visible")
        top, top_ok = _provider_value(provider_results, i, "price_scale_top", "price_scale_readable")
        bottom, bottom_ok = _provider_value(provider_results, i, "price_scale_bottom", "price_scale_readable")
        trends = [str(_read_at(r, i).get("trend", "unclear")).lower() for r in provider_results]
        structures = [str(_read_at(r, i).get("structure", ""))[:900] for r in provider_results if _read_at(r, i).get("structure")]
        annot_source = next((r for r in provider_results if _read_at(r, i).get("annotations")), None)
        raw_read = _read_at(annot_source, i) if annot_source else {}
        period_vals = [num(_read_at(r, i).get("atr_period")) for r in provider_results]
        valid_periods = [x for x in period_vals if x is not None and x > 0]
        if len(provider_results) == 1:
            period_ok = len(valid_periods) == 1
        else:
            period_ok = len(valid_periods) == len(provider_results) and len({int(p) for p in valid_periods}) == 1
        scale_ok = top_ok and bottom_ok and top is not None and bottom is not None and top > bottom and top - bottom >= 0.05
        key_levels = []
        for r in provider_results:
            for level in (_read_at(r, i).get("key_levels") or [])[:8]:
                if isinstance(level, dict):
                    p = num(level.get("price"))
                    if p is not None and symbols.profile()['price_min'] <= p <= symbols.profile()['price_max']:
                        key_levels.append({"price": round(p, 2), "kind": str(level.get("kind", "other")), "label": str(level.get("label", ""))[:90]})
            if key_levels:
                break
        out["chart_reads"].append({
            "timeframe": tf,
            "trend": trends[0] if trends and all(t == trends[0] for t in trends) else (trends[0] if len(trends) == 1 else "mixed"),
            "trend_agreement": bool(trends) and len(set(trends)) == 1,
            "structure": structures[0] if structures else "No readable structure summary.",
            "current_price": round(price, 2) if price_ok and price is not None and symbols.profile()['price_min'] <= price <= symbols.profile()['price_max'] else None,
            "current_price_verified": bool(price_ok and price is not None and symbols.profile()['price_min'] <= price <= symbols.profile()['price_max']),
            "current_price_verification_mode": "cross-model" if len(provider_results) >= 2 else "single-model image read",
            "atr_value": round(atr, 3) if atr_ok and atr is not None and 0.001 <= atr <= 500 else None,
            "atr_verified": bool(atr_ok and atr is not None and 0.001 <= atr <= 500),
            "atr_verification_mode": "cross-model" if len(provider_results) >= 2 else "single-model image read",
            "atr_period": int(valid_periods[0]) if period_ok else None,
            "price_scale": {"top": round(top, 2) if scale_ok else None, "bottom": round(bottom, 2) if scale_ok else None, "verified": bool(scale_ok)},
            "key_levels": key_levels,
            "annotations": _sanitize_annotations(raw_read),
            "providers": [{"name": r.get("provider", "Unknown"), "current_price": num(_read_at(r, i).get("current_price")),
                "atr_value": num(_read_at(r, i).get("atr_value")), "price_readable": _read_at(r, i).get("current_price_readable") is True,
                "atr_visible": _read_at(r, i).get("atr_visible") is True} for r in provider_results]
        })

    reads = out["chart_reads"]
    prices_ok = len(reads) == 2 and all(x["current_price_verified"] for x in reads)
    atrs_ok = len(reads) == 2 and all(x["atr_verified"] for x in reads)
    price_alignment = bool(prices_ok and _within(reads[0]["current_price"], reads[1]["current_price"], symbols.profile()["agree_abs"], 0.0005))
    out["validation"]["current_price_agreement"] = bool(prices_ok and (provider_count == 1 or all(
        _provider_value(provider_results, i, "current_price", "current_price_readable")[1] for i in (0, 1))))
    out["validation"]["atr_agreement"] = bool(atrs_ok)
    out["validation"]["secondary_price_alignment"] = price_alignment
    symbol_ok = bool(provider_results) and all(symbols.matches(_read_at(r, i).get("symbol_detected", ""))
                                                for r in provider_results for i in (0, 1))
    out["validation"]["symbol_confirmed"] = symbol_ok
    period_values = [num(_read_at(r, i).get("atr_period")) for r in provider_results for i in (0, 1)]
    periods_verified = (len(period_values) == provider_count * 2 and all(p is not None and p > 0 for p in period_values)
                        and len({int(p) for p in period_values}) == 1)
    out["validation"]["atr_periods_visible"] = periods_verified

    # If a provider gives us a directional read but the other provider is unavailable, preserve it as provisional bias.
    if provider_count == 1 and str(primary_result.get("direction", "WAIT")).upper() in ("BUY", "SELL"):
        out["model_bias"] = str(primary_result["direction"]).upper()
        out["signal_status"] = "PROVISIONAL_SINGLE_MODEL"
    elif direction_agreed and model_bias in ("BUY", "SELL"):
        out["signal_status"] = "DUAL_MODEL_DIRECTION_AGREEMENT"

    notes = []
    for r in provider_results:
        if isinstance(r.get("risk_notes"), list):
            notes.extend(str(n)[:220] for n in r["risk_notes"][:5])
    if provider_count == 1:
        if provider_errors:
            notes.append("Only one AI provider responded. Its chart read and conditional scenarios are shown, but any numerical levels remain provisional and must be checked manually.")
        else:
            notes.append("Only one AI provider is active. Conditional scenarios are available; independent corroboration is unavailable.")
    if not prices_ok:
        notes.append("A readable last-price badge was not identified on both screenshots. Numeric reference levels cannot be validated from chart text alone.")
    if not atrs_ok:
        notes.append("A numeric ATR readout was not visible/readable on both screenshots. Add an ATR indicator and keep its value visible in each image.")
    if not periods_verified:
        notes.append("ATR period was not consistently readable on both screenshots. Show the ATR period/value and use the same period on both charts.")
    if prices_ok and not price_alignment:
        notes.append("The screenshot reference prices differ materially. Capture both timeframes close together using the same broker/feed.")
    if not symbol_ok:
        notes.append(f"{symbols.profile()['name']} symbol could not be confirmed from both screenshots. Ensure the symbol name is visible in both images.")
    if len(provider_results) >= 2 and not direction_agreed:
        notes.append("The two AI readers did not agree on direction. Review the conditional BUY/SELL triggers instead of forcing a trade.")

    # Compute levels only from explicit numeric labels that the model marked visible.
    numeric_inputs_ok = prices_ok and atrs_ok and price_alignment and periods_verified and symbol_ok
    directional_ok = out["model_bias"] in ("BUY", "SELL")
    confidence_ok = confidence >= CONFIDENCE_MINIMUM
    can_calculate = numeric_inputs_ok and directional_ok and confidence_ok and (provider_count == 1 or direction_agreed)
    if can_calculate:
        p, secondary_price = reads[0]["current_price"], reads[1]["current_price"]
        ap, ass = reads[0]["atr_value"], reads[1]["atr_value"]
        primary_min = TF_MINUTES.get(tf_primary, 1)
        secondary_min = TF_MINUTES.get(tf_secondary, 5)
        # Square-root time normalization is an app-defined heuristic, not a standard ATR identity.
        secondary_normalized_atr = ass * sqrt(primary_min / secondary_min)
        effective_atr = 0.65 * ap + 0.35 * secondary_normalized_atr
        entry = p
        entry_half_width = effective_atr * 0.10
        risk_distance = effective_atr * 1.20
        if out["model_bias"] == "BUY":
            sl, tp1, tp2 = entry - risk_distance, entry + risk_distance, entry + (risk_distance * 1.80)
        else:
            sl, tp1, tp2 = entry + risk_distance, entry - risk_distance, entry - (risk_distance * 1.80)
        out.update({"levels_available": True, "direction": out["model_bias"], "signal_status": "PROVISIONAL_SINGLE_MODEL" if provider_count == 1 else "DUAL_MODEL_CORROBORATED",
                    "trade_ready": bool(provider_count >= 2 and direction_agreed), "entry_price": round(entry, 2),
                    "entry_low": round(entry - entry_half_width, 2), "entry_high": round(entry + entry_half_width, 2),
                    "stop_loss": round(sl, 2), "take_profit_1": round(tp1, 2), "take_profit_2": round(tp2, 2),
                    "atr_primary": round(ap, 3), "atr_secondary": round(ass, 3), "effective_atr": round(effective_atr, 3),
                    "atr_method": f"Image-read ATRs: ATR {tf_primary} × 0.65 + ATR {tf_secondary} normalized by sqrt({primary_min}/{secondary_min}) × 0.35; app-defined effective ATR. SL=1.20R, TP1=1.00R, TP2=1.80R where R=1.20×effective ATR. Screenshot-only reference, not live quote."})
        out["validation"]["levels_calculated"] = True
        out["conditional_setups"] = [x | {"numeric_levels_available": True} if x["direction"] == out["model_bias"] else x for x in out["conditional_setups"]]
        if provider_count == 1:
            notes.append("Numeric levels are calculated from one model's explicit image reads only. Verify each number against the screenshot/MT5 before use; this is not a validated live trade.")
    else:
        out["direction"] = "WAIT"
        out["trade_ready"] = False
        out["levels_available"] = False
        if not directional_ok:
            notes.append("No single directional edge was established. The conditional BUY and SELL scenarios show what confirmation to wait for.")
        if directional_ok and not confidence_ok:
            notes.append(f"Directional bias exists, but qualitative confidence ({confidence}/100) is below the configured threshold ({CONFIDENCE_MINIMUM}); scenarios remain conditional.")

    # Draw numeric lines on the image canvas only when a price scale can map them to pixels.
    if out["levels_available"]:
        for read in out["chart_reads"]:
            scale = read["price_scale"]
            if not scale["verified"]:
                continue
            for label, price_value in (("ENTRY", out["entry_price"]), ("SL", out["stop_loss"]),
                                       ("TP1", out["take_profit_1"]), ("TP2", out["take_profit_2"])):
                if price_value is not None and scale["bottom"] <= price_value <= scale["top"]:
                    read["annotations"].append({"type": "price_line", "price": price_value,
                                                 "label": f"{label} {price_value:.2f}"})

    out["risk_notes"] = list(dict.fromkeys(notes))[:12]
    out["analysis_text"] = _build_summary(out)
    return out


def _build_summary(out: dict) -> str:
    parts = [f"Bias: {out.get('model_bias', 'WAIT')} | Decision: {out.get('direction', 'WAIT')} | Status: {out.get('signal_status', 'WAIT_FOR_CONFIRMATION')}."]
    if out.get("signal_grade"):
        parts.append(f"Signal grade {out['signal_grade']}: {out.get('grade_summary', '')}")
    for setup in out.get("conditional_setups", []):
        if setup.get("pullback_low") is not None and setup.get("pullback_high") is not None:
            parts.append(
                f"{setup['direction']} pullback watch zone: {setup['pullback_low']:.2f}–"
                f"{setup['pullback_high']:.2f} ({setup.get('pullback_quality', 'estimate')})."
            )
    if out.get("levels_available"):
        parts.append(f"Screenshot reference price: {out['entry_price']:.2f}; entry zone {out['entry_low']:.2f}–{out['entry_high']:.2f}; SL {out['stop_loss']:.2f}; TP1 {out['take_profit_1']:.2f}; TP2 {out['take_profit_2']:.2f}.")
        parts.append("These are image-derived values, not a live quote. Single-provider numbers are provisional.")
    for r in out.get("chart_reads", []):
        parts.append(f"{r['timeframe']}: trend {r['trend']}; price {'readable' if r['current_price_verified'] else 'unverified'}; ATR {'readable' if r['atr_verified'] else 'unverified'}. {r['structure']}")
    if out.get("risk_notes"):
        parts.append("Checks: " + " ".join(out["risk_notes"][:4]))
    return "\n\n".join(parts)



# ---------------------------------------------------------------------------
# FORCED-SIGNAL MODE (FORCE_SIGNAL=true in .env)
# Always returns BUY or SELL when the AI gave any usable direction, and replaces
# the old WAIT gates with a quality GRADE (A best ... D weakest) so you can see
# how much of the signal was read from the chart and how much was estimated.
# ---------------------------------------------------------------------------

_DROP_NOTE_PREFIXES = ("No single directional edge", "Directional bias exists, but qualitative confidence",
                       "The two AI readers did not agree on direction")


def build_trade_read(provider_results: list[dict], provider_errors: dict, tf_primary: str, tf_secondary: str, symbol: str = "XAUUSD") -> dict:
    symbols.set_active(symbol)
    out = build_strict_read(provider_results, provider_errors, tf_primary, tf_secondary)
    if not FORCE_SIGNAL:
        return out
    return _apply_forced_signal(out, provider_results, tf_primary, tf_secondary)


def _side(value: Any) -> str | None:
    v = str(value or "").upper()
    return v if v in ("BUY", "SELL") else None


def _provider_side(result: dict) -> str | None:
    return _side(result.get("direction")) or _side(result.get("forced_direction")) or _side(result.get("preferred_setup"))


def _trend_side(trend: Any) -> str | None:
    t = str(trend or "").lower()
    return "BUY" if t == "bullish" else "SELL" if t == "bearish" else None


def _forced_direction(results: list[dict], tf_primary: str, tf_secondary: str) -> tuple[str | None, str]:
    """Pick BUY/SELL. Mode: agreed | single | split | trend | none."""
    htf = 0 if TF_MINUTES.get(tf_primary, 0) >= TF_MINUTES.get(tf_secondary, 0) else 1

    def trend_fallback() -> str | None:
        for idx in (htf, 1 - htf):
            for r in results:
                side = _trend_side(_read_at(r, idx).get("trend"))
                if side:
                    return side
        return None

    weights = {"BUY": 0.0, "SELL": 0.0}
    sides = []
    for r in results:
        side = _provider_side(r)
        if side:
            sides.append(side)
            weights[side] += max(1.0, num(r.get("confidence")) or 50.0)
    if not sides:
        t = trend_fallback()
        return (t, "trend") if t else (None, "none")
    if len(set(sides)) == 1:
        return sides[0], ("agreed" if len(sides) >= 2 else "single")
    if weights["BUY"] != weights["SELL"]:
        return ("BUY" if weights["BUY"] > weights["SELL"] else "SELL"), "split"
    return (trend_fallback() or sides[0]), "split"


def _side_confidence(results: list[dict], side: str, split: bool) -> int:
    vals = [num(r.get("confidence")) for r in results if _provider_side(r) == side]
    vals = [max(0.0, min(100.0, v)) for v in vals if v is not None]
    base = sum(vals) / len(vals) if vals else 40.0
    return round(base * (0.85 if split else 1.0))


def _best_value(results: list[dict], i: int, key: str, readable_key: str | None, est_key: str | None,
                lo: float | None, hi: float | None, tol: tuple[float, float]) -> tuple[float | None, str | None]:
    """Best number for chart i. Returns (value, quality): 'read' = printed on chart, 'estimated' = model estimate."""
    read_vals, est_vals = [], []
    for r in results:
        rd = _read_at(r, i)
        conf = num(rd.get("confidence"))
        conf = conf if conf is not None else (num(r.get("confidence")) or 0.0)
        v, e = num(rd.get(key)), (num(rd.get(est_key)) if est_key else None)
        flagged = readable_key is None or rd.get(readable_key) is True
        if v is not None and v > 0 and flagged:
            read_vals.append((conf, v))
        else:
            if v is not None and v > 0:
                est_vals.append((conf, v))      # unflagged number -> treat as an estimate
            if e is not None and e > 0:
                est_vals.append((conf, e))

    def usable(pairs):
        return [(c, v) for c, v in pairs if (lo is None or v >= lo) and (hi is None or v <= hi)]

    def merge(pairs):
        if len(pairs) >= 2 and all(_within(pairs[0][1], v, tol[0], tol[1]) for _, v in pairs[1:]):
            return sum(v for _, v in pairs) / len(pairs)
        return max(pairs)[1]            # disagreement -> trust the reading with the higher chart confidence

    read_vals, est_vals = usable(read_vals), usable(est_vals)
    if read_vals:
        return merge(read_vals), "read"
    if est_vals:
        return merge(est_vals), "estimated"
    return None, None


def _grade(mode: str, price_q: str | None, atr_q: str | None, confidence: int, alignment: str) -> str:
    score = {"agreed": 2, "single": 0, "trend": 0, "split": -1}.get(mode, 0)
    score += {"read": 2, "estimated": 1}.get(price_q or "", 0)
    score += {"read": 2, "estimated": 1}.get(atr_q or "", 0)
    score += 1 if confidence >= 65 else 0
    score += 1 if str(alignment).lower() == "aligned" else 0
    return "A" if score >= 7 else "B" if score >= 5 else "C" if score >= 3 else "D"


def _grade_summary(grade: str, mode: str, price_q: str | None, atr_q: str | None) -> str:
    meaning = {"A": "both AIs agree and price + ATR were read from the screenshots",
               "B": "good read, minor items unconfirmed",
               "C": "some inputs were estimated - treat as lower quality",
               "D": "weak: split opinion and/or mostly estimated inputs - small size or skip"}[grade]
    modes = {"agreed": "both AIs agree", "single": "single AI", "split": "AIs disagreed (majority/confidence used)",
             "trend": "direction taken from chart trend", "none": "no direction"}
    return (f"{meaning}. Direction: {modes.get(mode, mode)}; price: {price_q or 'missing'}; "
            f"ATR: {atr_q or 'missing'}.")


def _add_price_lines(out: dict) -> None:
    for read in out["chart_reads"]:
        scale = read["price_scale"]
        if not scale["verified"]:
            continue
        for label, value in (("ENTRY", out["entry_price"]), ("SL", out["stop_loss"]),
                             ("TP1", out["take_profit_1"]), ("TP2", out["take_profit_2"])):
            if value is not None and scale["bottom"] <= value <= scale["top"]:
                read["annotations"].append({"type": "price_line", "price": value, "label": f"{label} {value:.2f}"})


def _apply_forced_signal(out: dict, results: list[dict], tf_primary: str, tf_secondary: str) -> dict:
    provider_count = len(results)
    strict_ok = bool(out.get("levels_available")) and out.get("direction") in ("BUY", "SELL")
    alignment = out.get("timeframe_alignment", "unclear")

    # 1) Strict validation already produced a full signal: keep it, just grade it.
    if strict_ok:
        mode = "agreed" if out["validation"].get("direction_agreement") else "single"
        grade = _grade(mode, "read", "read", int(out.get("confidence", 0)), alignment)
        out.update({"forced_signal": False, "signal_grade": grade,
                    "grade_summary": _grade_summary(grade, mode, "read", "read")})
        out["analysis_text"] = _build_summary(out)
        return out

    # 2) Strict validation said WAIT / blocked. Force a decision.
    direction, mode = _forced_direction(results, tf_primary, tf_secondary)
    notes = [n for n in out.get("risk_notes", []) if not n.startswith(_DROP_NOTE_PREFIXES)]
    if direction is None:
        notes.insert(0, "The AI returned no usable direction for these screenshots. Upload clearer charts (symbol, price axis and candles visible).")
        out["risk_notes"] = list(dict.fromkeys(notes))[:12]
        out["analysis_text"] = _build_summary(out)
        return out

    split = mode == "split"
    confidence = _side_confidence(results, direction, split) if mode != "trend" else 35
    tf_min = (TF_MINUTES.get(tf_primary, 1), TF_MINUTES.get(tf_secondary, 5))

    # Price: prefer a value printed on the chart, else the model's axis-interpolated estimate.
    price_tol = ((PRICE_AGREEMENT_ABSOLUTE if symbols.profile()['name'] == 'XAUUSD' else symbols.profile()['price_abs']), 0.0005)
    p0, pq0 = _best_value(results, 0, "current_price", "current_price_readable", "price_estimate", symbols.profile()["price_min"], symbols.profile()["price_max"], price_tol)
    p1, pq1 = _best_value(results, 1, "current_price", "current_price_readable", "price_estimate", symbols.profile()["price_min"], symbols.profile()["price_max"], price_tol)
    price, price_q = None, None
    if p0 is not None and p1 is not None:
        price, price_q = (p1, pq1) if (pq0 != "read" and pq1 == "read") else (p0, pq0)
        if not _within(p0, p1, symbols.profile()["agree_abs"], 0.0005):
            notes.append(f"The two screenshots show different prices ({p0:.2f} vs {p1:.2f}). Entry uses the more reliable one; capture both charts at the same moment.")
    elif p0 is not None:
        price, price_q = p0, pq0
    elif p1 is not None:
        price, price_q = p1, pq1

    for i, (pv, pq) in enumerate(((p0, pq0), (p1, pq1))):
        out["chart_reads"][i]["current_price_est"] = round(pv, 2) if pv is not None and pq == "estimated" else None

    levels = False
    atr_q, atr0, atr1, effective_atr, atr_note = None, None, None, None, ""
    if price is not None:
        atr_tol = (symbols.profile()['atr_abs'], ATR_AGREEMENT_PERCENT)
        lo, hi = price * 0.00005, price * 0.02
        atr0, aq0 = _best_value(results, 0, "atr_value", "atr_visible", "atr_estimate", lo, hi, atr_tol)
        atr1, aq1 = _best_value(results, 1, "atr_value", "atr_visible", "atr_estimate", lo, hi, atr_tol)
        for i, (av, aq) in enumerate(((atr0, aq0), (atr1, aq1))):
            out["chart_reads"][i]["atr_est"] = round(av, 3) if av is not None and aq == "estimated" else None
        norm1 = atr1 * sqrt(tf_min[0] / tf_min[1]) if atr1 is not None else None
        if atr0 is not None and norm1 is not None and max(atr0, norm1) / min(atr0, norm1) <= 3:
            effective_atr = 0.65 * atr0 + 0.35 * norm1
            atr_q = "read" if (aq0 == "read" and aq1 == "read") else "estimated"
            atr_note = f"0.65 x ATR {tf_primary} + 0.35 x ATR {tf_secondary} normalized by sqrt({tf_min[0]}/{tf_min[1]})"
        elif atr0 is not None:
            effective_atr, atr_q, atr_note = atr0, aq0, f"ATR {tf_primary}"
            if norm1 is not None:
                notes.append("The ATR values on the two charts are inconsistent (more than 3x apart); only the primary chart ATR was used.")
        elif norm1 is not None:
            effective_atr, atr_q, atr_note = norm1, aq1, f"ATR {tf_secondary} normalized to {tf_primary}"
        else:
            top, _ = _best_value(results, 0, "price_scale_top", "price_scale_readable", None, symbols.profile()["price_min"], symbols.profile()["price_max"], (symbols.profile()["price_abs"], 0.0005))
            bottom, _ = _best_value(results, 0, "price_scale_bottom", "price_scale_readable", None, symbols.profile()["price_min"], symbols.profile()["price_max"], (symbols.profile()["price_abs"], 0.0005))
            if top is not None and bottom is not None and top > bottom:
                effective_atr, atr_note = (top - bottom) * 0.05, "rough: 5% of the visible price-axis span"
            else:
                effective_atr, atr_note = price * 0.0008 * sqrt(max(tf_min[0], 1) / 5), "rough: 0.08% of price scaled by timeframe"
            atr_q = "heuristic"
        effective_atr = max(effective_atr, symbols.profile()['atr_floor'])
        r_dist = effective_atr * 1.20
        half = effective_atr * 0.10
        sign = 1 if direction == "BUY" else -1
        sl, tp1, tp2 = price - sign * r_dist, price + sign * r_dist, price + sign * r_dist * 1.80
        levels = True
        out.update({
            "entry_price": round(price, 2), "entry_low": round(price - half, 2), "entry_high": round(price + half, 2),
            "stop_loss": round(sl, 2), "take_profit_1": round(tp1, 2), "take_profit_2": round(tp2, 2),
            "atr_primary": round(atr0, 3) if atr0 is not None else None,
            "atr_secondary": round(atr1, 3) if atr1 is not None else None,
            "effective_atr": round(effective_atr, 3),
            "atr_method": (f"Forced-signal levels. Effective ATR = {atr_note} (source: {atr_q}). R = 1.20 x effective ATR; "
                           f"SL = 1R, TP1 = 1R, TP2 = 1.8R. Entry = screenshot price ({price_q}). Screenshot-only reference, not a live quote."),
        })
        if price_q == "estimated":
            notes.append("No last-price badge was readable, so the entry price is the AI's estimate from the price axis. Check it against MT5 before ordering.")
        if atr_q != "read":
            notes.append(f"ATR was not fully readable on the charts ({atr_q}). SL/TP distances are approximate - show an ATR indicator with its value for Grade A.")
    else:
        notes.append("No price could be read or estimated from the screenshots, so Entry/SL/TP are omitted. Use the BUY/SELL trigger text and make sure the price axis is visible.")

    grade = _grade(mode, price_q, atr_q, confidence, alignment)
    summary = _grade_summary(grade, mode, price_q, atr_q)
    if split:
        notes.insert(0, "The two AIs disagreed on direction; the side with the higher confidence was used. Treat it as a low-agreement signal.")
    notes.insert(0, f"FORCED SIGNAL (grade {grade}): strict validation did not pass, so this result is a best-effort call, not a validated trade.")

    out.update({
        "direction": direction, "model_bias": direction, "confidence": confidence,
        "forced_signal": True, "signal_status": "FORCED_SIGNAL", "trade_ready": False,
        "levels_available": levels, "signal_grade": grade, "grade_summary": summary,
        "signal_basis": {"direction": mode, "price": price_q, "atr": atr_q},
    })
    out["validation"]["levels_calculated"] = levels
    out["conditional_setups"] = [x | {"numeric_levels_available": levels} if x["direction"] == direction else x
                                 for x in out["conditional_setups"]]
    if levels:
        _add_price_lines(out)
    out["risk_notes"] = list(dict.fromkeys(notes))[:12]
    out["analysis_text"] = _build_summary(out)
    return out
