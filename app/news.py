"""News layer for the ICT terminal.

Tier 1  economic calendar + blackout window (no AI, so nothing can be hallucinated)
Tier 2  rule-based reading of Actual vs Forecast vs Previous (numbers come from the feed, never from an AI)

Blackout is an INFORMATION banner only. It never blocks a signal: during the window the terminal keeps
analysing as usual, it just puts the news front and centre.

Sources (free): Finnhub economic calendar (needs FINNHUB_API_KEY, has Actual) and the unofficial
Forex Factory weekly JSON (no key, Forecast/Previous only - Actual can be typed in by hand in the UI).
"""
from __future__ import annotations

import hashlib
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from .config import _env

FINNHUB_API_KEY = _env("FINNHUB_API_KEY", "").strip()
BLACKOUT_BEFORE_MIN = int(_env("NEWS_BLACKOUT_BEFORE_MIN", "30"))
BLACKOUT_AFTER_MIN = int(_env("NEWS_BLACKOUT_AFTER_MIN", "30"))
CACHE_SECONDS = int(_env("NEWS_CACHE_SECONDS", "900"))  # Forex Factory rate-limits hard; do not go below ~5 min.

FF_URLS = ("https://nfs.faireconomy.media/ff_calendar_thisweek.json", "https://nfs.faireconomy.media/ff_calendar_nextweek.json")
FINNHUB_URL = "https://finnhub.io/api/v1/calendar/economic"

# --- classification -------------------------------------------------------------------------------
# (category, regex on lower-cased title, label)
CATEGORY_RULES: list[tuple[str, str, str]] = [
    ("NFP", r"non-?farm|nfp", "NFP"),
    ("CORE_PCE", r"core pce", "Core PCE"),
    ("PCE", r"\bpce\b", "PCE"),
    ("CORE_CPI", r"core cpi", "Core CPI"),
    ("CPI", r"\bcpi\b", "CPI"),
    ("PPI", r"\bppi\b", "PPI"),
    ("FOMC_RATE", r"federal funds rate|fed interest rate|interest rate decision", "FOMC Rate"),
    ("FOMC_STATEMENT", r"fomc statement|monetary policy statement", "FOMC Statement"),
    ("FOMC_PRESS", r"fomc press conference", "FOMC Presser"),
    ("FOMC_MINUTES", r"fomc meeting minutes|fomc minutes", "FOMC Minutes"),
    ("FED_SPEECH", r"(fed|fomc).*(speak|testif|speech)|(powell|chair).*(speak|testif)|speaks", "Fed Speech"),
    ("JOBLESS", r"unemployment claims|jobless claims", "Jobless Claims"),
    ("UNEMPLOYMENT", r"unemployment rate", "Unemployment Rate"),
    ("AHE", r"average hourly earnings", "Avg Hourly Earnings"),
    ("GDP", r"\bgdp\b", "GDP"),
    ("RETAIL", r"retail sales", "Retail Sales"),
    ("ISM", r"\bism\b", "ISM"),
    ("JOLTS", r"jolts", "JOLTS"),
    ("ADP", r"\badp\b", "ADP"),
]
# categories that open the blackout window even if the feed under-rates their impact
BLACKOUT_CATS = {"NFP", "CPI", "CORE_CPI", "PCE", "CORE_PCE", "FOMC_RATE", "FOMC_STATEMENT", "FOMC_PRESS", "GDP", "JOBLESS"}
TRACKED = {c for c, _, _ in CATEGORY_RULES}

