import json
import os
import secrets
import uuid
from urllib import error as urlerror
from urllib import request as urlrequest
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field


API_KEY = os.environ.get("GE360_RILIEVO_API_KEY", "")
DATA_DIR = Path(os.environ.get("GE360_RILIEVO_DATA_DIR", "/var/lib/ge360-rilievo"))
INBOX_DIR = DATA_DIR / "inbox"
OUTBOX_DIR = DATA_DIR / "outbox"
OLLAMA_BASE_URL = os.environ.get("GE360_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("GE360_OLLAMA_MODEL", "qwen2.5:7b")
OLLAMA_TIMEOUT = float(os.environ.get("GE360_OLLAMA_TIMEOUT", "45"))

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


class NoteRewriteRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    rawText: str
    planId: str | None = None
    planName: str | None = None
    targetType: str
    targetId: str | None = None
    targetLabel: str | None = None
    roomName: str | None = None
    context: dict = Field(default_factory=dict)


class NoteRewriteResponse(BaseModel):
    ok: bool = True
    model: str
    rawText: str
    cleanedText: str
    tasks: list[str] = Field(default_factory=list)
    needsClarification: list[str] = Field(default_factory=list)


def require_key(x_ge360_api_key: str | None) -> None:
    if not API_KEY:
        raise HTTPException(status_code=503, detail="GE360_RILIEVO_API_KEY not configured")
    if not x_ge360_api_key or not secrets.compare_digest(x_ge360_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Invalid API key")


@app.get("/api/v1/health")
def health(x_ge360_api_key: str | None = Header(default=None)):
    require_key(x_ge360_api_key)
    return {
        "ok": True,
        "service": "ge360-rilievo-planner-bridge",
        "llm": {"provider": "ollama", "model": OLLAMA_MODEL, "configured": bool(OLLAMA_BASE_URL)},
    }


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


def _ollama_chat_json(system_prompt: str, user_prompt: str) -> dict:
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "format": "json",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "options": {"temperature": 0.15},
    }

    req = urlrequest.Request(
        OLLAMA_BASE_URL + "/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlrequest.urlopen(req, timeout=OLLAMA_TIMEOUT) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urlerror.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise HTTPException(status_code=502, detail=f"Ollama HTTP {exc.code}: {detail[:300]}")
    except (urlerror.URLError, TimeoutError) as exc:
        raise HTTPException(status_code=503, detail=f"Ollama non raggiungibile: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Errore chiamata Ollama: {exc}")

    content = ((body.get("message") or {}).get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=502, detail="Ollama ha restituito una risposta vuota")

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        parsed = {"cleanedText": content, "tasks": [], "needsClarification": []}

    return parsed


@app.post("/api/v1/notes/rewrite", response_model=NoteRewriteResponse)
def rewrite_note(payload: NoteRewriteRequest, x_ge360_api_key: str | None = Header(default=None)):
    require_key(x_ge360_api_key)

    raw = payload.rawText.strip()
    if not raw:
        raise HTTPException(status_code=422, detail="Appunto vuoto")
    if len(raw) > 5000:
        raise HTTPException(status_code=422, detail="Appunto troppo lungo")

    system_prompt = """Sei l'assistente tecnico di un artigiano edile.
Il tuo unico compito è riscrivere appunti grezzi di cantiere in italiano chiaro e professionale.

REGOLE OBBLIGATORIE:
- Non inventare lavorazioni, quantità, misure, materiali, cause o dettagli non presenti.
- Non trasformare ipotesi in fatti.
- Mantieni esattamente misure e numeri forniti.
- Se una frase è ambigua, inseriscila in needsClarification invece di completarla di fantasia.
- Ordina le lavorazioni in una sequenza pratica quando il testo lo consente.
- Separa le lavorazioni in tasks brevi e operative.
- cleanedText deve essere una versione leggibile e pronta da usare in un rilievo/preventivo.
- Non aggiungere prezzi.
- Non fare calcoli non richiesti.

Restituisci SOLO JSON valido con questa struttura:
{
  "cleanedText": "testo riscritto",
  "tasks": ["lavorazione 1", "lavorazione 2"],
  "needsClarification": ["eventuale punto da chiarire"]
}
"""

    context = {
        "planName": payload.planName,
        "targetType": payload.targetType,
        "targetLabel": payload.targetLabel,
        "roomName": payload.roomName,
        "context": payload.context,
        "rawText": raw,
    }
    user_prompt = (
        "Riscrivi questo appunto di cantiere. Usa il contesto solo per capire a cosa si riferisce, "
        "non per aggiungere lavorazioni.\n\nDATI:\n"
        + json.dumps(context, ensure_ascii=False, indent=2)
    )

    result = _ollama_chat_json(system_prompt, user_prompt)
    cleaned = str(result.get("cleanedText") or raw).strip()
    tasks = [str(x).strip() for x in (result.get("tasks") or []) if str(x).strip()]
    clarifications = [
        str(x).strip() for x in (result.get("needsClarification") or []) if str(x).strip()
    ]

    return NoteRewriteResponse(
        model=OLLAMA_MODEL,
        rawText=raw,
        cleanedText=cleaned,
        tasks=tasks,
        needsClarification=clarifications,
    )
