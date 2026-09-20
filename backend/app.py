import json
import os
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field


API_KEY = os.environ.get("GE360_RILIEVO_API_KEY", "")
DATA_DIR = Path(os.environ.get("GE360_RILIEVO_DATA_DIR", "/var/lib/ge360-rilievo"))
INBOX_DIR = DATA_DIR / "inbox"
OUTBOX_DIR = DATA_DIR / "outbox"

INBOX_DIR.mkdir(parents=True, exist_ok=True)
OUTBOX_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="GE360 Rilievo Planner Bridge", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://localhost", "http://localhost", "capacitor://localhost"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-GE360-API-Key"],
)


class PlanPayload(BaseModel):
    model_config = ConfigDict(extra="allow")

    version: int = 4
    kind: str = "ge360-rough-survey"
    planId: str
    name: str = "Rilievo"
    updatedAt: str | None = None
    rawStrokes: list = Field(default_factory=list)
    walls: list = Field(default_factory=list)
    openings: list = Field(default_factory=list)
    rooms: list = Field(default_factory=list)
    wallHeightM: float = 2.70
    surfaces: dict | None = None
    summary: dict = Field(default_factory=dict)


def require_key(x_ge360_api_key: str | None) -> None:
    if not API_KEY:
        raise HTTPException(status_code=503, detail="GE360_RILIEVO_API_KEY not configured")
    if not x_ge360_api_key or not secrets.compare_digest(x_ge360_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Invalid API key")


@app.get("/api/v1/health")
def health(x_ge360_api_key: str | None = Header(default=None)):
    require_key(x_ge360_api_key)
    return {"ok": True, "service": "ge360-rilievo-planner-bridge"}


@app.post("/api/v1/plans/refine")
def refine_plan(payload: PlanPayload, x_ge360_api_key: str | None = Header(default=None)):
    require_key(x_ge360_api_key)

    job_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    envelope = {
        "jobId": job_id,
        "receivedAt": now,
        "status": "queued",
        "plan": payload.model_dump(),
    }

    target = INBOX_DIR / f"{job_id}.json"
    target.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")

    # Hook futuro:
    # 1. leggere il JSON grezzo
    # 2. passarlo al planner/solver geometrico professionale
    # 3. salvare il risultato in OUTBOX_DIR / f"{job_id}.json"
    # 4. aggiungere endpoint GET /api/v1/jobs/{job_id}

    return {
        "ok": True,
        "jobId": job_id,
        "status": "queued",
        "message": "Rilievo ricevuto dal Debian",
    }
