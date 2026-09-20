# GE360 Rilievo

Frontend mobile da cantiere per creare planimetrie indicative in modo rapido.

## Filosofia

Il telefono non è un CAD e non sostituisce un rilievo professionale.

1. Disegna la stanza o la casa con il dito, anche in modo approssimativo.
2. Inserisci le misure reali dei muri.
3. Aggiungi porte e finestre con larghezza e distanza dall'angolo.
4. Assegna un nome agli ambienti.
5. Il motore geometrico offline rende lo schizzo più presentabile senza inventare le misure.
6. L'app calcola superfici indicative di pavimento, soffitto e pareti lorde.
7. La modalità PRESENTA mostra una tavola pulita da usare in cantiere o con il cliente.

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
- bridge Debian opzionale.

## Moduli

- `index.html` — UI;
- `css/app.css` — stile mobile;
- `js/app.js` — logica frontend;
- `js/room-surfaces.js` — riconoscimento ambienti e superfici;
- `geometry-engine/` — solver geometrico deterministico offline;
- `backend/` — bridge FastAPI opzionale per Debian.

## Nota sulle superfici

Le superfici sono pensate per uso pratico da cantiere.

- piccoli gap possono essere chiusi virtualmente per stimare l'area;
- pareti lorde = lunghezza pareti × altezza;
- porte e finestre non vengono sottratte;
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
