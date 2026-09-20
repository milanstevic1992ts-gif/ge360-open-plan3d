/**
 * Room / surface helpers for GE360 Rilievo.
 * No DOM dependency.
 */

export function buildFaces(walls, tolerance = null) {
  const valid = (walls || []).filter(w =>
    w && w.id != null && w.a && w.b &&
    Number.isFinite(w.a.x) && Number.isFinite(w.a.y) &&
    Number.isFinite(w.b.x) && Number.isFinite(w.b.y)
  );
  if (!valid.length) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  valid.forEach(w => {
    minX = Math.min(minX, w.a.x, w.b.x);
    minY = Math.min(minY, w.a.y, w.b.y);
    maxX = Math.max(maxX, w.a.x, w.b.x);
    maxY = Math.max(maxY, w.a.y, w.b.y);
  });
  const diag = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
  const tol = Number.isFinite(tolerance) ? tolerance : Math.max(0.75, diag * 0.015);

  const endpoints = [];
  valid.forEach((w, wi) => {
    endpoints.push({ wi, end: 0, p: w.a });
    endpoints.push({ wi, end: 1, p: w.b });
  });

  const nodes = [];
  const endpointNode = new Map();

  endpoints.forEach(ep => {
    let best = -1;
    let bestD = tol;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.wallEnds.has(ep.wi)) continue;
      const d = Math.hypot(ep.p.x - n.x, ep.p.y - n.y);
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

  const half = [];
  const outgoing = Array.from({ length: nodes.length }, () => []);

  valid.forEach((w, wi) => {
    const a = endpointNode.get(wi + ':0');
    const b = endpointNode.get(wi + ':1');
    if (a === b) return;
    const h0 = half.length;
    const h1 = h0 + 1;
    half.push({ from: a, to: b, wallId: String(w.id), twin: h1, used: false });
    half.push({ from: b, to: a, wallId: String(w.id), twin: h0, used: false });
    outgoing[a].push(h0);
    outgoing[b].push(h1);
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
    const seen = new Set();
    let closed = false;

    for (let guard = 0; guard < half.length + 5; guard++) {
      if (seen.has(cur)) {
        closed = cur === start;
        break;
      }
      seen.add(cur);
      half[cur].used = true;
      const h = half[cur];
      polygon.push({ x: nodes[h.from].x, y: nodes[h.from].y });
      wallIds.push(h.wallId);

      const list = outgoing[h.to];
      const twinIndex = list.indexOf(h.twin);
      if (twinIndex < 0 || !list.length) break;
      cur = list[(twinIndex - 1 + list.length) % list.length];

      if (cur === start) {
        closed = true;
        break;
      }
    }

    if (!closed || polygon.length < 3) continue;
    const area = signedArea(polygon);
    if (area <= Math.max(1e-6, diag * diag * 1e-8)) continue;

    faces.push({
      id: 'face-' + faces.length,
      polygon,
      wallIds: unique(wallIds),
      area,
      centroid: polygonCentroid(polygon, area)
    });
  }

  return faces.sort((a, b) => b.area - a.area);
}

export function findFaceAtPoint(walls, p) {
  const faces = buildFaces(walls);
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
  return bestScore >= 0.45 ? best : null;
}

export function calculateSurfaces(solvedWalls, rooms, heightM) {
  const faces = buildFaces(solvedWalls);
  const wallLength = new Map();
  (solvedWalls || []).forEach(w => {
    if (w && w.id != null && Number.isFinite(w.lengthCm)) wallLength.set(String(w.id), w.lengthCm);
  });

  const h = Number.isFinite(heightM) && heightM > 0 ? heightM : 2.7;
  const faceMetrics = faces.map(face => {
    const perimeterCm = face.wallIds.reduce((sum, id) => sum + (wallLength.get(String(id)) || 0), 0);
    const floorM2 = Math.abs(face.area) / 10000;
    const perimeterM = perimeterCm / 100;
    const wallsM2 = perimeterM * h;
    return {
      face,
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
      roomMetrics.push({ room, face: null, floorM2: null, ceilingM2: null, perimeterM: null, wallsM2: null, wallsCeilingM2: null });
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
    return acc;
  }, { floorM2: 0, ceilingM2: 0, wallsM2: 0, wallsCeilingM2: 0 });

  return { heightM: h, faces, faceMetrics, roomMetrics, totals };
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

function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function polygonCentroid(poly, signed) {
  let cx = 0, cy = 0;
  let crossSum = 0;
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

function unique(arr) {
  return [...new Set(arr)];
}
