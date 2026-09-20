# GE360 Rilievo — bridge Debian

Questo servizio riceve gli schizzi dall'APK e li mette in coda per il planner professionale.

## API

- `GET /api/v1/health`
- `POST /api/v1/plans/refine`
- Header obbligatorio: `X-GE360-API-Key`

## Chiave API

Non salvare la chiave nella repo.

Generala sul Debian:

```bash
openssl rand -hex 32
```

Poi avvia il servizio con:

```bash
export GE360_RILIEVO_API_KEY='INCOLLA_LA_CHIAVE'
export GE360_RILIEVO_DATA_DIR='/var/lib/ge360-rilievo'
uvicorn backend.app:app --host 0.0.0.0 --port 8796
```

Nell'APK imposta come URL:

```
https://TUO-SERVER/api/v1
```

La chiave viene conservata localmente sul telefono e inviata nell'header `X-GE360-API-Key`.

## Planner professionale

Il bridge salva ogni richiesta in `/var/lib/ge360-rilievo/inbox`.

Il prossimo passo è collegare qui un solver geometrico/planner che:
- usa le misure reali come vincoli principali;
- usa lo schizzo solo per topologia e forma;
- raddrizza parallelismi e angoli;
- segnala misure incompatibili invece di modificarle di nascosto;
- restituisce planimetria pulita JSON/SVG/DXF/PDF.


## Payload v4

Il bridge conserva anche i dati frontend introdotti nella versione 4:

- `rooms`
- `wallHeightM`
- `surfaces`

In questo modo l'invio al Debian non perde nomi ambiente o riepiloghi superfici.


## LLM locale per "Sistema appunti"

Il bridge può riscrivere gli appunti di cantiere usando un modello Ollama locale.

Variabili:

```bash
export GE360_OLLAMA_URL='http://127.0.0.1:11434'
export GE360_OLLAMA_MODEL='qwen2.5:7b'
export GE360_OLLAMA_TIMEOUT='45'
```

Endpoint:

```
POST /api/v1/notes/rewrite
```

È protetto dalla stessa intestazione:

```
X-GE360-API-Key
```

L'app invia:
- testo grezzo;
- tipo di elemento;
- ambiente;
- misure e superficie disponibili come contesto.

Il prompt server impone al modello di non inventare lavorazioni, misure, materiali o prezzi. Il testo originale viene sempre conservato nel rilievo.

Se il modello configurato non è installato in Ollama, impostare `GE360_OLLAMA_MODEL` su un modello già disponibile oppure installarne uno prima di avviare il bridge.
