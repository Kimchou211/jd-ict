from app import news


def test_classify_main_events():
    assert news.classify("Core CPI m/m")[0] == "CORE_CPI"
    assert news.classify("Non-Farm Employment Change")[0] == "NFP"
    assert news.classify("Unemployment Claims")[0] == "JOBLESS"
    assert news.classify("FOMC Press Conference")[0] == "FOMC_PRESS"
    assert news.classify("Fed Chair Powell Speaks")[0] == "FED_SPEECH"


def test_parse_value():
    assert news.parse_value("225K") == 225000
    assert news.parse_value("-0.1%") == -0.1
    assert news.parse_value("1.2M") == 1_200_000
    assert news.parse_value("") is None and news.parse_value("-") is None


def test_hot_cpi_pushes_gold_down():
    r = news.analyze_event("CPI m/m", "0.5%", "0.3%", "0.2%")
    assert r["status"] == "READY" and r["magnitude"] == "STRONG" and r["gold_bias"] == "DOWN" and r["usd_bias"] == "UP"


def test_weak_nfp_and_high_claims_push_gold_up():
    assert news.analyze_event("Non-Farm Employment Change", "90K", "180K", "150K")["gold_bias"] == "UP"
    assert news.analyze_event("Unemployment Claims", "240K", "225K", "220K")["gold_bias"] == "UP"  # claims are inverse


def test_in_line_is_neutral_and_missing_actual_is_pending():
    assert news.analyze_event("CPI m/m", "0.3%", "0.3%", "0.2%")["gold_bias"] == "NEUTRAL"
    assert news.analyze_event("CPI m/m", None, "0.3%", "0.2%")["status"] == "PENDING"


def test_fed_tone_is_manual():
    assert news.analyze_event("Fed Chair Powell Speaks", None, None, None)["status"] == "QUALITATIVE"
    assert news.analyze_event("Fed Chair Powell Speaks", "hawkish", None, None)["gold_bias"] == "DOWN"


def test_blackout_window_is_information_only():
    import time
    from datetime import datetime, timezone
    now = int(time.time() * 1000)
    ev = news._make_event(datetime.fromtimestamp((now + 20 * 60000) / 1000, timezone.utc), "CPI m/m", "USD", "High", "0.3%", "0.2%", None, "t")
    assert news.build_status([ev], now)["blackout"] is True
    assert news.build_status([ev], now - 45 * 60000)["blackout"] is False
    assert news.build_status([ev], now + 90 * 60000)["blackout"] is False
