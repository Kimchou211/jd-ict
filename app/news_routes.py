"""News API: calendar + blackout status, and a stateless rule analysis (used for manually typed Actual values)."""
from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from . import news

router = APIRouter(prefix="/api/news", tags=["news"])


class AnalyzeRequest(BaseModel):
    title: str = Field(max_length=200)
    actual: str | None = Field(default=None, max_length=40)
    forecast: str | None = Field(default=None, max_length=40)
    previous: str | None = Field(default=None, max_length=40)


@router.get("/events")
async def events(refresh: bool = Query(default=False)) -> dict:
    return await news.events_payload(force=refresh)


@router.get("/status")
async def status() -> dict:
    return await news.context()


@router.post("/analyze")
def analyze(body: AnalyzeRequest) -> dict:
    return news.analyze_event(body.title, body.actual, body.forecast, body.previous)
