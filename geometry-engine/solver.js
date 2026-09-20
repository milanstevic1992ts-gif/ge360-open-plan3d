import { resolveOptions, ENGINE_VERSION } from "./constants.js";
import { analyzePlan } from "./validation.js";
import { detectConstraintCandidates, buildGrouping } from "./constraints.js";
import { placeOpenings } from "./openings.js";
import { circularMean, fmt, levenbergMarquardt, round, toDeg, wrapAngle, DEG, HALF_PI } from "./geometry.js";

const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

export function solveFloorPlan(input, options = {}) {
  const t0 = now();
  const { opts, warnings: optionWarnings } = resolveOptions(options);
  const an = analyzePlan(input, opts);
  const errors = an.errors.slice();
  const warnings = [...optionWarnings, ...an.warnings];
  const planId = input && typeof input === "object" && input.planId !== undefined ? input.planId : null;
  const walls = an.walls;

  if (!an.solvableIdx.length) {
    return {
      success: false,
      status: "invalid",
      engineVersion: ENGINE_VERSION,
      planId,
      mode: opts.mode,
      walls: walls.map((w) => ({ id: w.id, a: null, b: null, lengthCm: Number.isFinite(w.L) ? w.L : null, status: "excluded", excludedReason: w.reason })),
      nodes: [],
      openings: placeOpenings(an.openings, walls, new Map(), opts.precision),
      constraints: emptyConstraints(),
      warnings,
      errors: errors.length ? errors : [{ type: "nothing_to_solve", severity: "error", message: "Nessun muro utilizzabile." }],
      closure: { closed: false, errorCm: null, loops: [] },
      changes: [],
      stats: { originalWallCount: walls.length, solvedWallCount: 0, timeMs: round(now() - t0, 2) },
    };
  }

  const ctx = { walls, active: an.solvableIdx, wallNodes: an.wallNodes, nodeCount: an.nodes.length, topo: an.topo, opts };
  const candidates = detectConstraintCandidates(ctx);

  const deadline = t0 + opts.timeBudgetMs;
  let released = new Set();
  let grouping = buildGrouping(ctx, candidates, released);
  let sol = solveGeometry(ctx, grouping);
  let iterations = sol.iterations;
  const releaseLog = [];

  for (let r = 0; r < opts.maxRelaxations; r++) {
    const bad = sol.gaps.filter((g) => g.norm > opts.maxClosureGapCm && !an.topo.cycles[g.cycle].impossible);
    if (!bad.length) break;
    if (now() > deadline) {
      warnings.push({ type: "time_budget_exceeded", severity: "warning", message: "Tempo di calcolo esaurito durante la ricerca dei vincoli da rilasciare: risultato parziale." });
      break;
    }
    const cands = relaxationCandidates(ctx, grouping, sol, bad, released);
    if (!cands.length) break;
    const cur = excess(sol.gaps, opts);
    let best = null;
    for (const w of cands) {
      const trial = new Set(released);
      trial.add(w);
      const g2 = buildGrouping(ctx, candidates, trial);
      const s2 = solveGeometry(ctx, g2);
      iterations += s2.iterations;
      const score = excess(s2.gaps, opts);
      const distortion = maxDistortion(ctx, s2.theta);
      if (distortion > opts.maxShapeDeviationDeg * DEG) continue;
      if (!best || score < best.score - 1e-3 || (Math.abs(score - best.score) <= 1e-3 && distortion < best.distortion)) {
        best = { w, g2, s2, score, distortion };
      }
      if (now() > deadline) break;
    }
    if (!best || best.score > cur * 0.9 - 1e-9) break;
    released = new Set(released).add(best.w);
    releaseLog.push({
      wall: best.w,
      gapBeforeCm: Math.max(...bad.map((g) => g.norm)),
      gapAfterCm: Math.max(0, ...best.s2.gaps.map((g) => g.norm))
    });
    grouping = best.g2;
    sol = best.s2;
  }

  let globalRotation = 0;
  const hasWorld = ctx.active.some((w) => grouping.rootOf[w] === grouping.WORLD);
  if (opts.alignToAxes && !hasWorld && sol.x.length) {
    const tot = new Float64Array(sol.x.length);
    for (const w of ctx.active) if (sol.wallVar[w] >= 0) tot[sol.wallVar[w]] += walls[w].L;
    let v = 0;
    for (let k = 1; k < tot.length; k++) if (tot[k] > tot[v]) v = k;
    const phi = sol.x[v];
    globalRotation = Math.round(phi / HALF_PI) * HALF_PI - phi;
    if (Math.abs(globalRotation) > 1e-12) {
      const x = Float64Array.from(sol.x, (val) => val + globalRotation);
      sol = { ...sol, ...sol.evaluate(x), x };
    }
  }

  const P = opts.precision;
  const topo = an.topo;
  const compOffset = topo.components.map((c) => {
    const r0 = an.nodes[topo.components[0].root];
    const rc = an.nodes[c.root];
    return c.index === 0 ? { x: 0, y: 0 } : { x: (rc.x - r0.x) * an.scale, y: (rc.y - r0.y) * an.scale };
  });
  const nodePos = (n) => {
    const o = compOffset[topo.nodeComp[n]];
    return { x: sol.px[n] + o.x, y: sol.py[n] + o.y };
  };
  const nonTreeSet = new Set(topo.nonTree.map((e) => e.wall));
  const geom = new Map();

  for (const w of ctx.active) {
    const [na, nb] = ctx.wallNodes[w];
    const A = nodePos(na);
    const t = sol.theta[w];
    const B = nonTreeSet.has(w)
      ? { x: A.x + walls[w].L * Math.cos(t), y: A.y + walls[w].L * Math.sin(t) }
      : nodePos(nb);
    geom.set(w, { A, B, theta: t, L: walls[w].L });
  }

  const pt = (p) => ({ x: round(p.x, P), y: round(p.y, P) });
  let maxLenErr = 0;
  const wallsOut = walls.map((w) => {
    let g = geom.get(w.index);
    if (g) {
      const solved = Math.hypot(g.B.x - g.A.x, g.B.y - g.A.y);
      maxLenErr = Math.max(maxLenErr, Math.abs(solved - w.L));
      return {
        id: w.id,
        a: pt(g.A),
        b: pt(g.B),
        lengthCm: w.L,
        angleDeg: round(toDeg(wrapAngle(g.theta)), 4),
        status: "solved"
      };
    }
    if (w.reason === "duplicate_wall" && geom.has(w.duplicateOf)) {
      g = geom.get(w.duplicateOf);
      const [A, B] = w.reversed ? [g.B, g.A] : [g.A, g.B];
      return {
        id: w.id,
        a: pt(A),
        b: pt(B),
        lengthCm: w.L,
        status: "excluded",
        excludedReason: "duplicate_wall",
        duplicateOf: walls[w.duplicateOf].id
      };
    }
    return {
      id: w.id,
      a: null,
      b: null,
      lengthCm: Number.isFinite(w.L) ? w.L : null,
      status: "excluded",
      excludedReason: w.reason
    };
  });

  const nodesOut = [];
  for (let n = 0; n < an.nodes.length; n++) {
    if (topo.nodeComp[n] < 0) continue;
    nodesOut.push({ id: `n${n}`, ...pt(nodePos(n)), walls: topo.adj[n].map((e) => walls[e.w].id) });
  }

  const W = grouping.WORLD;
  const constraints = emptyConstraints();
  let snapped = 0;
  let parallels = 0;
  let maxConstraintErr = 0;
  const groupTypes = new Map();
  const releasedSet = released;

  for (const c of candidates) {
    const st = grouping.status[c.id];
    const wallsIds = c.i === W ? [walls[c.j].id] : [walls[c.i].id, walls[c.j].id];
    constraints.details.push({
      type: c.type,
      walls: wallsIds,
      confidence: round(c.confidence, 3),
      sketchDeviationDeg: round(c.deviationDeg, 2),
      status: st
    });
    if (st !== "applied") continue;
    const ti = c.i === W ? 0 : sol.theta[c.i];
    maxConstraintErr = Math.max(maxConstraintErr, Math.abs(wrapAngle(sol.theta[c.j] - ti - c.delta)));
    const root = grouping.rootOf[c.j];
    if (!groupTypes.has(root)) groupTypes.set(root, new Set());
    groupTypes.get(root).add(c.type);
    if (c.type === "horizontal" || c.type === "vertical") {
      constraints[c.type].push(wallsIds[0]);
      snapped++;
    } else {
      constraints[c.type].push(wallsIds);
      if (c.type === "perpendicular") snapped++;
      else parallels++;
    }
  }

  for (const rl of releaseLog) {
    const w = rl.wall;
    const dev = toDeg(Math.abs(wrapAngle(sol.theta[w] - walls[w].s)));
    warnings.push({
      type: "constraint_released",
      severity: "warning",
      message: `Vincoli d'angolo sul muro ${walls[w].id} rilasciati: con le misure inserite la forma suggerita dallo schizzo non può chiudersi (scarto ridotto da ${fmt(rl.gapBeforeCm)} a ${fmt(rl.gapAfterCm)} cm). Il muro risulta ruotato di ${fmt(dev)}° rispetto allo schizzo.`,
      walls: [walls[w].id],
    });
  }

  const loops = [];
  let maxGap = 0;

  for (const g of sol.gaps) {
    const cy = topo.cycles[g.cycle];
    maxGap = Math.max(maxGap, g.norm);
    const closed = g.norm <= opts.closureToleranceCm;
    const loop = {
      walls: cy.walls.map((w) => walls[w].id),
      closingWall: walls[cy.closingWall].id,
      closed,
      errorCm: round(g.norm, 2),
      gapVector: { x: round(g.vx, P), y: round(g.vy, P) },
    };
    loops.push(loop);
    if (closed || cy.impossible) continue;

    const ux = g.vx / g.norm;
    const uy = g.vy / g.norm;
    let involved = cy.walls.filter(
      (w) => Math.abs(Math.cos(sol.theta[w]) * ux + Math.sin(sol.theta[w]) * uy) >= 0.7
    );
    if (!involved.length) involved = cy.walls;

    warnings.push({
      type: "closure_error",
      severity: g.norm < opts.closureInfoThresholdCm ? "info" : "warning",
      message: `La stanza non chiude. Scarto geometrico: ${fmt(g.norm)} cm.`,
      walls: involved.map((w) => walls[w].id),
      loopWalls: loop.walls,
      gapCm: loop.errorCm,
      gapVector: loop.gapVector,
    });

    if (g.norm > opts.maxClosureGapCm) {
      errors.push({
        type: "closure_inconsistent",
        severity: "error",
        message: `Le misure del loop (${loop.walls.join(", ")}) non sono compatibili con la forma disegnata: scarto ${fmt(g.norm)} cm anche dopo aver rilasciato i vincoli d'angolo. Ricontrollare le misure.`,
        walls: loop.walls,
      });
    }
  }

  const closure = {
    closed: loops.length > 0 && loops.every((l) => l.closed),
    errorCm: loops.length ? round(maxGap, 2) : null,
    loops,
  };
  if (!loops.length) closure.reason = "no_loop";

  const changes = [];
  for (const w of ctx.active) {
    const orig = toDeg(walls[w].s);
    const solved = toDeg(wrapAngle(sol.theta[w]));
    const delta = toDeg(wrapAngle(sol.theta[w] - walls[w].s));
    const r = grouping.rootOf[w];
    let reason;

    if (releasedSet.has(w)) reason = "constraint_released";
    else if (r === W) reason = Math.round(sol.theta[w] / HALF_PI) % 2 === 0 ? "horizontal_snap" : "vertical_snap";
    else {
      const types = groupTypes.get(r) ?? new Set();
      if (types.has("perpendicular")) reason = "perpendicular_snap";
      else if (types.has("collinear")) reason = "collinear_snap";
      else if (types.has("parallel")) reason = "parallel_snap";
      else reason = Math.abs(delta) > 0.05 ? "closure_adjustment" : "unchanged";
    }

    if (Math.abs(delta) > 0.01 || reason === "constraint_released") {
      changes.push({
        wallId: walls[w].id,
        originalAngleDeg: round(orig, 2),
        solvedAngleDeg: round(solved, 2),
        deltaDeg: round(delta, 2),
        reason
      });
    }
  }

  const openings = placeOpenings(an.openings, walls, geom, P);
  const hasWarn = warnings.some((w) => w.severity === "warning");
  const status = errors.length ? "partial" : hasWarn || !closure.closed ? "solved_with_warnings" : "solved";

  return {
    success: errors.length === 0,
    status,
    engineVersion: ENGINE_VERSION,
    planId,
    mode: opts.mode,
    units: "cm",
    walls: wallsOut,
    nodes: nodesOut,
    openings,
    constraints,
    warnings,
    errors,
    closure,
    changes,
    stats: {
      originalWallCount: walls.length,
      solvedWallCount: ctx.active.length,
      excludedWallCount: walls.length - ctx.active.length,
      snappedAngles: snapped,
      parallelConstraints: parallels,
      releasedWalls: releaseLog.length,
      closureErrorCm: closure.errorCm ?? 0,
      loopCount: loops.length,
      componentCount: topo.components.length,
      freeOrientationGroups: sol.x.length,
      globalRotationDeg: round(toDeg(globalRotation), 4),
      iterations,
      timeMs: round(now() - t0, 2),
    },
    verification: {
      maxLengthErrorCm: maxLenErr,
      maxConstraintErrorDeg: toDeg(maxConstraintErr),
    },
  };
}

