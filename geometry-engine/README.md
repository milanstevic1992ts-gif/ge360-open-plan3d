# GE360 Geometry Engine

Motore deterministico offline per sistemare lo schizzo di GE360 Rilievo.

Principio: **lo schizzo suggerisce la forma; le misure definiscono la realtà**.

API:

```js
import { solveFloorPlan, validateFloorPlan } from "./index.js";

const result = solveFloorPlan(plan, { mode: "normal" });
```

Modalità: `light`, `normal`, `strong`.

Le lunghezze `lengthCm` sono vincoli forti e non vengono modificate dal solver.
Porte e finestre usano `widthCm`, `referenceEnd` e `offsetCm`.

Il modulo non usa DOM, rete o LLM.


## Continuità automatica

Dalla versione 1.1 il motore esegue una riparazione topologica prudente prima
del solver geometrico.

- i capi già vicini vengono fusi normalmente;
- i capi liberi quasi coincidenti possono essere ricuciti usando la scala
  stimata dalle misure reali;
- la scelta deve essere sufficientemente non ambigua;
- muri troppo lontani non vengono collegati;
- `lengthCm` non viene mai modificato;
- dopo la ricucitura il solver redistribuisce l'errore sugli angoli per ottenere
  loop geometricamente chiusi quando le misure lo consentono.

Preset indicativi per il massimo gap reale ricucibile:

- `light`: 25 cm;
- `normal`: 50 cm;
- `strong`: 80 cm.

La soglia è anche limitata rispetto alla diagonale dello schizzo, per evitare
agganci tra muri vicini ma appartenenti ad ambienti diversi.

Il risultato espone `stats.repairedJoints`, `topologyRepairs` e lo stato
`closure.closed`.
