import { resolveOptions } from "./constants.js";
import { angleOf, dist, fmt, isFinitePoint, median, pointToSegment, wrapAngle, DEG } from "./geometry.js";
import { buildGraph, mergeEndpoints } from "./topology.js";
import { normalizeOpenings } from "./openings.js";

const issue = (type, severity, message, extra = {}) => ({ type, severity, message, ...extra });

export function analyzePlan(input, opts) {
  const errors = [];
  const warnings = [];
  const res = { errors, warnings, walls: [], openings: [], solvableIdx: [], nodes: [], wallNodes: [], topo: null, scale: 1, tol: 1 };

  if (!input || typeof input !== "object" || !Array.isArray(input.walls)) {
    errors.push(issue("invalid_input", "error", 'Input non valido: serve un oggetto con un array "walls".'));
    return res;
  }
  if (input.walls.length === 0) errors.push(issue("no_walls", "error", "La planimetria non contiene muri."));

  const seenIds = new Set();
  const walls = input.walls.map((raw, index) => {
    const w = { index, id: null, a: null, b: null, L: NaN, s: NaN, sl: NaN, status: "ok", reason: null, duplicateOf: -1, reversed: false };
    const exclude = (reason, type, severity, message) => {
      if (w.status === "ok") {
        w.status = "excluded";
        w.reason = reason;
      }
      (severity === "error" ? errors : warnings).push(issue(type, severity, message, { walls: [w.id] }));
    };
    if (!raw || typeof raw !== "object") {
      w.id = `#${index}`;
      exclude("invalid_wall", "invalid_wall", "error", `Muro #${index} non valido.`);
      return w;
    }
    if (raw.id === undefined || raw.id === null || raw.id === "") {
      w.id = `wall_${index}`;
      warnings.push(issue("missing_wall_id", "info", `Il muro #${index} non ha un id: assegnato "${w.id}".`, { walls: [w.id] }));
    } else w.id = String(raw.id);
    if (seenIds.has(w.id)) {
      exclude("duplicate_id", "duplicate_wall_id", "error", `ID muro duplicato: "${w.id}". La seconda occorrenza è esclusa.`);
      return w;
    }
    seenIds.add(w.id);

    if (!isFinitePoint(raw.a) || !isFinitePoint(raw.b)) {
      exclude("invalid_coordinates", "invalid_coordinates", "error", `Il muro ${w.id} ha coordinate dello schizzo mancanti o non valide.`);
      return w;
    }
    w.a = { x: raw.a.x, y: raw.a.y };
    w.b = { x: raw.b.x, y: raw.b.y };
    w.sl = dist(w.a, w.b);
    w.s = angleOf(w.a, w.b);

    const hasLen = raw.lengthCm !== undefined && raw.lengthCm !== null && raw.lengthCm !== "";
    const L = hasLen ? Number(raw.lengthCm) : NaN;
    if (!hasLen || !Number.isFinite(L)) {
      exclude("missing_length", "missing_length", "error", `Il muro ${w.id} non ha una misura reale (lengthCm). Non viene stimata dallo schizzo.`);
      return w;
    }
    w.L = L;
    if (L <= 0) {
      exclude("zero_length", "zero_length_wall", "error", `Il muro ${w.id} ha lunghezza ${fmt(L)} cm: non valida.`);
      return w;
    }
    if (w.sl < 1e-9) {
      exclude("degenerate_sketch", "degenerate_sketch", "error", `Il muro ${w.id} è disegnato come un punto: impossibile ricavarne la direzione.`);
      return w;
    }
    return w;
  });
  res.walls = walls;

  const okIdx = walls.filter((w) => w.status === "ok").map((w) => w.index);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of okIdx) {
    for (const p of [walls[i].a, walls[i].b]) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  const diag = okIdx.length ? Math.hypot(maxX - minX, maxY - minY) : 0;
  const tol = Number.isFinite(opts.nodeMergeTolerance) && opts.nodeMergeTolerance >= 0 ? opts.nodeMergeTolerance : Math.max(diag * opts.nodeMergeToleranceRatio, 1e-6);
  res.tol = tol;

  const roughRatios = okIdx
    .map((i) => walls[i].sl > 1e-9 ? walls[i].L / walls[i].sl : NaN)
    .filter(Number.isFinite);
  const roughScale = roughRatios.length ? median(roughRatios) : 1;
  const repairByCm = Number.isFinite(opts.topologyRepairMaxGapCm) && roughScale > 1e-9
    ? opts.topologyRepairMaxGapCm / roughScale
    : tol;
  const repairByRatio = Number.isFinite(opts.topologyRepairMaxGapRatio)
    ? Math.max(tol, diag * opts.topologyRepairMaxGapRatio)
    : repairByCm;
  const repairTolerance = opts.topologyRepair === false
    ? tol
    : Math.max(tol, Math.min(repairByCm, repairByRatio));

  const { nodes, wallNodes, repairs } = mergeEndpoints(walls, okIdx, tol, {
    repair: opts.topologyRepair !== false,
    repairTolerance,
    ambiguityRatio: opts.topologyRepairAmbiguityRatio,
    attachRatio: opts.topologyRepairAttachRatio
  });
  res.nodes = nodes;
  res.wallNodes = wallNodes;
  res.topologyRepairs = repairs || [];
  res.scale = roughScale;

  if (res.topologyRepairs.length) {
    warnings.push(issue(
      "topology_repaired",
      "info",
      `Ricuciti ${res.topologyRepairs.length} collegamenti tra muri vicini per ristabilire la continuità della pianta. Le misure reali non sono state modificate.`,
      {
        repairs: res.topologyRepairs.map((r) => ({
          walls: [r.wallA, r.wallB].filter(Boolean),
          sketchGapUnits: r.distance
        }))
      }
    ));
  }

  const pairKey = new Map();
  for (const i of okIdx) {
    const [na, nb] = wallNodes[i];
    const key = na < nb ? `${na}-${nb}` : `${nb}-${na}`;
    if (!pairKey.has(key)) {
      pairKey.set(key, i);
      continue;
    }
    const k = pairKey.get(key);
    const w = walls[i];
    const first = walls[k];
    w.status = "excluded";
    w.reason = "duplicate_wall";
    w.duplicateOf = k;
    w.reversed = wallNodes[k][0] !== na;
    const diff = Math.abs(first.L - w.L);
    if (diff <= opts.duplicateLengthToleranceCm) {
      warnings.push(issue("duplicate_wall", "warning", `Il muro ${w.id} duplica ${first.id}: escluso dal calcolo (misure ${fmt(first.L)} / ${fmt(w.L)} cm).`, { walls: [first.id, w.id] }));
    } else {
      errors.push(issue("duplicate_wall_conflict", "error", `I muri ${first.id} (${fmt(first.L)} cm) e ${w.id} (${fmt(w.L)} cm) collegano gli stessi punti ma hanno misure diverse. Usata solo ${first.id}.`, { walls: [first.id, w.id] }));
    }
  }

  const solvableIdx = okIdx.filter((i) => walls[i].status === "ok");
  res.solvableIdx = solvableIdx;
  const topo = buildGraph(walls.length, solvableIdx, wallNodes, nodes.length);
  res.topo = topo;
  const ids = (list) => list.map((i) => walls[i].id);

  for (let p = 0; p < solvableIdx.length; p++) {
    const i = solvableIdx[p];
    const wi = walls[i];
    const ux = Math.cos(wi.s);
    const uy = Math.sin(wi.s);
    for (let q = p + 1; q < solvableIdx.length; q++) {
      const j = solvableIdx[q];
      const wj = walls[j];
      const d = Math.abs(wrapAngle(wj.s - wi.s));
      if (Math.min(d, Math.PI - d) > 3 * DEG) continue;
      const mid = { x: (wj.a.x + wj.b.x) / 2, y: (wj.a.y + wj.b.y) / 2 };
      const perp = Math.abs(-(mid.x - wi.a.x) * uy + (mid.y - wi.a.y) * ux);
      if (perp > tol) continue;
      const t1 = (wj.a.x - wi.a.x) * ux + (wj.a.y - wi.a.y) * uy;
      const t2 = (wj.b.x - wi.a.x) * ux + (wj.b.y - wi.a.y) * uy;
      const overlap = Math.min(wi.sl, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
      if (overlap > tol) warnings.push(issue("overlapping_walls", "warning", `I muri ${wi.id} e ${wj.id} sono disegnati quasi sovrapposti: verificare che non siano la stessa parete.`, { walls: [wi.id, wj.id] }));
    }
  }

  const deg = topo.adj.map((l) => l.length);
  const dangling = [];
  for (let n = 0; n < nodes.length; n++) if (deg[n] === 1) dangling.push(n);
  for (let p = 0; p < dangling.length; p++) {
    for (let q = p + 1; q < dangling.length; q++) {
      const d = dist(nodes[dangling[p]], nodes[dangling[q]]);
      if (d <= tol * 4) {
        const wa = topo.adj[dangling[p]][0].w;
        const wb = topo.adj[dangling[q]][0].w;
        warnings.push(issue("near_miss_endpoints", "warning", `Loop quasi chiuso: le estremità di ${walls[wa].id} e ${walls[wb].id} sono vicine nello schizzo ma non collegate.`, { walls: [walls[wa].id, walls[wb].id] }));
      }
    }
  }
  for (const n of dangling) {
    const own = topo.adj[n][0].w;
    for (const j of solvableIdx) {
      if (j === own) continue;
      const [ja, jb] = wallNodes[j];
      if (ja === n || jb === n) continue;
      const { distance, t } = pointToSegment(nodes[n], walls[j].a, walls[j].b);
      if (distance <= tol && t > 0.02 && t < 0.98) warnings.push(issue("t_junction", "warning", `Il muro ${walls[own].id} termina a metà del muro ${walls[j].id}. Gli innesti a T non sono vincolati: dividere ${walls[j].id} in due muri con le rispettive misure.`, { walls: [walls[own].id, walls[j].id] }));
    }
  }

  if (topo.components.length > 1) {
    warnings.push(issue("disconnected_walls", "warning", `Ci sono ${topo.components.length} gruppi di muri non collegati tra loro: la loro posizione reciproca è solo stimata dallo schizzo.`, { groups: topo.components.map((c) => ids(c.walls)) }));
  }
  for (const c of topo.components) {
    if (c.cycleCount === 0 && c.walls.length >= 2) {
      warnings.push(issue("open_perimeter", "info", `I muri ${ids(c.walls).join(", ")} formano una catena aperta: nessuna stanza chiusa.`, { walls: ids(c.walls) }));
    } else if (c.cycleCount > 0) {
      for (const n of c.nodes) if (deg[n] === 1) warnings.push(issue("dangling_wall", "info", `Il muro ${walls[topo.adj[n][0].w].id} ha un'estremità libera.`, { walls: [walls[topo.adj[n][0].w].id] }));
    }
  }
  for (const cy of topo.cycles) {
    let sum = 0, max = 0, arg = -1;
    for (const w of cy.walls) {
      sum += walls[w].L;
      if (walls[w].L > max) { max = walls[w].L; arg = w; }
    }
    if (max > sum - max + 1e-9) {
      cy.impossible = true;
      errors.push(issue("impossible_closure", "error", `Misure incompatibili: il muro ${walls[arg].id} (${fmt(max)} cm) è più lungo della somma degli altri muri del loop (${fmt(sum - max)} cm). Nessuna forma chiusa è possibile.`, { walls: ids(cy.walls) }));
    }
  }

  const ratios = solvableIdx.map((i) => walls[i].L / walls[i].sl);
  const scale = ratios.length ? median(ratios) : roughScale;
  res.scale = scale;
  const k = opts.proportionWarningRatio;
  if (solvableIdx.length >= 3 && k > 1) {
    for (const i of solvableIdx) {
      const r = walls[i].L / walls[i].sl / scale;
      if (r > k || r < 1 / k) warnings.push(issue("sketch_proportion", "warning", `La misura del muro ${walls[i].id} (${fmt(walls[i].L)} cm) è molto diversa dalle proporzioni dello schizzo: verificare che sia corretta.`, { walls: [walls[i].id] }));
    }
  }

  res.openings = normalizeOpenings(input.openings, walls, opts, errors, warnings);
  return res;
}

export function validateFloorPlan(plan, options = {}) {
  const { opts, warnings: ow } = resolveOptions(options);
  const an = analyzePlan(plan, opts);
  const topo = an.topo;
  return {
    valid: an.errors.length === 0,
    errors: an.errors,
    warnings: [...ow, ...an.warnings],
    summary: {
      wallCount: an.walls.length,
      usableWallCount: an.solvableIdx.length,
      nodeCount: an.nodes.length,
      componentCount: topo ? topo.components.length : 0,
      loopCount: topo ? topo.cycles.length : 0,
      openingCount: an.openings.length,
      nodeMergeTolerance: an.tol,
      estimatedScaleCmPerUnit: an.scale,
      repairedJoints: (an.topologyRepairs || []).length,
    },
  };
}
