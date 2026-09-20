/**
 * Topologia: fusione delle estremità in nodi, grafo di adiacenza,
 * componenti connesse, albero ricoprente (DFS) e cicli fondamentali.
 *
 * Tutto lavora sulle coordinate dello SCHIZZO: servono solo a capire
 * quali muri si toccano, mai a determinare le lunghezze.
 */

/**
 * Fonde le estremità vicine (≤ tol) in nodi. Single-linkage in ordine di distanza,
 * con il vincolo che le due estremità dello STESSO muro non finiscano mai nello
 * stesso nodo (i muri molto corti restano muri, non spariscono).
 *
 * @returns {{nodes: {x:number,y:number,endpoints:number}[], wallNodes: number[][]}}
 */
export function mergeEndpoints(walls, idxList, tol, options = {}) {
  const eps = [];
  for (const w of idxList) {
    eps.push({ w, end: 1, x: walls[w].a.x, y: walls[w].a.y });
    eps.push({ w, end: 2, x: walls[w].b.x, y: walls[w].b.y });
  }

  const N = eps.length;
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const maps = eps.map((e) => new Map([[e.w, e.end]]));

  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  const canMerge = (ri, rj) => {
    if (ri === rj) return false;
    const a = maps[ri];
    const b = maps[rj];
    for (const [w, m] of a) {
      const other = b.get(w);
      if (other !== undefined && other !== m) return false;
    }
    return true;
  };

  const unite = (ri, rj) => {
    ri = find(ri);
    rj = find(rj);
    if (!canMerge(ri, rj)) return false;

    let small = maps[ri];
    let big = maps[rj];
    if (small.size > big.size) {
      [small, big] = [big, small];
      [ri, rj] = [rj, ri];
    }
    for (const [w, m] of small) big.set(w, (big.get(w) ?? 0) | m);
    parent[ri] = rj;
    return true;
  };

  const basePairs = [];
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (eps[i].w === eps[j].w) continue;
      const d = Math.hypot(eps[i].x - eps[j].x, eps[i].y - eps[j].y);
      if (d <= tol) basePairs.push([d, i, j]);
    }
  }
  basePairs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  for (const [, i, j] of basePairs) unite(i, j);

  const repairs = [];
  const repairTol = Number.isFinite(options.repairTolerance)
    ? Math.max(tol, options.repairTolerance)
    : tol;
  const ambiguityRatio = Number.isFinite(options.ambiguityRatio)
    ? Math.max(1, options.ambiguityRatio)
    : 1.25;
  const attachRatio = Number.isFinite(options.attachRatio)
    ? Math.max(0.25, Math.min(1, options.attachRatio))
    : 0.75;

  function clusters() {
    const out = new Map();
    for (let k = 0; k < N; k++) {
      const r = find(k);
      if (!out.has(r)) out.set(r, { root: r, x: 0, y: 0, count: 0, endpointIndexes: [] });
      const c = out.get(r);
      c.x += eps[k].x;
      c.y += eps[k].y;
      c.count++;
      c.endpointIndexes.push(k);
    }
    for (const c of out.values()) {
      c.x /= c.count;
      c.y /= c.count;
      c.degree = maps[c.root].size;
    }
    return out;
  }

  function rootDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // Seconda fase: ricuce soltanto capi liberi. Il primo giro richiede una
  // scelta reciproca e non ambigua; i giri successivi possono agganciare un
  // terzo ramo ad un nodo già formato, ma con una soglia più prudente.
  if (repairTol > tol + 1e-9 && options.repair !== false) {
    for (let pass = 0; pass < 4; pass++) {
      const cs = clusters();
      const dangling = [...cs.values()].filter((c) => c.degree === 1);
      if (!dangling.length) break;

      const nearest = new Map();
      for (const a of dangling) {
        const list = [];
        for (const b of cs.values()) {
          if (a.root === b.root) continue;
          if (!canMerge(find(a.root), find(b.root))) continue;
          const limit = b.degree === 1 ? repairTol : repairTol * attachRatio;
          const d = rootDistance(a, b);
          if (d <= limit) list.push({ root: b.root, d, degree: b.degree });
        }
        list.sort((x, y) => x.d - y.d || x.root - y.root);
        if (!list.length) continue;
        const first = list[0];
        const second = list[1];
        const unambiguous = !second || second.d >= first.d * ambiguityRatio;
        if (unambiguous) nearest.set(a.root, first);
      }

      const candidates = [];
      for (const a of dangling) {
        const pick = nearest.get(a.root);
        if (!pick) continue;
        const target = cs.get(find(pick.root));
        if (!target) continue;

        if (target.degree === 1) {
          const back = nearest.get(target.root);
          if (!back || find(back.root) !== find(a.root)) continue;
        }
        candidates.push({ a: a.root, b: target.root, d: pick.d });
      }

      candidates.sort((x, y) => x.d - y.d || x.a - y.a || x.b - y.b);
      let changed = false;
      const usedSource = new Set();

      for (const candidate of candidates) {
        let ra = find(candidate.a);
        let rb = find(candidate.b);
        if (ra === rb || usedSource.has(ra) || !canMerge(ra, rb)) continue;

        const ca = cs.get(candidate.a);
        const cb = cs.get(candidate.b);
        const ea = ca && ca.endpointIndexes.length ? eps[ca.endpointIndexes[0]] : null;
        const eb = cb && cb.endpointIndexes.length ? eps[cb.endpointIndexes[0]] : null;

        if (!unite(ra, rb)) continue;
        changed = true;
        usedSource.add(find(ra));
        repairs.push({
          distance: candidate.d,
          wallA: ea ? walls[ea.w].id : null,
          endA: ea ? (ea.end === 1 ? "a" : "b") : null,
          wallB: eb ? walls[eb.w].id : null,
          endB: eb ? (eb.end === 1 ? "a" : "b") : null
        });
      }

      if (!changed) break;
    }
  }

  const nodeOfRoot = new Map();
  const nodes = [];
  const wallNodes = [];
  for (let k = 0; k < N; k++) {
    const r = find(k);
    if (!nodeOfRoot.has(r)) {
      nodeOfRoot.set(r, nodes.length);
      nodes.push({ x: 0, y: 0, endpoints: 0 });
    }
    const nd = nodes[nodeOfRoot.get(r)];
    nd.x += eps[k].x;
    nd.y += eps[k].y;
    nd.endpoints++;
    const e = eps[k];
    if (!wallNodes[e.w]) wallNodes[e.w] = [-1, -1];
    wallNodes[e.w][e.end === 1 ? 0 : 1] = nodeOfRoot.get(r);
  }
  for (const nd of nodes) {
    nd.x /= nd.endpoints;
    nd.y /= nd.endpoints;
  }
  return { nodes, wallNodes, repairs };
}

