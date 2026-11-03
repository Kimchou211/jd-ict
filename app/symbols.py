"""Per-symbol profiles so every module (feed, ICT engine, screenshot validator, prompts) scales correctly."""
from __future__ import annotations

from contextvars import ContextVar

PROFILES: dict[str, dict] = {
    "XAUUSD": {"name": "XAUUSD", "label": "Gold / USD", "td": "XAU/USD", "yahoo": "XAUUSD=X", "aliases": {"XAUUSD", "XAUUSDM", "GOLD", "GOLDUSD"},
               "price_min": 500, "price_max": 10000, "price_abs": 0.5, "price_pct": 0.0005, "atr_abs": 0.05, "atr_floor": 0.05,
               "tol_floor": 0.3, "buf_floor": 0.3, "gap_floor": 0.05, "agree_abs": 1.0, "weekend_closed": True},
    "BTCUSD": {"name": "BTCUSD", "label": "Bitcoin / USD", "td": "BTC/USD", "yahoo": "BTC-USD", "aliases": {"BTCUSD", "BTCUSDT", "BTCUSDM", "BITCOIN", "XBTUSD"},
               "price_min": 1000, "price_max": 1_000_000, "price_abs": 10.0, "price_pct": 0.0005, "atr_abs": 1.0, "atr_floor": 1.0,
               "tol_floor": 8.0, "buf_floor": 5.0, "gap_floor": 1.0, "agree_abs": 40.0, "weekend_closed": False},
}
DEFAULT = "XAUUSD"
_ACTIVE: ContextVar[str] = ContextVar("active_symbol", default=DEFAULT)


def normalize(symbol: str | None) -> str:
    s = (symbol or DEFAULT).upper().replace("/", "").replace("-", "").replace(" ", "")
    if s in PROFILES:
        return s
    for name, p in PROFILES.items():
        if s in p["aliases"]:
            return name
    raise ValueError(f"Unsupported symbol '{symbol}'. Use one of: {', '.join(PROFILES)}.")


def profile(symbol: str | None = None) -> dict:
    return PROFILES[normalize(symbol or _ACTIVE.get())]


def set_active(symbol: str | None) -> None:
    _ACTIVE.set(normalize(symbol))


def matches(detected: str, symbol: str | None = None) -> bool:
    p = profile(symbol)
    d = str(detected or "").upper().replace("/", "").replace("-", "").replace(" ", "")
    return d in p["aliases"]
