from pathlib import Path
import os
from dotenv import dotenv_values

ROOT_DIR = Path(__file__).resolve().parent.parent
_ENV_VALUES = dotenv_values(ROOT_DIR / ".env") if (ROOT_DIR / ".env").exists() else {}


def _env(name: str, default: str = "") -> str:
    if os.getenv(name) is not None:
        return os.getenv(name)
    value = _ENV_VALUES.get(name)
    return default if value is None else str(value)


APP_NAME = _env("APP_NAME", "JD ANALYSIS")
DATABASE_URL = _env("DATABASE_URL", "").strip()
GEMINI_API_KEY = _env("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = _env("GEMINI_MODEL", "gemini-3.6-flash").strip()
DEEPSEEK_API_KEY = _env("DEEPSEEK_API_KEY", "").strip()
DEEPSEEK_VISION_MODEL = _env("DEEPSEEK_VISION_MODEL", "deepseek-flash").strip()
DEEPSEEK_CHAT_MODEL = _env("DEEPSEEK_CHAT_MODEL", "deepseek-flash").strip()
MAX_UPLOAD_MB = int(_env("MAX_UPLOAD_MB", "12"))
CONFIDENCE_MINIMUM = int(_env("CONFIDENCE_MINIMUM", "65"))
PRICE_AGREEMENT_ABSOLUTE = float(_env("PRICE_AGREEMENT_ABSOLUTE", "0.50"))
ATR_AGREEMENT_PERCENT = float(_env("ATR_AGREEMENT_PERCENT", "0.20"))
# FORCE_SIGNAL=true  -> return a best-effort direction when one can be inferred; not trade-ready.
# FORCE_SIGNAL=false -> strict mode (returns WAIT when validation checks fail).
FORCE_SIGNAL = _env("FORCE_SIGNAL", "true").strip().lower() in ("1", "true", "yes", "on")
UPLOAD_DIR = ROOT_DIR / "uploads"
DATA_DIR = ROOT_DIR / "data"
STATIC_DIR = ROOT_DIR / "static"
UPLOAD_DIR.mkdir(exist_ok=True)
DATA_DIR.mkdir(exist_ok=True)

if DATABASE_URL:
    # SQLAlchemy 2 + psycopg 3 URL normalization for Neon URLs.
    if DATABASE_URL.startswith("postgres://"):
        DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgres://"):]
    elif DATABASE_URL.startswith("postgresql://") and "+psycopg" not in DATABASE_URL:
        DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgresql://"):]
else:
    DATABASE_URL = f"sqlite:///{(DATA_DIR / 'jd_analysis.db').as_posix()}"

# ---- ICT upgrade ---------------------------------------------------------------------------
TWELVEDATA_API_KEY = _env("TWELVEDATA_API_KEY", "").strip()
TWELVEDATA_SYMBOL = _env("TWELVEDATA_SYMBOL", "XAU/USD").strip()
APP_USER = _env("APP_USER", "jd").strip()
APP_PASSWORD = os.getenv("APP_PASSWORD", "").strip()  # Prefer shell env for auth; .env stays non-auth by default.
ICT_MIN_SCORE = int(_env("ICT_MIN_SCORE", "60"))
ICT_AI_LANGUAGE = _env("ICT_AI_LANGUAGE", "Khmer").strip()
AUTO_TRACK = _env("AUTO_TRACK", "true").strip().lower() in ("1", "true", "yes", "on")
AUTO_TRACK_SECONDS = int(_env("AUTO_TRACK_SECONDS", "90"))


def _hours(name: str, default: str) -> tuple[float, float]:
    raw = _env(name, default)
    try:
        a, b = raw.split("-")
        return float(a), float(b)
    except ValueError:
        a, b = default.split("-")
        return float(a), float(b)


# Session windows in UTC hours. ICT kill zones are defined in New York time, so they shift by an
# hour with US daylight saving; edit these in .env if you want the winter values (London 7-10, NY 13-16).
ICT_ASIA_UTC = _hours("ICT_ASIA_UTC", "0-7")
ICT_LONDON_KZ_UTC = _hours("ICT_LONDON_KZ_UTC", "7-10")
ICT_NY_KZ_UTC = _hours("ICT_NY_KZ_UTC", "12-15")
