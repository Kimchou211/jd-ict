from pydantic import BaseModel, Field
from typing import Any, Literal

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    analysis_id: int | None = None

class StatusResponse(BaseModel):
    app: str
    database: str
    providers: dict[str, bool]
    market_data: str = "image-only"

class RecordSummary(BaseModel):
    id: int
    created_at: str
    tf_primary: str
    tf_secondary: str
    direction: str
    confidence: float
    entry_low: float | None = None
    entry_high: float | None = None
    stop_loss: float | None = None
    take_profit_1: float | None = None
    take_profit_2: float | None = None
    image_primary: str
    image_secondary: str
    analysis: dict[str, Any]


class OutcomeRequest(BaseModel):
    result: Literal["TP1", "TP2", "SL", "SKIP", "CLEAR"]
