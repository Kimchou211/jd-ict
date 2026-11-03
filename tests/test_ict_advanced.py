from datetime import datetime, timezone

import pytest

from app.ict_advanced import SPEC, classify_regime, detect_cisd, detect_displacement, session_info
from app import market_data


def _hourly_history(drop_index=None):
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    last_bucket = now_ms // (4 * 3_600_000) * (4 * 3_600_000) - 4 * 3_600_000
    start = last_bucket - 79 * 4 * 3_600_000
    bars = []
    for i in range(320):
        if i == drop_index:
            continue
        ts = start + i * 3_600_000
        close = 2000 + i / 10
        bars.append({"timestamp_ms": ts, "time": datetime.fromtimestamp(ts / 1000, timezone.utc).isoformat(),
                     "open": close - 0.1, "high": close + 0.4, "low": close - 0.3,
                     "close": close, "volume": 2})
    return {"tf": "H1", "source": "fixture", "bars": bars}


def test_shared_spec_defines_engine_periods_and_timeframes():
    assert SPEC["indicators"]["atr_period"] == 14
    assert SPEC["timeframes_minutes"]["W1"] == 10080
    assert SPEC["risk"]["minimum_theoretical_rr"] == 1.5


def test_session_uses_new_york_dst_transitions():
    winter = session_info(int(datetime(2026, 1, 15, 8, 0, tzinfo=timezone.utc).timestamp() * 1000))
    summer = session_info(int(datetime(2026, 7, 15, 8, 0, tzinfo=timezone.utc).timestamp() * 1000))
    assert winter["utc_offset_minutes"] == -300
    assert summer["utc_offset_minutes"] == -240
    assert winter["name"] == summer["name"] == "LONDON_KZ"


def test_advanced_measurements_return_explicit_states():
    bars = [
        {"timestamp_ms": i * 300_000, "open": 100 + (i % 2), "high": 103 + i, "low": 99 + i, "close": 102 + i}
        for i in range(35)
    ]
    bars[-4].update(open=140, high=142, low=139, close=141)
    bars[-3].update(open=141, high=143, low=140, close=142)
    bars[-2].update(open=142, high=144, low=141, close=143.5)
    bars[-1].update(open=143.5, high=144, low=135, close=135.2)
    displacement = detect_displacement(bars, 2)
    cisd = detect_cisd(bars, 2)
    regime = classify_regime(bars, "bear", 2)
    assert displacement["classification"] in ("MODERATE", "STRONG", "EXTREME")
    assert cisd["status"] == "confirmed" and cisd["direction"] == "bear"
    assert regime["regime"] in ("TRENDING_BEARISH", "HIGH_VOLATILITY")
    assert regime["confidence"] > 0


def test_h4_aggregation_uses_ohlcv_and_marks_missing_source_intervals():
    feed = _hourly_history()
    aggregated = market_data.aggregate_feed(feed, "H4", "XAUUSD")
    assert len(aggregated["bars"]) == 80
    assert aggregated["bars"][0]["open"] == feed["bars"][0]["open"]
    assert aggregated["bars"][0]["high"] == max(bar["high"] for bar in feed["bars"][:4])
    assert aggregated["bars"][0]["low"] == min(bar["low"] for bar in feed["bars"][:4])
    assert aggregated["bars"][0]["volume"] == 8
    assert aggregated["aggregation_source"] == "H1"
    assert aggregated["data_quality_status"] == "GOOD"

    incomplete = market_data.aggregate_feed(_hourly_history(drop_index=100), "H4", "XAUUSD")
    assert len(incomplete["bars"]) == 79
    assert incomplete["missing_candle_count"] == 1
    assert incomplete["data_quality_status"] == "DEGRADED"


def test_engine_rejects_duplicate_out_of_order_and_invalid_candles():
    from app import ict_engine

    with pytest.raises(ValueError, match="unique, increasing"):
        ict_engine._validated_candles({"M5": [
            {"timestamp_ms": 1, "open": 1, "high": 2, "low": 0, "close": 1},
            {"timestamp_ms": 1, "open": 1, "high": 2, "low": 0, "close": 1},
        ]})
    with pytest.raises(ValueError, match="invalid OHLC"):
        ict_engine._validated_candles({"M5": [
            {"timestamp_ms": 1, "open": 1, "high": 0.5, "low": 0, "close": 1},
        ]})