# polarity: +1 = higher than forecast strengthens USD / yields (gold DOWN first); -1 = the opposite.
# tol = (in-line band, strong threshold) in the unit of the number (pp, K, points).
RULES: dict[str, dict[str, Any]] = {
    "NFP": {"pol": 1, "tol": (10_000, 50_000)}, "ADP": {"pol": 1, "tol": (15_000, 60_000)},
    "CPI": {"pol": 1, "tol": (0.0, 0.2)}, "CORE_CPI": {"pol": 1, "tol": (0.0, 0.2)},
    "PCE": {"pol": 1, "tol": (0.0, 0.2)}, "CORE_PCE": {"pol": 1, "tol": (0.0, 0.2)},
    "PPI": {"pol": 1, "tol": (0.0, 0.3)}, "AHE": {"pol": 1, "tol": (0.0, 0.2)},
    "UNEMPLOYMENT": {"pol": -1, "tol": (0.0, 0.2)}, "JOBLESS": {"pol": -1, "tol": (5_000, 20_000)},
    "GDP": {"pol": 1, "tol": (0.1, 0.4)}, "RETAIL": {"pol": 1, "tol": (0.1, 0.5)},
    "ISM": {"pol": 1, "tol": (0.5, 2.0)}, "JOLTS": {"pol": 1, "tol": (100_000, 400_000)},
    "FOMC_RATE": {"pol": 1, "tol": (0.0, 0.25)},
}
TONE_WORDS = {"hawkish": 1, "dovish": -1, "neutral": 0}
QUALITATIVE = {"FED_SPEECH", "FOMC_STATEMENT", "FOMC_PRESS", "FOMC_MINUTES"}

_cache: dict[str, Any] = {"ts": 0.0, "events": [], "source": None, "error": None}


def classify(title: str) -> tuple[str | None, str | None]:
    t = (title or "").lower()
    for cat, pattern, label in CATEGORY_RULES:
        if re.search(pattern, t):
            return cat, label
    return None, None


def parse_value(raw: Any) -> float | None:
    """'225K' -> 225000, '3.2%' -> 3.2, '-0.1%' -> -0.1, '1.2M' -> 1200000, '52.4' -> 52.4"""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    s = str(raw).strip().replace(",", "")
    if not s or s in ("-", "—"):
        return None
    m = re.match(r"^([<>]?)(-?\d+(?:\.\d+)?)\s*([kKmMbBtT]?)", s)
    if not m:
        return None
    mult = {"": 1, "k": 1e3, "m": 1e6, "b": 1e9, "t": 1e12}[m.group(3).lower()]
    return float(m.group(2)) * mult


def _fmt_value(v: Any) -> str | None:
    if v is None or v == "":
        return None
    return str(v)


def _event_id(ts_ms: int, title: str) -> str:
    return hashlib.sha1(f"{ts_ms}|{title}".encode()).hexdigest()[:10]


def _make_event(ts: datetime, title: str, country: str, impact: str, forecast: Any, previous: Any, actual: Any, source: str) -> dict:
    ts_ms = int(ts.astimezone(timezone.utc).timestamp() * 1000)
    cat, label = classify(title)
    impact = (impact or "").lower()
    impact = {"high": "high", "medium": "medium", "low": "low"}.get(impact, "low")
    blackout = impact == "high" or cat in BLACKOUT_CATS or (cat == "FED_SPEECH" and "chair" in title.lower())
    return {
        "id": _event_id(ts_ms, title), "ts_ms": ts_ms, "iso": ts.astimezone(timezone.utc).isoformat(), "title": title, "country": country,
        "impact": impact, "category": cat, "label": label or title, "forecast": _fmt_value(forecast), "previous": _fmt_value(previous),
        "actual": _fmt_value(actual), "blackout": bool(blackout), "source": source,
    }


def _relevant(ev: dict) -> bool:
    return ev["country"] == "USD" and (ev["impact"] == "high" or ev["category"] in TRACKED)