function emptyConstraints() {
  return { perpendicular: [], parallel: [], collinear: [], horizontal: [], vertical: [], details: [] };
}

function maxDistortion(ctx, theta) {
  let m = 0;
  for (const w of ctx.active) m = Math.max(m, Math.abs(wrapAngle(theta[w] - ctx.walls[w].s)));
  return m;
}

function excess(gaps, opts) {
  let s = 0;
  for (const g of gaps) s += Math.max(0, g.norm - opts.maxClosureGapCm);
  return s;
}

function relaxationCandidates(ctx, grouping, sol, bad, released) {
  const scores = new Map();
  for (const g of bad) {
    const cy = ctx.topo.cycles[g.cycle];
    const ux = g.vx / g.norm;
    const uy = g.vy / g.norm;

    for (const w of cy.walls) {
      if (released.has(w) || !grouping.constrained.has(w)) continue;
      const t = sol.theta[w];
      const cap = Math.abs(-Math.sin(t) * ux + Math.cos(t) * uy);
      const conf = grouping.minConf.get(w) ?? 1;
      const sc = cap * (1.25 - conf) * ctx.walls[w].L;
      scores.set(w, Math.max(scores.get(w) ?? 0, sc));
    }
  }

  return [...scores.entries()]
    .filter(([, s]) => s > 1e-9)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, ctx.opts.relaxCandidates)
    .map(([w]) => w);
}

