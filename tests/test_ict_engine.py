import copy

from fastapi.testclient import TestClient

from app import ict_engine as E
from app.tracker import evaluate_plan
from ict_fixtures import bearish_setup_bars


def scan():
    return E.scan({"M5": bearish_setup_bars()}, "M5")


def test_swings_and_structure_find_bull_bos_then_bear_mss():
    bars = bearish_setup_bars()
    st = E.market_structure(bars, E.find_swings(bars))
    assert [(e["kind"], e["dir"]) for e in st["events"]] == [("BOS", "bull"), ("MSS", "bear")]
    assert st["trend"] == "bear"


def test_sweep_fvg_and_ob_detected():
    r = scan()
    assert any(k.startswith("SWEEP") for k in r["level_table"])
    assert any(k.startswith("FVG") for k in r["level_table"])
    assert any(k.startswith("MSS") for k in r["level_table"])
    assert r["setups"][0]["sweep"]["kind"] == "SWH"


def test_bearish_plan_is_geometrically_valid():
    r = scan()
    assert r["direction"] == "SELL" and r["plan_status"] == "AWAITING_RETRACE"
    p = r["plan"]
    assert p["stop"] > p["entry_high"] >= p["entry"] >= p["entry_low"] > p["tp1"] > p["tp2"]
    assert p["rr1"] >= 1.5 and abs(p["rr1"] - abs(p["entry"] - p["tp1"]) / p["risk"]) < 0.02
    assert p["stop"] > max(b["high"] for b in bearish_setup_bars()[52:54])  # stop above the sweep extreme


def test_too_few_candles_is_rejected():
    try:
        E.scan({"M5": bearish_setup_bars()[:40]}, "M5")
        assert False
    except ValueError:
        pass


def test_price_through_stop_invalidates():
    bars = bearish_setup_bars()
    last = dict(bars[-1]); last.update(close=4013.0, high=4013.2, timestamp_ms=bars[-1]["timestamp_ms"] + 300000)
    r = E.scan({"M5": bars + [last]}, "M5")
    assert r["direction"] == "WAIT"


def test_ai_validator_rejects_invented_price_and_unknown_ids():
    r = scan()
    ok = {"direction": "SELL", "verdict": "APPROVE", "selected_setup": "S1", "referenced_levels": ["SWEEP1", "ENTRY"],
          "narrative": f"Sell the retrace into {r['plan']['entry']}", "confidence": 70}
    assert E.validate_ai_review(ok, r)["accepted"]
    bad_price = dict(ok, narrative="Target 3950.00 next")
    assert not E.validate_ai_review(bad_price, r)["accepted"]
    assert not E.validate_ai_review(dict(ok, referenced_levels=["FAKE9"]), r)["accepted"]
    assert not E.validate_ai_review(dict(ok, selected_setup="S9"), r)["accepted"]


def test_combine_verdict_rules():
    r = scan()
    ai = {"ok": True, "verdict": "APPROVE", "direction": "SELL", "confidence": 80}
    good = {"accepted": True, "issues": []}
    assert E.combine_verdict(r, ai, good, True)["verdict_status"] == "ALIGNED"
    assert E.combine_verdict(r, dict(ai, direction="BUY"), good, True)["final_direction"] == "WAIT"
    assert E.combine_verdict(r, dict(ai, verdict="REJECT"), good, True)["verdict_status"] == "AI_VETO"
    out = E.combine_verdict(r, ai, {"accepted": False, "issues": ["x"]}, True)
    assert out["verdict_status"] == "AI_REJECTED_BY_VALIDATOR" and out["final_direction"] == "SELL"
    assert E.combine_verdict(r, None, None, False)["final_direction"] == "WAIT"  # stale / closed feed


def _bar(ts, o, h, l, c):
    return {"timestamp_ms": ts, "open": o, "high": h, "low": l, "close": c}