async def _fetch_finnhub(client: httpx.AsyncClient) -> list[dict]:
    today = datetime.now(timezone.utc).date()
    params = {"from": (today - timedelta(days=1)).isoformat(), "to": (today + timedelta(days=14)).isoformat(), "token": FINNHUB_API_KEY}
    r = await client.get(FINNHUB_URL, params=params)
    if r.status_code >= 400:
        raise RuntimeError(f"Finnhub {r.status_code}")
    rows = (r.json() or {}).get("economicCalendar") or []
    out = []
    for row in rows:
        if str(row.get("country", "")).upper() != "US":
            continue
        try:
            ts = datetime.strptime(str(row["time"])[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        unit = row.get("unit") or ""
        fmt = lambda v: None if v is None else f"{v:g}{unit if unit in ('%', 'K', 'M', 'B') else ''}"  # noqa: E731
        out.append(_make_event(ts, str(row.get("event", "")), "USD", row.get("impact") or "", fmt(row.get("estimate")), fmt(row.get("prev")), fmt(row.get("actual")), "Finnhub"))
    return out


async def _fetch_ff(client: httpx.AsyncClient) -> list[dict]:
    out, ok = [], 0
    for url in FF_URLS:
        try:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (JD-ANALYSIS)"})
            if r.status_code >= 400:
                continue
            rows = r.json()
        except Exception:
            continue
        ok += 1
        for row in rows if isinstance(rows, list) else []:
            try:
                ts = datetime.fromisoformat(str(row["date"]))
            except (KeyError, ValueError):
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            out.append(_make_event(ts, str(row.get("title", "")), str(row.get("country", "")).upper(), str(row.get("impact", "")), row.get("forecast"), row.get("previous"), row.get("actual"), "Forex Factory"))
    if not ok:
        raise RuntimeError("Forex Factory feed unavailable (rate-limited or offline)")
    return out


async def load_events(force: bool = False) -> dict:
    """Cached calendar. Keeps serving the last good copy if the provider fails (stale=True)."""
    now = time.time()
    if not force and _cache["events"] and now - _cache["ts"] < CACHE_SECONDS:
        return {"events": _cache["events"], "source": _cache["source"], "stale": False, "error": None, "fetched_at": _cache["ts"]}
    events, source, errors = [], None, []
    async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=8.0)) as client:
        if FINNHUB_API_KEY:
            try:
                events, source = await _fetch_finnhub(client), "Finnhub"
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc)[:120])
        if not events:
            try:
                events, source = await _fetch_ff(client), "Forex Factory"
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc)[:120])
    events = sorted((e for e in events if _relevant(e)), key=lambda e: e["ts_ms"])
    if events:
        _cache.update(ts=now, events=events, source=source, error=None)
        return {"events": events, "source": source, "stale": False, "error": None, "fetched_at": now}
    _cache["error"] = "; ".join(errors) or "no events"
    return {"events": _cache["events"], "source": _cache["source"], "stale": True, "error": _cache["error"], "fetched_at": _cache["ts"] or None}