function solveGeometry(ctx, grouping) {
  const { walls, active, topo, opts, wallNodes } = ctx;
  const n = walls.length;
  const W = grouping.WORLD;
  const varOfRoot = new Map();
  const wallVar = new Int32Array(n).fill(-1);

  for (const w of active) {
    const r = grouping.rootOf[w];
    if (r === W) continue;
    if (!varOfRoot.has(r)) varOfRoot.set(r, varOfRoot.size);
    wallVar[w] = varOfRoot.get(r);
  }

  const nv = varOfRoot.size;
  const angs = Array.from({ length: nv }, () => []);
  const wts = Array.from({ length: nv }, () => []);

  for (const w of active) {
    const v = wallVar[w];
    if (v < 0) continue;
    angs[v].push(walls[w].s - grouping.offOf[w]);
    wts[v].push(walls[w].L);
  }

  const x0 = new Float64Array(nv);
  for (let v = 0; v < nv; v++) x0[v] = circularMean(angs[v], wts[v]);

  const theta = new Float64Array(n);
  const px = new Float64Array(ctx.nodeCount);
  const py = new Float64Array(ctx.nodeCount);
  const nt = topo.nonTree;
  const priorWalls = active.filter((w) => wallVar[w] >= 0);
  const m = nt.length * 2 + priorWalls.length;

  const setTheta = (x) => {
    for (const w of active) {
      const v = wallVar[w];
      theta[w] = (v < 0 ? 0 : x[v]) + grouping.offOf[w];
    }
  };

  const layout = () => {
    for (const c of topo.components) {
      px[c.root] = 0;
      py[c.root] = 0;
    }
    for (const te of topo.treeEdges) {
      const L = walls[te.wall].L;
      const t = theta[te.wall];
      px[te.child] = px[te.parent] + te.sign * L * Math.cos(t);
      py[te.child] = py[te.parent] + te.sign * L * Math.sin(t);
    }
  };

  const makeFn = (ws) => (x) => {
    setTheta(x);
    layout();
    const r = new Float64Array(m);
    let k = 0;

    for (const e of nt) {
      const w = e.wall;
      const [na, nb] = wallNodes[w];
      const L = walls[w].L;
      r[k++] = px[na] + L * Math.cos(theta[w]) - px[nb];
      r[k++] = py[na] + L * Math.sin(theta[w]) - py[nb];
    }

    for (const w of priorWalls) r[k++] = ws * walls[w].L * wrapAngle(theta[w] - walls[w].s);
    return r;
  };

  let iterations = 0;
  let x = x0;

  if (nv > 0) {
    const s1 = levenbergMarquardt(makeFn(opts.sketchWeight), x0, { maxIterations: opts.maxIterations });
    const s2 = levenbergMarquardt(makeFn(opts.sketchWeight * 1e-6), s1.x, { maxIterations: opts.maxIterations });
    x = s2.x;
    iterations = s1.iterations + s2.iterations;
  }

  const evaluate = (xx) => {
    setTheta(xx);
    layout();

    const gaps = nt.map((e) => {
      const w = e.wall;
      const [na, nb] = wallNodes[w];
      const L = walls[w].L;
      const vx = px[na] + L * Math.cos(theta[w]) - px[nb];
      const vy = py[na] + L * Math.sin(theta[w]) - py[nb];
      return { wall: w, cycle: e.cycle, vx, vy, norm: Math.hypot(vx, vy) };
    });

    return {
      theta: Float64Array.from(theta),
      px: Float64Array.from(px),
      py: Float64Array.from(py),
      gaps
    };
  };

  return { x, wallVar, iterations, evaluate, ...evaluate(x) };
}
