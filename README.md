# GE360 Rilievo

Frontend mobile da cantiere per creare planimetrie indicative in modo rapido.

## Filosofia

Il telefono non è un CAD e non sostituisce un rilievo professionale.

1. Disegna la stanza o la casa con il dito, anche in modo approssimativo.
2. Inserisci le misure reali dei muri.
3. Aggiungi porte e finestre con larghezza e distanza dall'angolo.
4. Assegna un nome agli ambienti.
5. Il motore geometrico offline rende lo schizzo più presentabile senza inventare le misure.
6. L'app calcola superfici indicative di pavimento, soffitto e pareti lorde (anteprima offline).
7. **CALCOLO PROFESSIONALE**: il server GE360 ricostruisce la pianta dalle misure e restituisce m² esatti per stanza.
8. La modalità PRESENTA mostra una tavola pulita da usare in cantiere o con il cliente.

## Funzioni principali

- libreria locale dei rilievi;
- schizzo touch;
- zoom e rotazione;
- modifica rapida delle misure;
- porte e finestre modificabili/eliminabili;
- ambienti nominabili;
- superfici indicative con stati `OK`, `STIMATO`, `DA VERIFICARE`;
- modalità `SISTEMA PIANTA`;
- modalità `PRESENTA`;
- appunti collegati a ambiente, pavimento, soffitto, muro e aperture;
- riscrittura appunti tramite LLM locale sul Debian/Ollama;
- esportazione JSON;
- **calcolo professionale sul server** (`ge360-rilievi-backend`) con risultato nell'app;
- **quote punto-punto** (diagonali e posizione dei tramezzi);
- altezza e davanzale di porte e finestre, altezza e rivestimento per stanza;
- misure al millimetro.

## Calcolo professionale

`CALCOLA` (dashboard), `FATTO` o `Strumenti → CALCOLO PROFESSIONALE` inviano il rilievo, attendono il job
e mostrano il risultato:

- pianta ricostruita dal server (misurato / calcolato / stimato da schizzo / da verificare);
- totali e, per ogni stanza, pavimento, soffitto, pareti nette e lorde, aperture, spallette,
  rivestimento, pittura, battiscopa, perimetro, volume;
- domande del server: toccandole si apre il tastierino sul muro giusto o lo strumento QUOTA;
- download di PDF, DXF e PNG (condivisione Android tramite Filesystem/Share);
- avviso "rilievo cambiato dopo il calcolo" con RICALCOLA.

I muri non misurati si possono inviare (`lengthCm: null`): il server li calcola dalle altre misure quando è
possibile e dice esplicitamente quali mancano davvero. Lo schizzo resta solo una traccia.

Nel pannello di calcolo si impostano altezza pareti, spessore muri e come sono state prese le misure
(filo interno per stanza / lunghezze totali attraverso i tramezzi / tutto in asse).

### Quote punto-punto

`Strumenti → QUOTA / DIAGONALE`: tocca due angoli e inserisci la distanza.
Serve per le stanze fuori squadra (diagonale) e per fissare **dove** sta un tramezzo
(distanza da un angolo all'attacco del tramezzo). Le quote sono agganciate agli estremi dei muri e li seguono.

## Moduli

- `index.html` — UI;
- `css/app.css` — stile mobile;
- `js/app.js` — logica frontend;
- `js/room-surfaces.js` — riconoscimento ambienti e superfici (anteprima offline);
- `js/plan-payload.js` — payload v4 + rilievo fedele v2 per il backend;
- `js/backend-client.js` — invio, attesa del job, risultato e download;
- `js/backend-results.js` — risultato compatto, domande → azioni, disegno della pianta calcolata;
- `js/backend-bridge.js` — QR GE360 Direct Bridge;
- `geometry-engine/` — solver geometrico deterministico offline.

Il vecchio bridge FastAPI in `backend/` è stato rimosso: il backend è `ge360-rilievi-backend`.

## Nota sulle superfici

Le superfici sono pensate per uso pratico da cantiere.

- piccoli gap possono essere chiusi virtualmente per stimare l'area;
- pareti lorde = lunghezza pareti × altezza;
- porte e finestre non vengono sottratte (lo fa il CALCOLO PROFESSIONALE);
- soffitto = superficie del pavimento;
- i risultati non sono un elaborato catastale o professionale.

## Avvio web locale

Servire la repo con un server HTTP, per esempio:

```bash
python3 -m http.server 8080
```

Poi aprire:

```
http://127.0.0.1:8080
```

## Android

Il workflow `GE360 Rilievo APK` parte solo su pull request verso `main` o manualmente con `workflow_dispatch`.
