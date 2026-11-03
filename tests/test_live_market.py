import asyncio
import unittest
from datetime import datetime, timedelta, timezone
import time
from unittest.mock import patch

from app import live_market
from app.live_market import calculate_live_scan


def synthetic_market(direction="up", stale=False):
    bars = []
    price = 2350.0
    for index in range(90):
        delta = 0.16 if direction == "up" else -0.16
        price += delta
        bars.append({
            "time": datetime(2026, 10, 13, tzinfo=timezone.utc).isoformat(),
            "timestamp_ms": 1791849600000 + index * 60_000,
            "open": price - delta * 0.25,
            "high": price + 0.09,
            "low": price - 0.09,
            "close": price,
            "volume": 10,
        })
    return {
        "symbol": "XAUUSD", "feed_symbol": "XAUUSD=X", "source": "test-feed",
        "interval": "1m", "timeframe": "M1", "price": price,
        "last_bar_time": bars[-1]["time"], "age_seconds": 30, "is_stale": stale,
        "fetched_at": datetime.now(timezone.utc).isoformat(), "bars": bars,
    }


class LiveMarketScanTests(unittest.TestCase):
    def test_fetch_live_market_uses_shared_configured_feed(self):
        source_feed = {
            "source": "Twelve Data · XAU/USD",
            "price": 2350,
            "last_bar_time": "2026-10-13T00:00:00+00:00",
            "last_bar_ms": 1791849600000,
            "fetched_at": "2026-10-13T00:01:00+00:00",
            "age_seconds": 30,
            "is_stale": False,
            "bars": synthetic_market()["bars"],
            "fallback_reason": "Yahoo previously rate-limited",
            "data_quality_status": "GOOD",
        }

        async def fake_fetch_candles(timeframe):
            self.assertEqual(timeframe, "M1")
            return source_feed

        with patch.object(live_market, "fetch_candles", fake_fetch_candles):
            result = asyncio.run(live_market.fetch_live_market("1m"))

        self.assertEqual(result["source"], source_feed["source"])
        self.assertEqual(result["feed_symbol"], "XAU/USD")
        self.assertEqual(result["fallback_reason"], source_feed["fallback_reason"])
        self.assertEqual(result["bars"], source_feed["bars"][-120:])

    def test_fetch_live_market_rejects_unsupported_interval(self):
        with self.assertRaisesRegex(ValueError, "Choose 1m, 5m, 15m or 60m"):
            asyncio.run(live_market.fetch_live_market("2m"))

    def test_cached_market_data_is_marked_stale_after_provider_failure(self):
        from app import market_data

        old_timestamp = int((datetime.now(timezone.utc) - timedelta(hours=1)).timestamp() * 1000)
        cached_feed = {
            "last_bar_ms": old_timestamp,
            "last_bar_time": datetime.fromtimestamp(old_timestamp / 1000, timezone.utc).isoformat(),
            "fetched_at": "old",
            "age_seconds": 0,
            "is_stale": False,
            "source": "cached provider",
            "bars": [],
        }

        class FailedClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return None

            async def get(self, *_args, **_kwargs):
                raise RuntimeError("provider unavailable")

        with patch.object(market_data, "_CACHE", {"XAUUSD:M1": (time.monotonic() - 60, cached_feed)}):
            with patch.object(market_data.httpx, "AsyncClient", lambda **_kwargs: FailedClient()):
                result = asyncio.run(market_data.fetch_candles("M1", force=True))

        self.assertTrue(result["is_stale"])
        self.assertGreater(result["age_seconds"], 300)
        self.assertIn("provider unavailable", result["fallback_reason"])

    def test_bullish_market_has_buy_candidate_and_risk_levels(self):
        result = calculate_live_scan(synthetic_market("up"))
        self.assertEqual(result["direction"], "BUY")
        self.assertIsNotNone(result["entry_low"])
        self.assertIsNotNone(result["stop_loss"])
        self.assertGreater(result["take_profit_2"], result["take_profit_1"])
        self.assertTrue(result["live_market_scan"])
        self.assertEqual(len(result["bars"]), 90)

    def test_bearish_market_has_sell_candidate_and_targets_below_entry(self):
        result = calculate_live_scan(synthetic_market("down"))
        self.assertEqual(result["direction"], "SELL")
        self.assertLess(result["take_profit_1"], result["entry_price"])
        self.assertLess(result["take_profit_2"], result["take_profit_1"])

    def test_stale_feed_disables_direction_and_levels(self):
        result = calculate_live_scan(synthetic_market("up", stale=True))
        self.assertEqual(result["direction"], "WAIT")
        self.assertFalse(result["levels_available"])
        self.assertIsNone(result["entry_low"])
        self.assertIn("stale", result["setup_rationale"].lower())


if __name__ == "__main__":
    unittest.main()
