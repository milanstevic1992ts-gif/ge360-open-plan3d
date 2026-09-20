/**
 * Room / surface helpers for GE360 Rilievo.
 * Modalità pratica da cantiere: i locali possono essere quasi chiusi.
 * Le misure reali restano intatte; i piccoli gap servono solo a stimare area e presentazione.
 * No DOM dependency.
 */

const DEFAULTS = Object.freeze({
  mergeCm: 5,
  estimatedGapCm: 35,
  verifyGapCm: 80
});

export function buildFaces(walls, options = {}) {
  const valid = (walls || []).filter(w =>
    w && w.id != null && w.a && w.b &&
    Number.isFinite(w.a.x) && Number.isFinite(w.a.y) &&
    Number.isFinite(w.b.x) && Number.isFinite(w.b.y)
  );
  if (!valid.length) return [];

  const opts = normalizeOptions(options);
  const scaleCmPerUnit = estimateScale(valid);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  valid.forEach(w => {
    minX = Math.min(minX, w.a.x, w.b.x);
    minY = Math.min(minY, w.a.y, w.b.y);
    maxX = Math.max(maxX, w.a.x, w.b.x);
    maxY = Math.max(maxY, w.a.y, w.b.y);
  });
  const diag = Math.max(1, Math.hypot(maxX - minX, maxY - minY));

  const mergeUnits = Number.isFinite(opts.toleranceUnits)
    ? opts.toleranceUnits
    : Math.max(0.5, opts.mergeCm / scaleCmPerUnit);

  const endpoints = [];
  valid.forEach((w, wi) => {
    endpoints.push({ wi, end: 0, p: w.a });
    endpoints.push({ wi, end: 1, p: w.b });
  });

  const nodes = [];
  const endpointNode = new Map();

  endpoints.forEach(ep => {
    let best = -1;
    let bestD = mergeUnits;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.wallEnds.has(ep.wi)) continue;
      const d = distance(ep.p, n);
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    }

    if (best < 0) {
      best = nodes.length;
      nodes.push({ x: ep.p.x, y: ep.p.y, count: 1, wallEnds: new Set([ep.wi]) });
    } else {
      const n = nodes[best];
      n.x = (n.x * n.count + ep.p.x) / (n.count + 1);
      n.y = (n.y * n.count + ep.p.y) / (n.count + 1);
      n.count++;
      n.wallEnds.add(ep.wi);
    }
    endpointNode.set(ep.wi + ':' + ep.end, best);
  });

  const edges = [];
  const nodeEdges = Array.from({ length: nodes.length }, () => []);

  valid.forEach((w, wi) => {
    const a = endpointNode.get(wi + ':0');
    const b = endpointNode.get(wi + ':1');
    if (a === b) return;
    const e = { a, b, wallId: String(w.id), virtual: false, gapCm: 0 };
    const ei = edges.length;
    edges.push(e);
    nodeEdges[a].push(ei);
    nodeEdges[b].push(ei);
  });

  const components = nodeComponents(nodes.length, edges, nodeEdges);
  const degree = nodeEdges.map(list => list.length);
  const usedVirtualNode = new Set();
  const virtualCandidates = [];

  components.forEach(comp => {
    const dangling = comp.nodes.filter(n => degree[n] === 1);
    for (let i = 0; i < dangling.length; i++) {
      for (let j = i + 1; j < dangling.length; j++) {
        const a = dangling[i], b = dangling[j];
        if (hasDirectEdge(a, b, edges, nodeEdges)) continue;
        const gapCm = distance(nodes[a], nodes[b]) * scaleCmPerUnit;
        if (gapCm > opts.verifyGapCm) continue;

        // Se ci sono molti capi liberi siamo prudenti: chiudiamo automaticamente
        // solo coppie ragionevolmente vicine. Se sono gli unici due capi del gruppo,
        // accettiamo anche una stima "da verificare".
        if (dangling.length > 2 && gapCm > opts.estimatedGapCm) continue;
        virtualCandidates.push({ a, b, gapCm, component: comp.index });
      }
    }
  });

  virtualCandidates.sort((p, q) => p.gapCm - q.gapCm || p.a - q.a || p.b - q.b);

  virtualCandidates.forEach(c => {
    if (usedVirtualNode.has(c.a) || usedVirtualNode.has(c.b)) return;
    const ei = edges.length;
    edges.push({ a: c.a, b: c.b, wallId: null, virtual: true, gapCm: c.gapCm });
    nodeEdges[c.a].push(ei);
    nodeEdges[c.b].push(ei);
    usedVirtualNode.add(c.a);
    usedVirtualNode.add(c.b);
  });

  const half = [];
  const outgoing = Array.from({ length: nodes.length }, () => []);

  edges.forEach((e, ei) => {
    const h0 = half.length;
    const h1 = h0 + 1;
    half.push({ from: e.a, to: e.b, edge: ei, twin: h1, used: false });
    half.push({ from: e.b, to: e.a, edge: ei, twin: h0, used: false });
    outgoing[e.a].push(h0);
    outgoing[e.b].push(h1);
  });

  half.forEach(h => {
    const a = nodes[h.from], b = nodes[h.to];
    h.angle = Math.atan2(b.y - a.y, b.x - a.x);
  });
  outgoing.forEach(list => list.sort((ia, ib) => half[ia].angle - half[ib].angle));

  const faces = [];
  for (let start = 0; start < half.length; start++) {
    if (half[start].used) continue;

    let cur = start;
    const polygon = [];
    const wallIds = [];
    const virtualGaps = [];
    const seen = new Set();
    let closed = false;

    for (let guard = 0; guard < half.length + 10; guard++) {
      if (seen.has(cur)) {
        closed = cur === start;
        break;
      }
      seen.add(cur);
      half[cur].used = true;

      const h = half[cur];
      const e = edges[h.edge];
      polygon.push({ x: nodes[h.from].x, y: nodes[h.from].y });
      if (e.virtual) virtualGaps.push(e.gapCm);
      else if (e.wallId != null) wallIds.push(e.wallId);

      const list = outgoing[h.to];
      const twinIndex = list.indexOf(h.twin);
      if (twinIndex < 0 || !list.length) break;

      // percorriamo la faccia tenendo il bordo "a destra";
      cur = list[(twinIndex - 1 + list.length) % list.length];
      if (cur === start) {
        closed = true;
        break;
      }
    }

    if (!closed || polygon.length < 3) continue;
    const area = signedArea(polygon);
    if (area <= Math.max(1e-6, diag * diag * 1e-8)) continue;

    const maxGapCm = virtualGaps.length ? Math.max(...virtualGaps) : 0;
    const quality = maxGapCm === 0
      ? 'ok'
      : maxGapCm <= opts.estimatedGapCm
        ? 'estimated'
        : 'verify';

    faces.push({
      id: 'face-' + faces.length,
      polygon,
      wallIds: unique(wallIds),
      area,
      centroid: polygonCentroid(polygon),
      quality,
      estimated: quality !== 'ok',
      maxGapCm,
      virtualGapCount: virtualGaps.length,
      virtualGapsCm: virtualGaps.map(v => round(v, 1)),
      scaleCmPerUnit
    });
  }

  // Preferiamo le facce interne. Ordinare per area aiuta anche findFaceAtPoint.
  return faces.sort((a, b) => a.area - b.area);
}

