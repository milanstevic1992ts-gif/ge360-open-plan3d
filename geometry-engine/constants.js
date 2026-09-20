/**
 * GE360 Rilievo — Geometry Engine
 * Costanti, preset delle modalità e risoluzione delle opzioni.
 *
 * Tutte le tolleranze angolari sono in GRADI, quelle di lunghezza in CM,
 * la tolleranza di fusione nodi è nelle unità dello SCHIZZO (px).
 */

export const ENGINE_VERSION = "1.0.0";

/**
 * Preset delle tre modalità. Ogni valore può essere sovrascritto
 * passando la stessa chiave in `options`.
 */
export const MODE_PRESETS = Object.freeze({
  light: Object.freeze({
    angleSnapTolerance: 4,
    axisSnapTolerance: 4,
    collinearTolerance: 2,
    parallelTolerance: 3,
    nonAdjacentParallel: "none",
    maxClosureGapCm: 3,
    sketchWeight: 0.3,
    alignToAxes: false,
  }),
  normal: Object.freeze({
    angleSnapTolerance: 8,
    axisSnapTolerance: 8,
    collinearTolerance: 4,
    parallelTolerance: 5,
    nonAdjacentParallel: "topological",
    maxClosureGapCm: 5,
    sketchWeight: 0.1,
    alignToAxes: false,
  }),
  strong: Object.freeze({
    angleSnapTolerance: 12,
    axisSnapTolerance: 12,
    collinearTolerance: 6,
    parallelTolerance: 8,
    nonAdjacentParallel: "component",
    maxClosureGapCm: 10,
    sketchWeight: 0.05,
    alignToAxes: true,
  }),
});

export const DEFAULT_OPTIONS = Object.freeze({
  mode: "normal",
  nodeMergeTolerance: null,
  nodeMergeToleranceRatio: 0.015,
  closureToleranceCm: 0.05,
  closureInfoThresholdCm: 1,
  proportionWarningRatio: 3,
  duplicateLengthToleranceCm: 1,
  openingToleranceCm: 0.01,
  maxIterations: 200,
  maxRelaxations: 8,
  maxShapeDeviationDeg: 25,
  relaxCandidates: 4,
  timeBudgetMs: 400,
  precision: 3,
});

export function resolveOptions(options = {}) {
  const warnings = [];
  const input = options && typeof options === "object" ? options : {};
  let mode = input.mode ?? DEFAULT_OPTIONS.mode;
  if (!MODE_PRESETS[mode]) {
    warnings.push({
      type: "unknown_mode",
      severity: "warning",
      message: `Modalità "${mode}" sconosciuta: uso "normal".`,
    });
    mode = "normal";
  }
  const opts = { ...DEFAULT_OPTIONS, ...MODE_PRESETS[mode] };
  for (const [k, v] of Object.entries(input)) {
    if (k !== "mode" && v !== undefined) opts[k] = v;
  }
  opts.mode = mode;
  return { opts, warnings };
}