def test_tracker_outcomes():
    plan = scan()["plan"]
    t0 = plan["ts_start"]
    mid = (plan["entry_low"] + plan["entry_high"]) / 2
    win = [_bar(t0 + 300000, mid, mid + 0.3, mid - 0.3, mid), _bar(t0 + 600000, mid, mid, plan["tp1"] - 0.2, plan["tp1"])]
    assert evaluate_plan(plan, {}, win, t0 + 900000)["result"] == "TP1"
    loss = [_bar(t0 + 300000, mid, plan["stop"] + 0.5, mid - 0.2, mid)]
    assert evaluate_plan(plan, {}, loss, t0 + 600000)["result"] == "SL"   # touches zone and stop in one candle -> SL
    skip = [_bar(t0 + 300000, plan["tp1"] + 1, plan["tp1"] + 1.2, plan["tp1"] - 0.5, plan["tp1"])]
    assert evaluate_plan(plan, {}, skip, t0 + 600000)["result"] == "SKIP"  # ran to target without filling
    pend = evaluate_plan(plan, {}, [], t0 + 600000)
    assert pend["state"] == "PENDING"


def _feeds(monkeypatch):
    from app import ict_routes
    bars = bearish_setup_bars()
    feed = {"tf": "M5", "source": "test", "bars": bars, "last_bar_time": "", "last_bar_ms": bars[-1]["timestamp_ms"], "age_seconds": 5,
            "fetched_at": "", "market_closed": False, "is_stale": False, "price": bars[-1]["close"]}

    async def fake_many(tfs, symbol="XAUUSD"):
        return {tf: dict(feed, tf=tf, bars=copy.deepcopy(bars)) for tf in tfs}

    monkeypatch.setattr(ict_routes, "fetch_many", fake_many)


def test_api_scan_saves_history_and_stats(monkeypatch):
    from app.main import app
    _feeds(monkeypatch)
    with TestClient(app) as c:
        r = c.post("/api/ict/scan?tf=M5&ai=false")
        assert r.status_code == 200, r.text
        j = r.json()
        a = j["analysis"]
        assert a["final_direction"] == "SELL" and a["ict_plan"] and a["drawings"] and j["id"]
        rec = c.get(f"/api/history/{j['id']}").json()
        assert rec["tf_secondary"] == "ICT" and rec["stop_loss"] == a["plan"]["stop"]
        c.post(f"/api/history/{j['id']}/outcome", json={"result": "TP1"})
        st = c.get("/api/stats").json()
        assert st["resolved"] == 1 and abs(st["total_r"] - a["plan"]["rr1"]) < 0.02   # real R from the plan, not a fixed 1R


def test_login_when_password_set(monkeypatch):
    import app.main as m
    monkeypatch.setattr(m, "APP_PASSWORD", "secret")
    with TestClient(m.app) as c:
        assert c.get("/api/health").status_code == 401
        assert c.get("/api/health", auth=("jd", "secret")).status_code == 200
        assert c.get("/api/health", auth=("jd", "wrong")).status_code == 401


def _scaled(k=25.0):
    out = []
    for b in bearish_setup_bars():
        out.append({**b, "open": b["open"] * k, "high": b["high"] * k, "low": b["low"] * k, "close": b["close"] * k})
    return out


def test_btcusd_engine_and_validator_scale():
    r = E.scan({"M5": _scaled()}, "M5", "BTCUSD")
    assert r["symbol"] == "BTCUSD" and r["direction"] == "SELL"
    p = r["plan"]
    assert p["stop"] > p["entry_high"] >= p["entry_low"] > p["tp1"] and p["entry"] > 90000
    ok = {"direction": "SELL", "verdict": "APPROVE", "selected_setup": "S1", "referenced_levels": ["ENTRY"], "narrative": f"Sell near {p['entry']}", "confidence": 70}
    assert E.validate_ai_review(ok, r)["accepted"]
    assert not E.validate_ai_review(dict(ok, narrative="Target 91000.0"), r)["accepted"]


def test_symbol_profiles_and_aliases():
    from app import symbols
    assert symbols.normalize("btc/usd") == "BTCUSD" and symbols.normalize("gold") == "XAUUSD"
    assert symbols.matches("BTCUSDT", "BTCUSD") and not symbols.matches("XAUUSD", "BTCUSD")
    try:
        symbols.normalize("EURUSD")
        assert False
    except ValueError:
        pass


