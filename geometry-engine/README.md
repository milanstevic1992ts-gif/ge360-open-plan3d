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
