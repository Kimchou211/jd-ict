"""Synthetic M5 XAUUSD candles that contain a textbook bearish ICT setup:
range -> swing high -> liquidity sweep (wick above, close back inside) -> displacement down (FVG) -> MSS."""
from datetime import datetime, timezone

START = int(datetime(2026, 10, 27, 8, 0, tzinfo=timezone.utc).timestamp() * 1000)  # Tuesday 08:00 UTC (London kill zone)


def _bar(i, o, h, l, c, step=300_000):
    return {"timestamp_ms": START + i * step, "time": "", "open": o, "high": h, "low": l, "close": c, "volume": 0}


def _lin(points, wick=0.3):
    bars, prev = [], points[0][1]
    for (i0, p0), (i1, p1) in zip(points, points[1:]):
        for i in range(i0 + 1, i1 + 1):
            c = p0 + (p1 - p0) * (i - i0) / (i1 - i0)
            bars.append((i, prev, max(prev, c) + wick, min(prev, c) - wick, c))
            prev = c
    return bars


def bearish_setup_bars(extra_tail=0):
    pts = [(0, 4000.0), (12, 4009.0), (24, 4003.0), (36, 4010.0), (44, 4004.0), (51, 4009.5)]
    rows = [(0, 4000.0, 4000.3, 3999.7, 4000.0)] + _lin(pts)
    rows += [
        (52, 4009.5, 4011.0, 4008.8, 4008.0),   # sweep: wick above 4010.3 swing high, closes back inside
        (53, 4008.0, 4008.2, 4002.2, 4002.5),   # displacement leg
        (54, 4002.5, 4002.7, 3996.8, 3997.0),
        (55, 3997.0, 3997.5, 3993.8, 3994.0),   # bear FVG = [3997.5, 4002.2] (middle candle 54)
    ]
    tail = [3994.5, 3994.2, 3994.8, 3994.4, 3994.6] + [3994.5] * extra_tail
    prev = 3994.0
    for k, c in enumerate(tail):
        rows.append((56 + k, prev, max(prev, c) + 0.3, min(prev, c) - 0.3, c))
        prev = c
    return [_bar(*r) for r in rows]