export function findFaceAtPoint(walls, p, options = {}) {
  const faces = buildFaces(walls, options);
  let best = null;
  for (const face of faces) {
    if (!pointInPolygon(p, face.polygon)) continue;
    if (!best || face.area < best.area) best = face;
  }
  return best;
}

export function matchRoomFace(room, faces) {
  if (!room || !Array.isArray(room.wallIds) || !room.wallIds.length) return null;
  const wanted = new Set(room.wallIds.map(String));
  let best = null;
  let bestScore = 0;

  for (const face of faces || []) {
    const got = new Set((face.wallIds || []).map(String));
    let common = 0;
    wanted.forEach(id => { if (got.has(id)) common++; });
    const union = new Set([...wanted, ...got]).size;
    const score = union ? common / union : 0;
    if (score > bestScore) {
      best = face;
      bestScore = score;
    }
  }
  return bestScore >= 0.4 ? best : null;
}

export function calculateSurfaces(solvedWalls, rooms, heightM, options = {}) {
  const faces = buildFaces(solvedWalls, options);
  const wallLength = new Map();
  (solvedWalls || []).forEach(w => {
    if (w && w.id != null && Number.isFinite(w.lengthCm)) {
      wallLength.set(String(w.id), w.lengthCm);
    }
  });

  const h = Number.isFinite(heightM) && heightM > 0 ? heightM : 2.7;
  const faceMetrics = faces.map(face => {
    const perimeterCm = face.wallIds.reduce((sum, id) => sum + (wallLength.get(String(id)) || 0), 0);
    const scale2 = face.scaleCmPerUnit * face.scaleCmPerUnit;
    const floorM2 = Math.abs(face.area) * scale2 / 10000;
    const perimeterM = perimeterCm / 100;
    const wallsM2 = perimeterM * h;

    return {
      face,
      status: face.quality,
      estimated: face.estimated,
      maxGapCm: face.maxGapCm,
      floorM2,
      ceilingM2: floorM2,
      perimeterM,
      wallsM2,
      wallsCeilingM2: wallsM2 + floorM2
    };
  });

  const roomMetrics = [];
  (rooms || []).forEach(room => {
    const face = matchRoomFace(room, faces);
    if (!face) {
      roomMetrics.push({
        room,
        face: null,
        status: 'verify',
        estimated: true,
        maxGapCm: null,
        floorM2: null,
        ceilingM2: null,
        perimeterM: null,
        wallsM2: null,
        wallsCeilingM2: null
      });
      return;
    }
    const fm = faceMetrics.find(x => x.face === face);
    roomMetrics.push({ room, ...fm });
  });

  const totals = faceMetrics.reduce((acc, x) => {
    acc.floorM2 += x.floorM2;
    acc.ceilingM2 += x.ceilingM2;
    acc.wallsM2 += x.wallsM2;
    acc.wallsCeilingM2 += x.wallsCeilingM2;
    if (x.status === 'verify') acc.status = 'verify';
    else if (x.status === 'estimated' && acc.status === 'ok') acc.status = 'estimated';
    return acc;
  }, {
    floorM2: 0,
    ceilingM2: 0,
    wallsM2: 0,
    wallsCeilingM2: 0,
    status: 'ok'
  });

  return {
    heightM: h,
    faces,
    faceMetrics,
    roomMetrics,
    totals,
    rules: {
      estimatedGapCm: normalizeOptions(options).estimatedGapCm,
      verifyGapCm: normalizeOptions(options).verifyGapCm
    }
  };
}