# --- tier 2: rule-based reading -------------------------------------------------------------------
def analyze_event(title: str, actual: Any, forecast: Any, previous: Any, category: str | None = None) -> dict:
    cat = category or classify(title)[0]
    a, f, p = parse_value(actual), parse_value(forecast), parse_value(previous)
    base = {"category": cat, "status": "PENDING", "magnitude": None, "usd_bias": "NEUTRAL", "gold_bias": "NEUTRAL", "score": 0,
            "surprise": None, "surprise_pct": None, "vs_previous": None, "note_km": "", "note_en": "", "caution_km": ""}
    if cat in QUALITATIVE or cat is None and str(actual or "").strip().lower() in TONE_WORDS:
        tone = str(actual or "").strip().lower()
        if tone in TONE_WORDS:
            d = TONE_WORDS[tone]
            base.update(status="READY", magnitude="MILD" if d else "IN_LINE", usd_bias="UP" if d > 0 else "DOWN" if d < 0 else "NEUTRAL",
                        gold_bias="DOWN" if d > 0 else "UP" if d < 0 else "NEUTRAL", score=-d,
                        note_km={1: "សម្លេង Hawkish → ដុល្លារ/yield ឡើង → មាសធ្លាក់ជាមុន", -1: "សម្លេង Dovish → ដុល្លារ/yield ធ្លាក់ → មាសឡើងជាមុន", 0: "សម្លេង Neutral → ទីផ្សារប្រហែលជាមិនមានទិសដៅច្បាស់"}[d],
                        note_en={1: "Hawkish tone → USD/yields up → gold dips first", -1: "Dovish tone → USD/yields down → gold bids first", 0: "Neutral tone → no clear edge"}[d],
                        caution_km="Fed speech ប្រែប្រួលតាមប្រយោគ ហើយ spike ជាញឹកញាប់ត្រឡប់វិញ")
        else:
            base.update(note_km="គ្មានលេខ forecast សម្រាប់ព្រឹត្តិការណ៍នេះ។ ស្តាប់ tone រួចជ្រើស Hawkish / Dovish / Neutral ក្នុង UI ដើម្បីឲ្យ rule វិភាគ។",
                        note_en="No numeric forecast. Pick the tone (Hawkish / Dovish / Neutral) in the UI so the rule can read it.", status="QUALITATIVE")
        return base
    if a is None:
        base["note_km"], base["note_en"] = "ចាំលទ្ធផល Actual (feed ឬបញ្ចូលដោយដៃ)។", "Waiting for the Actual value (feed or manual entry)."
        return base
    rule = RULES.get(cat or "")
    if f is None or rule is None:
        base.update(status="NO_FORECAST", note_km="គ្មាន Forecast ឬ rule សម្រាប់ព្រឹត្តិការណ៍នេះ — មិនអាចវាស់ surprise បានទេ។", note_en="No Forecast or rule for this event, so the surprise cannot be measured.")
        if p is not None:
            base["vs_previous"] = "HIGHER" if a > p else "LOWER" if a < p else "SAME"
        return base
    diff = a - f
    inline, strong = rule["tol"]
    mag = "IN_LINE" if abs(diff) <= inline + 1e-9 else "STRONG" if abs(diff) >= strong - 1e-9 else "MILD"
    pol = rule["pol"]
    direction = 0 if mag == "IN_LINE" else (1 if diff > 0 else -1) * pol  # +1 => USD up
    usd = "UP" if direction > 0 else "DOWN" if direction < 0 else "NEUTRAL"
    gold = "DOWN" if direction > 0 else "UP" if direction < 0 else "NEUTRAL"
    pct = (diff / abs(f) * 100) if f else None
    vs_prev = None if p is None else "HIGHER" if a > p else "LOWER" if a < p else "SAME"
    word = "ខ្ពស់ជាង" if diff > 0 else "ទាបជាង"
    word_en = "above" if diff > 0 else "below"
    label = classify(title)[1] or title
    if mag == "IN_LINE":
        km, en = f"{label} ស្របតាម Forecast → surprise តូច មាសអាចឆ្លើយតបខ្សោយ ឬច្របូកច្របល់", f"{label} in line with Forecast → small surprise, muted/choppy reaction"
    else:
        strength_km = "ខ្លាំង" if mag == "STRONG" else "បន្តិច"
        km = f"{label} {word} Forecast ({strength_km}) → ដុល្លារ/yield {'ឡើង' if direction > 0 else 'ធ្លាក់'} → មាស{'ធ្លាក់' if gold == 'DOWN' else 'ឡើង'}ភ្លាមៗ"
        en = f"{label} {word_en} Forecast ({mag.lower()}) → USD/yields {'up' if direction > 0 else 'down'} → gold {'dips' if gold == 'DOWN' else 'pops'} first"
    base.update(status="READY", magnitude=mag, usd_bias=usd, gold_bias=gold, score=(-direction) * (2 if mag == "STRONG" else 1 if mag == "MILD" else 0),
                surprise=round(diff, 4), surprise_pct=None if pct is None else round(pct, 1), vs_previous=vs_prev, note_km=km, note_en=en,
                caution_km="spike ដំបូងជាញឹកញាប់ត្រឡប់វិញ (fake-out) — រង់ចាំ M5/M15 បិទ candle និង structure ICT មុនចូល" if mag != "IN_LINE" else "")
    return base


