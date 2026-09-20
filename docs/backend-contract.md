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


## Aperture architettoniche e interventi

Il payload frontend usa `metadata.schemaVersion: 2` e dichiara le feature:

- `architectural-openings`
- `structured-interventions`

### Porte e finestre

Ogni elemento di `openings` resta ancorato al muro tramite dati metrici:

```json
{
  "id": "d-1",
  "type": "door",
  "wallId": "w-3",
  "widthCm": 80,
  "offsetCm": 42,
  "referenceEnd": "a",
  "position": 0.31,
  "swingSide": 1
}
```

Il backend deve trattare porte e finestre come **vuoti reali nel muro**, non come
marker sovrapposti. Nei file SVG/PDF/DXF la linea del muro va interrotta per la
larghezza dell'apertura. Per le porte il frontend supporta il simbolo anta +
arco di apertura; per le finestre il simbolo a linee parallele.

`widthCm`, `offsetCm` e `referenceEnd` sono autoritativi quando disponibili.
`position` resta un fallback/aiuto visuale.

### Interventi di cantiere

Per compatibilità il payload continua a inviare `notes`, ma invia anche
`interventions`. Al momento entrambi contengono gli stessi record; il backend
deve preferire `interventions` quando presente.

Esempio:

```json
{
  "id": "note-1",
  "kind": "intervention",
  "targetType": "floor",
  "targetId": "room-2",
  "targetLabel": "Pavimento · Bagno",
  "roomName": "Bagno",
  "displayStyle": "callout",
  "workItems": [
    {
      "code": "floor_demolish",
      "label": "DEMOLIRE PAVIMENTO",
      "category": "demolition"
    },
    {
      "code": "floor_tile",
      "label": "POSA PIASTRELLE",
      "category": "finish"
    }
  ],
  "rawText": "Nuovo gres 60x120",
  "context": {
    "areaM2": 6.8,
    "wallHeightM": 2.7
  }
}
```

Target supportati:

- `wall`
- `floor`
- `ceiling`
- `room`
- `opening`

Categorie principali:

- `demolition`
- `construction`
- `finish`
- `general`

`displayStyle` può essere:

- `callout`: vignetta con linea di richiamo;
- `text`: testo direttamente sulla planimetria.

Il backend deve conservare questi dati nel JSON strutturato e, quando genera
SVG/PDF/PNG/DXF, rappresentare l'intervento in modo coerente con il target.

Questa struttura è intenzionalmente adatta anche a futuri computi metrici:
`workItems[].code` identifica la lavorazione, mentre `context` contiene le
quantità metriche già disponibili dal rilievo.


## Schema v3: ambienti automatici, foto e computo progressivo

Il frontend dichiara ora:

```json
{
  "metadata": {
    "schemaVersion": 3,
    "features": [
      "architectural-openings",
      "structured-interventions",
      "automatic-rooms",
      "linked-local-photos",
      "progressive-takeoff"
    ]
  }
}
```

### Ambienti automatici

Gli ambienti possono essere creati automaticamente quando il frontend riconosce
una faccia chiusa affidabile.

Esempio:

```json
{
  "id": "room-1",
  "name": "Ambiente 1",
  "wallIds": ["w1", "w2", "w3", "w4"],
  "faceKey": "w1|w2|w3|w4",
  "autoDetected": true,
  "needsNaming": true,
  "detectedQuality": "ok"
}
```

Quando l'utente conferma il nome, `needsNaming` diventa `false`. Il backend
deve conservare il flag ma non deve inventare un nome diverso.

### Foto collegate

Il payload contiene soltanto i metadati delle foto:

```json
{
  "id": "photo-1",
  "targetType": "wall",
  "targetId": "w2",
  "targetLabel": "Muro B · Bagno",
  "roomName": "Bagno",
  "name": "IMG_001.jpg",
  "mime": "image/jpeg",
  "size": 481223,
  "createdAt": "2026-09-20T20:00:00Z",
  "localOnly": true
}
```

Il blob fotografico resta sul dispositivo in IndexedDB. Finché non viene
implementato un endpoint media/upload dedicato, `localOnly: true` significa
che il backend NON deve aspettarsi di poter scaricare il file dalla voce JSON.

### Computo progressivo

Il frontend può allegare un riepilogo già calcolato dagli interventi:

```json
{
  "takeoff": {
    "rows": [
      {
        "code": "floor_tile",
        "label": "POSA PIASTRELLE",
        "category": "finish",
        "value": 6.82,
        "unit": "m²",
        "basis": "floor_area",
        "targets": 1,
        "estimated": false,
        "rooms": ["Bagno"]
      }
    ],
    "unresolved": [],
    "totals": {
      "rows": 1,
      "interventions": 1,
      "unresolved": 0
    }
  }
}
```

Il backend deve ricalcolare o validare le quantità quando dispone di una
geometria autoritativa più aggiornata. Le righe con `estimated: true` devono
restare distinguibili dalle quantità confermate.