export function pointInPolygon(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const crosses = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || 1e-12) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function normalizeOptions(options) {
  if (Number.isFinite(options)) {
    return { ...DEFAULTS, toleranceUnits: options };
  }
  return { ...DEFAULTS, ...(options || {}) };
}

function estimateScale(walls) {
  const ratios = [];
  for (const w of walls) {
    if (!Number.isFinite(w.lengthCm) || w.lengthCm <= 0) continue;
    const d = distance(w.a, w.b);
    if (d > 1e-9) ratios.push(w.lengthCm / d);
  }
  if (!ratios.length) return 1;
  ratios.sort((a, b) => a - b);
  const m = ratios.length >> 1;
  return ratios.length % 2 ? ratios[m] : (ratios[m - 1] + ratios[m]) / 2;
}

function nodeComponents(nodeCount, edges, nodeEdges) {
  const seen = new Uint8Array(nodeCount);
  const comps = [];

  for (let start = 0; start < nodeCount; start++) {
    if (seen[start] || !nodeEdges[start].length) continue;
    const index = comps.length;
    const nodes = [];
    const stack = [start];
    seen[start] = 1;

    while (stack.length) {
      const n = stack.pop();
      nodes.push(n);
      for (const ei of nodeEdges[n]) {
        const e = edges[ei];
        const other = e.a === n ? e.b : e.a;
        if (!seen[other]) {
          seen[other] = 1;
          stack.push(other);
        }
      }
    }
    comps.push({ index, nodes });
  }
  return comps;
}

function hasDirectEdge(a, b, edges, nodeEdges) {
  return nodeEdges[a].some(ei => {
    const e = edges[ei];
    return (e.a === a && e.b === b) || (e.a === b && e.b === a);
  });
}

function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function polygonCentroid(poly) {
  let cx = 0, cy = 0, crossSum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cross = a.x * b.y - b.x * a.y;
    crossSum += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(crossSum) < 1e-9) {
    return {
      x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
      y: poly.reduce((s, p) => s + p.y, 0) / poly.length
    };
  }
  return { x: cx / (3 * crossSum), y: cy / (3 * crossSum) };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function unique(arr) {
  return [...new Set(arr)];
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