def with_analysis(ev: dict) -> dict:
    return {**ev, "analysis": analyze_event(ev["title"], ev["actual"], ev["forecast"], ev["previous"], ev["category"])}


def _clusters(events: list[dict]) -> list[dict]:
    """Events released at the same moment (NFP + Unemployment + AHE ...) are summed into one net read for gold."""
    by_ts: dict[int, list[dict]] = {}
    for e in events:
        if e["analysis"]["status"] == "READY":
            by_ts.setdefault(e["ts_ms"], []).append(e)
    out = []
    for ts, items in by_ts.items():
        if len(items) < 2:
            continue
        net = sum(i["analysis"]["score"] for i in items)
        out.append({"ts_ms": ts, "titles": [i["label"] for i in items], "net_score": net,
                    "gold_bias": "UP" if net > 0 else "DOWN" if net < 0 else "MIXED",
                    "note_km": f"សរុប {len(items)} ទិន្នន័យ → មាស {'ទំនោរឡើង' if net > 0 else 'ទំនោរធ្លាក់' if net < 0 else 'ច្របូកច្របល់ (ទិន្នន័យទាស់គ្នា)'}"})
    return out


def build_status(events: list[dict], now_ms: int | None = None) -> dict:
    now_ms = now_ms or int(time.time() * 1000)
    before, after = BLACKOUT_BEFORE_MIN * 60_000, BLACKOUT_AFTER_MIN * 60_000
    active = [e for e in events if e["blackout"] and e["ts_ms"] - before <= now_ms <= e["ts_ms"] + after]
    upcoming = [e for e in events if e["ts_ms"] > now_ms]
    nxt = next((e for e in upcoming if e["blackout"]), upcoming[0] if upcoming else None)
    recent = [e for e in events if now_ms - 6 * 3_600_000 <= e["ts_ms"] <= now_ms]
    return {"now_ms": now_ms, "blackout": bool(active), "window_min": {"before": BLACKOUT_BEFORE_MIN, "after": BLACKOUT_AFTER_MIN},
            "active": active, "next": nxt, "countdown_ms": (nxt["ts_ms"] - now_ms) if nxt else None, "recent_count": len(recent)}


async def events_payload(force: bool = False) -> dict:
    data = await load_events(force)
    evs = [with_analysis(e) for e in data["events"]]
    now_ms = int(time.time() * 1000)
    status = build_status(data["events"], now_ms)
    status["next"] = with_analysis(status["next"]) if status["next"] else None
    status["active"] = [with_analysis(e) for e in status["active"]]
    cutoff = now_ms - 36 * 3_600_000
    shown = [e for e in evs if e["ts_ms"] >= cutoff]
    return {"source": data["source"], "stale": data["stale"], "error": data["error"], "fetched_at": data["fetched_at"], "has_actual_feed": data["source"] == "Finnhub",
            "status": status, "events": shown, "clusters": _clusters(shown), "keywords": sorted(TRACKED)}


async def context() -> dict:
    """Small summary that is attached to every ICT scan (and given to the AI mentor as data)."""
    try:
        data = await load_events()
        s = build_status(data["events"])
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "message": str(exc)[:160]}
    nxt = s["next"]
    ctx = {"available": bool(data["events"]), "blackout": s["blackout"], "source": data["source"], "stale": data["stale"],
           "active": [{"title": e["title"], "minutes_from_release": round((s["now_ms"] - e["ts_ms"]) / 60000)} for e in s["active"]],
           "next": None if not nxt else {"title": nxt["title"], "impact": nxt["impact"], "in_minutes": round((nxt["ts_ms"] - s["now_ms"]) / 60000), "ts_ms": nxt["ts_ms"]}}
    return ctx
