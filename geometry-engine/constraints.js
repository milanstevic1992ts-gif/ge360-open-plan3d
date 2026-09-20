import { circularMean, wrapAngle, DEG, HALF_PI } from "./geometry.js";

const PRIORITY = { perpendicular: 1, collinear: 1, horizontal: 2, vertical: 2, parallel: 3 };

function confidence(dev, tol, base = 1) {
  return Math.max(0, Math.min(1, base * (1 - 0.5 * (dev / tol) ** 2)));
}

export function detectConstraintCandidates(ctx) {
  const { walls, active, wallNodes, topo, opts } = ctx;
  const WORLD = walls.length;
  const snapTol = opts.angleSnapTolerance * DEG;
  const colTol = opts.collinearTolerance * DEG;
  const axisTol = opts.axisSnapTolerance * DEG;
  const parTol = opts.parallelTolerance * DEG;
  const out = [];
  const adjacent = new Set();

  for (let v = 0; v < topo.adj.length; v++) {
    const list = topo.adj[v];
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        let i = list[p].w;
        let j = list[q].w;
        if (i > j) [i, j] = [j, i];
        adjacent.add(`${i}|${j}`);
        const oi = wallNodes[i][0] === v ? walls[i].s : walls[i].s + Math.PI;
        const oj = wallNodes[j][0] === v ? walls[j].s : walls[j].s + Math.PI;
        const gamma = Math.abs(wrapAngle(oj - oi));
        const rel = wrapAngle(walls[j].s - walls[i].s);
        const dev90 = Math.abs(gamma - HALF_PI);
        if (dev90 <= snapTol) {
          out.push({ type: "perpendicular", i, j, delta: rel >= 0 ? HALF_PI : -HALF_PI, deviationDeg: dev90 / DEG, confidence: confidence(dev90, snapTol), node: v });
          continue;
        }
        const dev180 = Math.PI - gamma;
        if (dev180 <= colTol) {
          out.push({ type: "collinear", i, j, delta: Math.abs(rel) < HALF_PI ? 0 : Math.PI, deviationDeg: dev180 / DEG, confidence: confidence(dev180, colTol), node: v });
        }
      }
    }
  }

  const axisCand = new Set();
  for (const i of active) {
    const k = Math.round(walls[i].s / HALF_PI);
    const delta = wrapAngle(k * HALF_PI);
    const dev = Math.abs(wrapAngle(walls[i].s - delta));
    if (dev <= axisTol) {
      axisCand.add(i);
      out.push({ type: k % 2 === 0 ? "horizontal" : "vertical", i: WORLD, j: i, delta, deviationDeg: dev / DEG, confidence: confidence(dev, axisTol, 0.95) });
    }
  }

  if (opts.nonAdjacentParallel !== "none") {
    for (let p = 0; p < active.length; p++) {
      const i = active[p];
      for (let q = p + 1; q < active.length; q++) {
        const j = active[q];
        if (adjacent.has(`${i}|${j}`)) continue;
        if (topo.wallComp[i] !== topo.wallComp[j]) continue;
        if (axisCand.has(i) && axisCand.has(j)) continue;
        const rel = wrapAngle(walls[j].s - walls[i].s);
        const delta = Math.abs(rel) < HALF_PI ? 0 : Math.PI;
        const dev = Math.abs(wrapAngle(rel - delta));
        if (dev > parTol) continue;
        if (opts.nonAdjacentParallel === "topological" && !sharesCycle(topo, i, j) && overlapRatio(walls[i], walls[j]) < 0.2) continue;
        out.push({ type: "parallel", i, j, delta, deviationDeg: dev / DEG, confidence: confidence(dev, parTol, 0.8) });
      }
    }
  }

  out.sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type] || b.confidence - a.confidence || a.i - b.i || a.j - b.j);
  out.forEach((c, k) => (c.id = k));
  return out;
}

function sharesCycle(topo, i, j) {
  const a = topo.wallCycles.get(i);
  const b = topo.wallCycles.get(j);
  if (!a || !b) return false;
  for (const c of a) if (b.has(c)) return true;
  return false;
}

function overlapRatio(wi, wj) {
  const ux = Math.cos(wi.s);
  const uy = Math.sin(wi.s);
  const t1 = (wj.a.x - wi.a.x) * ux + (wj.a.y - wi.a.y) * uy;
  const t2 = (wj.b.x - wi.a.x) * ux + (wj.b.y - wi.a.y) * uy;
  const ov = Math.min(wi.sl, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
  return ov / Math.min(wi.sl, wj.sl);
}

export function buildGrouping(ctx, candidates, released) {
  const { walls, active, opts } = ctx;
  const n = walls.length;
  const WORLD = n;
  const parent = new Int32Array(n + 1);
  const off = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) parent[k] = k;
  const members = new Map();
  members.set(WORLD, [WORLD]);
  for (const w of active) members.set(w, [w]);
  const driftTol = Math.max(opts.angleSnapTolerance, opts.axisSnapTolerance) * DEG + 1e-9;

  const find = (k) => {
    const p = parent[k];
    if (p === k) return k;
    const r = find(p);
    off[k] += off[p];
    parent[k] = r;
    return r;
  };

  const status = new Array(candidates.length);
  const minConf = new Map();
  const constrained = new Set();

  for (const c of candidates) {
    if (released.has(c.i) || released.has(c.j)) {
      status[c.id] = "released";
      continue;
    }
    const ri = find(c.i);
    const rj = find(c.j);
    const oi = off[c.i];
    const oj = off[c.j];
    if (ri === rj) {
      const err = Math.abs(wrapAngle(oj - oi - c.delta));
      status[c.id] = err < 1e-6 ? "applied" : "rejected_conflict";
    } else {
      const D = oi + c.delta - oj;
      const newRoot = rj === WORLD ? rj : ri;
      const tent = [];
      for (const m of members.get(ri)) {
        find(m);
        tent.push([m, newRoot === ri ? off[m] : off[m] - D]);
      }
      for (const m of members.get(rj)) {
        find(m);
        tent.push([m, newRoot === ri ? off[m] + D : off[m]]);
      }
      let phi = 0;
      if (newRoot !== WORLD) {
        const angs = [];
        const wts = [];
        for (const [m, o] of tent) {
          if (m === WORLD) continue;
          angs.push(walls[m].s - o);
          wts.push(walls[m].L);
        }
        phi = circularMean(angs, wts);
      }
      let maxDev = 0;
      for (const [m, o] of tent) {
        if (m === WORLD) continue;
        maxDev = Math.max(maxDev, Math.abs(wrapAngle(walls[m].s - phi - o)));
      }
      if (maxDev > driftTol) {
        status[c.id] = "rejected_drift";
      } else {
        if (newRoot === ri) {
          parent[rj] = ri;
          off[rj] = D;
        } else {
          parent[ri] = rj;
          off[ri] = -D;
        }
        const other = newRoot === ri ? rj : ri;
        const merged = members.get(newRoot).concat(members.get(other));
        members.set(newRoot, merged);
        members.delete(other);
        status[c.id] = "applied";
      }
    }
    if (status[c.id] === "applied") {
      for (const w of [c.i, c.j]) {
        if (w === WORLD) continue;
        constrained.add(w);
        minConf.set(w, Math.min(minConf.get(w) ?? 1, c.confidence));
      }
    }
  }

  const rootOf = new Int32Array(n).fill(-1);
  const offOf = new Float64Array(n);
  for (const w of active) {
    rootOf[w] = find(w);
    offOf[w] = off[w];
  }
  return { WORLD, rootOf, offOf, status, minConf, constrained };
}