/**
 * Costruisce grafo, componenti, albero DFS e cicli fondamentali.
 * L'ordine di visita segue l'ordine d'inserimento dei muri: risultato deterministico.
 */
export function buildGraph(wallCount, idxList, wallNodes, nodeCount) {
  const sorted = [...idxList].sort((a, b) => a - b);
  const adj = Array.from({ length: nodeCount }, () => []);
  for (const w of sorted) {
    const [na, nb] = wallNodes[w];
    adj[na].push({ w, other: nb });
    adj[nb].push({ w, other: na });
  }

  const nodeComp = new Int32Array(nodeCount).fill(-1);
  const wallComp = new Int32Array(wallCount).fill(-1);
  const depth = new Int32Array(nodeCount);
  const parentNode = new Int32Array(nodeCount).fill(-1);
  const parentWall = new Int32Array(nodeCount).fill(-1);
  const ptr = new Int32Array(nodeCount);
  const used = new Uint8Array(wallCount);
  const components = [];
  const treeEdges = [];
  const nonTree = [];

  for (const w0 of sorted) {
    if (wallComp[w0] !== -1) continue;
    const ci = components.length;
    const root = wallNodes[w0][0];
    const comp = { index: ci, root, walls: [], nodes: [root] };
    components.push(comp);
    nodeComp[root] = ci;
    const stack = [root];
    while (stack.length) {
      const v = stack[stack.length - 1];
      const list = adj[v];
      let pushed = false;
      while (ptr[v] < list.length) {
        const { w, other } = list[ptr[v]++];
        if (used[w]) continue;
        used[w] = 1;
        wallComp[w] = ci;
        comp.walls.push(w);
        if (nodeComp[other] === -1) {
          nodeComp[other] = ci;
          comp.nodes.push(other);
          depth[other] = depth[v] + 1;
          parentNode[other] = v;
          parentWall[other] = w;
          treeEdges.push({ wall: w, parent: v, child: other, sign: wallNodes[w][0] === v ? 1 : -1, comp: ci });
          stack.push(other);
          pushed = true;
          break;
        } else {
          nonTree.push({ wall: w, comp: ci, cycle: -1 });
        }
      }
      if (!pushed) stack.pop();
    }
    comp.walls.sort((a, b) => a - b);
  }

  const cycles = [];
  const wallCycles = new Map();
  for (const nt of nonTree) {
    let [u, v] = wallNodes[nt.wall];
    const ws = [nt.wall];
    while (depth[u] > depth[v]) {
      ws.push(parentWall[u]);
      u = parentNode[u];
    }
    while (depth[v] > depth[u]) {
      ws.push(parentWall[v]);
      v = parentNode[v];
    }
    while (u !== v) {
      ws.push(parentWall[u]);
      u = parentNode[u];
      ws.push(parentWall[v]);
      v = parentNode[v];
    }
    ws.sort((a, b) => a - b);
    const idx = cycles.length;
    cycles.push({ index: idx, closingWall: nt.wall, walls: ws, comp: nt.comp });
    nt.cycle = idx;
    for (const w of ws) {
      if (!wallCycles.has(w)) wallCycles.set(w, new Set());
      wallCycles.get(w).add(idx);
    }
  }
  for (const c of components) c.cycleCount = cycles.filter((cy) => cy.comp === c.index).length;

  return { adj, nodeComp, wallComp, components, treeEdges, nonTree, cycles, wallCycles, depth };
}
