import unittest

from app.trade_engine import build_strict_read


def provider(name: str, confidence: int, pullback_zones: dict) -> dict:
    return {
        "provider": name,
        "direction": "WAIT",
        "confidence": confidence,
        "pullback_zones": pullback_zones,
        "chart_reads": [{}, {}],
    }


class PullbackZoneTests(unittest.TestCase):
    def test_returns_buy_and_sell_zones_in_conditional_setups(self) -> None:
        result = build_strict_read(
            [
                provider(
                    "Gemini",
                    68,
                    {
                        "BUY": {
                            "low": 2344.5,
                            "high": 2346.0,
                            "quality": "estimated",
                            "basis": "Support retest.",
                        },
                        "SELL": {
                            "low": 2353.0,
                            "high": 2354.5,
                            "quality": "estimated",
                            "basis": "Resistance retest.",
                        },
                    },
                )
            ],
            {},
            "M1",
            "M5",
        )

        buy, sell = result["conditional_setups"]
        self.assertEqual((buy["direction"], buy["pullback_low"], buy["pullback_high"]), ("BUY", 2344.5, 2346.0))
        self.assertEqual((sell["direction"], sell["pullback_low"], sell["pullback_high"]), ("SELL", 2353.0, 2354.5))
        self.assertEqual(buy["pullback_quality"], "axis_estimate")
        self.assertFalse(result["trade_ready"])

    def test_agreeing_printed_zones_are_averaged_and_corroborated(self) -> None:
        zones = {
            "BUY": {"low": 2344.0, "high": 2346.0, "quality": "read", "basis": "Printed support."},
            "SELL": {"low": None, "high": None, "quality": "unavailable", "basis": ""},
        }
        result = build_strict_read(
            [provider("Gemini", 70, zones), provider("DeepSeek", 75, zones)],
            {},
            "M1",
            "M5",
        )

        buy = result["conditional_setups"][0]
        self.assertEqual((buy["pullback_low"], buy["pullback_high"]), (2344.0, 2346.0))
        self.assertEqual(buy["pullback_quality"], "corroborated")
        self.assertEqual(buy["pullback_agreement"], "agreed")

    def test_rejects_invalid_or_unavailable_prices(self) -> None:
        result = build_strict_read(
            [
                provider(
                    "Gemini",
                    70,
                    {
                        "BUY": {"low": 2346.0, "high": 2344.0, "quality": "read"},
                        "SELL": {"low": None, "high": None, "quality": "unavailable"},
                    },
                )
            ],
            {},
            "M1",
            "M5",
        )

        for setup in result["conditional_setups"]:
            self.assertIsNone(setup["pullback_low"])
            self.assertIsNone(setup["pullback_high"])
            self.assertEqual(setup["pullback_quality"], "unavailable")


if __name__ == "__main__":
    unittest.main()
