from datetime import datetime, timezone
from sqlalchemy import create_engine, Integer, String, DateTime, Text, Float
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Mapped, mapped_column
from sqlalchemy.pool import NullPool
from .config import DATABASE_URL

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {"connect_timeout": 15}
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    connect_args=connect_args,
    poolclass=NullPool if not DATABASE_URL.startswith("sqlite") else None,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

class AnalysisRecord(Base):
    __tablename__ = "analysis_records"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    symbol: Mapped[str] = mapped_column(String(16), default="XAUUSD")
    tf_primary: Mapped[str] = mapped_column(String(8))
    tf_secondary: Mapped[str] = mapped_column(String(8))
    direction: Mapped[str] = mapped_column(String(8), default="WAIT")
    confidence: Mapped[float] = mapped_column(Float, default=0)
    entry_low: Mapped[float | None] = mapped_column(Float, nullable=True)
    entry_high: Mapped[float | None] = mapped_column(Float, nullable=True)
    stop_loss: Mapped[float | None] = mapped_column(Float, nullable=True)
    take_profit_1: Mapped[float | None] = mapped_column(Float, nullable=True)
    take_profit_2: Mapped[float | None] = mapped_column(Float, nullable=True)
    image_primary: Mapped[str] = mapped_column(String(255))
    image_secondary: Mapped[str] = mapped_column(String(255))
    payload_json: Mapped[str] = mapped_column(Text)