def test_screenshot_annotations_keep_ict_labels():
    from app.trade_engine import _sanitize_annotations
    read = {"annotations": [
        {"type": "line", "x1": 100, "y1": 300, "x2": 400, "y2": 300, "label": "BOS", "ict": "bos"},
        {"type": "rect", "x": 500, "y": 400, "w": 80, "h": 40, "label": "FVG", "ict": "FVG"},
        {"type": "text", "x": 300, "y": 120, "label": "Sweep", "ict": "SWEEP"},
        {"type": "line", "x1": 0, "y1": 0, "x2": 5000, "y2": 0},       # out of range -> dropped
        {"type": "circle", "x": 1, "y": 1}]}                            # unknown type -> dropped
    out = _sanitize_annotations(read)
    assert [(a["ict"], a["layer"]) for a in out] == [("BOS", "structure"), ("FVG", "zones"), ("SWEEP", "liquidity")]


def test_analyze_endpoint_rejects_unknown_symbol():
    from app.main import app
    with TestClient(app) as c:
        files = {"primary_image": ("a.png", b"x", "image/png"), "secondary_image": ("b.png", b"x", "image/png")}
        assert c.post("/api/analyze", files=files, data={"symbol": "EURUSD", "tf_primary": "M1", "tf_secondary": "M5"}).status_code == 400


def test_tracker_closes_screenshot_signal_and_daily_stats(monkeypatch):
    import asyncio, json
    from datetime import datetime, timezone
    from app import market_data
    from app.database import AnalysisRecord, SessionLocal
    from app.main import app
    from app.tracker import plan_from_row, run_tracker_once

    now = datetime.now(timezone.utc)
    ts0 = int(now.timestamp() * 1000)
    db = SessionLocal()
    rows = []
    for direction, sl, tp1, tp2 in (("SELL", 4200.0, 4180.0, 4170.0), ("BUY", 4180.0, 4200.0, 4210.0), ("SELL", 4195.0, 4182.0, 4170.0)):
        r = AnalysisRecord(created_at=now, symbol="XAUUSD", tf_primary="M5", tf_secondary="M15", direction=direction, confidence=60.0,
                           entry_low=4189.0, entry_high=4191.0, stop_loss=sl, take_profit_1=tp1, take_profit_2=tp2,
                           image_primary="", image_secondary="", payload_json=json.dumps({"signal_grade": "B"}))
        db.add(r); rows.append(r)
    db.commit(); ids = [r.id for r in rows]
    assert plan_from_row(rows[0], {})["direction"] == "bear" and plan_from_row(rows[1], {})["direction"] == "bull"
    db.close()

    def bar(i, o, h, l, c):
        return {"timestamp_ms": ts0 + i * 300000, "open": o, "high": h, "low": l, "close": c}
    # price dips into the zone, rallies to 4201 (BUY: TP1 4200 hit; SELL #1: SL 4200 hit; SELL #3: SL 4195 hit)
    bars = [bar(1, 4190, 4191.5, 4188.5, 4190), bar(2, 4190, 4201, 4189, 4200.5)]

    async def fake(tf, force=False, symbol="XAUUSD"):
        return {"bars": bars}
    monkeypatch.setattr(market_data, "fetch_candles", fake)
    summary = asyncio.run(run_tracker_once(SessionLocal, AnalysisRecord))
    assert summary["closed"] == 3, summary
    with TestClient(app) as c:
        results = {i: c.get(f"/api/history/{i}").json()["analysis"]["outcome"] for i in ids}
        assert results[ids[1]]["result"] in ("TP1", "TP2") and results[ids[2]]["result"] == "SL"
        assert results[ids[0]]["result"] == "SL" and results[ids[0]]["auto"] is True
        d = c.get("/api/stats/daily?tz_offset_min=0").json()
        t = d["today"]
        assert t["signals"] >= 3 and t["sl"] >= 2 and t["wins"] >= 1 and t["win_rate"] is not None
