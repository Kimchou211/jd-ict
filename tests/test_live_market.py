import unittest
from datetime import datetime, timezone

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
