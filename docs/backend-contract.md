# GE360 Rilievi — contratto frontend/backend

## Stato rilevato il 20/09/2026

La repository collegata `milanstevic1992ts-gif/ge360-rilievi-backend-` contiene attualmente solo il bootstrap README e non espone ancora endpoint runtime verificabili.

Il frontend implementa quindi il contratto richiesto per GE360 Rilievi senza fingere che il backend sia già disponibile.

## Base URL e autenticazione

Il valore salvato nelle impostazioni deve puntare alla base API, ad esempio:

`https://server-ge360/api/v1`

Ogni richiesta usa:

`X-GE360-API-Key: <chiave salvata localmente>`

La chiave non è presente nel repository.

## Endpoint richiesti dal frontend

- `GET /health`
- `POST /plans`
- `POST /plans/{planId}/process`
- `GET /plans/{planId}`
- `GET /plans/{planId}/processed`
- `GET /plans/{planId}/versions`
- `POST /plans/{planId}/reprocess`

Gli URL degli elaborati non vengono inventati dal viewer: devono arrivare nelle risposte backend dentro `files`, `artifacts` o `outputs`.

Formati riconosciuti:

- `preview`
- `svg`
- `png`
- `pdf`
- `dxf`
- `json`
- `plan3d`
- `glb`
- `zip`

Sono accettati anche alias comuni come `svg_url`, `processed_plan`, `plan3d_json`, `glb_url`.

## Identificatore remoto

`POST /plans` deve restituire uno fra:

- `remotePlanId`
- `remote_plan_id`
- `planId`
- `plan_id`
- `id`

Il frontend lo memorizza in `plan.backend.remotePlanId`.

## Stati

Il frontend gestisce:

`LOCAL`, `UPLOADING`, `RAW`, `QUEUED`, `PROCESSING`, `PROCESSED`, `NEEDS_REVIEW`, `ERROR`.

Durante `RAW/QUEUED/PROCESSING` effettua polling circa ogni 2 secondi. Dopo 180 secondi interrompe il polling ma NON trasforma automaticamente il job in errore.

## Versioni

`GET /plans/{planId}/versions` può restituire:

`{ "versions": [...] }`

oppure:

`{ "items": [...] }`

Ogni versione può avere `version`, `created_at`, `status`, `warnings`, `summary`, `files`.

`reprocess` deve creare una nuova versione senza eliminare quelle precedenti.

## Source revision

Il frontend calcola `sourceRevision` solo dai dati significativi del rilievo:

- rawStrokes
- walls
- openings
- rooms
- notes
- wallHeightM
- surfaces

La geometria in pixel NON viene usata per ricalcolare `lengthCm`: la misura inserita dall'utente resta autoritativa.

Il backend dovrebbe restituire la stessa `sourceRevision` nell'elaborato. Se manca, il frontend associa alla versione completata la revisione inviata.

## Elaborati protetti

Preview e file vengono scaricati con fetch autenticato e trasformati in Blob locali. Questo permette a SVG/PNG/PDF/GLB protetti da API key di funzionare senza mettere la chiave nella URL.

## 3D

Il frontend supporta:

- `plan3d.json`
- `GLB`

Three.js è caricato in lazy load soltanto quando l'utente apre il viewer 3D.

## Da implementare/verificare nel backend

Finché la repository backend resta bootstrap non sono verificabili end-to-end:

1. persistenza piani;
2. job asincroni;
3. status polling;
4. generazione PDF/DXF/PNG/SVG/JSON;
5. generazione plan3d/GLB;
6. ZIP;
7. versioning/reprocess;
8. warning `NEEDS_REVIEW`;
9. autorizzazione file con `X-GE360-API-Key`.

Il vecchio bridge presente nella repository frontend espone ancora `/api/v1/plans/refine` e `/api/v1/notes/rewrite`; non è il nuovo contratto GE360 Rilievi.
