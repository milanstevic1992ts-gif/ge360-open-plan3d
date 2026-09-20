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
