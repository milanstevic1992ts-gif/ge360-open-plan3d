/**
 * GE360 Rilievo — raddrizzamento dello schizzo.
 * Mantiene la libertà delle diagonali vere, ma raddrizza automaticamente
 * i tratti quasi orizzontali / verticali. Le misure reali non vengono toccate.
 */

const DEG = Math.PI / 180;

export function straightenPolyline(points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    return Array.isArray(points) ? points.map(copyPoint) : [];
  }

  const axisToleranceDeg = finitePositive(options.axisToleranceDeg, 25);
  const minSegment = finitePositive(options.minSegment, 1);
  const closedTolerance = finitePositive(options.closedTolerance, 1e-6);

  const input = points.map(copyPoint);
  const wasClosed = distance(input[0], input[input.length - 1]) <= closedTolerance;
  const out = [copyPoint(input[0])];
  const orientations = [];

  for (let i = 1; i < input.length; i++) {
    const rawA = input[i - 1];
    const rawB = input[i];
    const prev = out[out.length - 1];
    const dx = rawB.x - rawA.x;
    const dy = rawB.y - rawA.y;
    const len = Math.hypot(dx, dy);

    if (!Number.isFinite(len) || len < minSegment) {
      orientations.push('free');
      out.push(copyPoint(rawB));
      continue;
    }

    const orientation = snapOrientation(dx, dy, axisToleranceDeg);
    orientations.push(orientation);

    if (orientation === 'h') {
      out.push({ x: rawB.x, y: prev.y });
    } else if (orientation === 'v') {
      out.push({ x: prev.x, y: rawB.y });
    } else {
      // Una diagonale evidente resta libera: non vogliamo trasformare
      // una parete inclinata reale in una parete ortogonale.
      out.push({
        x: prev.x + dx,
        y: prev.y + dy
      });
    }
  }

  if (wasClosed && out.length >= 4) {
    const first = out[0];
    const beforeLast = out[out.length - 2];
    const closingOrientation = orientations[orientations.length - 1];

    // Chiudiamo il loop senza rendere storto l'ultimo lato.
    // Spostare il vertice precedente lungo l'asse corretto mantiene
    // ortogonali sia l'ultimo lato sia, normalmente, quello precedente.
    if (closingOrientation === 'v') beforeLast.x = first.x;
    else if (closingOrientation === 'h') beforeLast.y = first.y;

    out[out.length - 1] = copyPoint(first);
  }

  return collapseCollinear(out, wasClosed);
}

export function snapPolylineCornersToWalls(points, existingWalls, options = {}) {
  const input = Array.isArray(points) ? points.map(copyPoint) : [];
  if (input.length < 2 || !Array.isArray(existingWalls) || !existingWalls.length) {
    return { points: input, wallUpdates: [] };
  }

  const threshold = finitePositive(options.threshold, 42);
  const axisToleranceDeg = finitePositive(options.axisToleranceDeg, 25);
  const out = input.map(copyPoint);
  const updates = [];

  const targets = [
    { index: 0, neighbor: 1 },
    { index: out.length - 1, neighbor: out.length - 2 }
  ];

  for (const target of targets) {
    const p = out[target.index];
    const neighbor = out[target.neighbor];
    const newOri = snapOrientation(neighbor.x - p.x, neighbor.y - p.y, axisToleranceDeg);

    let best = null;
    for (const wall of existingWalls) {
      if (!wall || !wall.a || !wall.b) continue;
      for (const end of ['a', 'b']) {
        const ep = wall[end];
        if (!ep || !Number.isFinite(ep.x) || !Number.isFinite(ep.y)) continue;
        const d = distance(p, ep);
        if (d > threshold || (best && d >= best.distance)) continue;
        best = { wall, end, point: ep, distance: d };
      }
    }

    if (!best) continue;

    const wallDx = best.wall.b.x - best.wall.a.x;
    const wallDy = best.wall.b.y - best.wall.a.y;
    const oldOri = snapOrientation(wallDx, wallDy, axisToleranceDeg);

    let corner;
    if (newOri === 'h' && oldOri === 'v') {
      corner = { x: best.point.x, y: p.y };
    } else if (newOri === 'v' && oldOri === 'h') {
      corner = { x: p.x, y: best.point.y };
    } else {
      corner = { x: best.point.x, y: best.point.y };
    }

    out[target.index] = copyPoint(corner);
    updates.push({
      wallId: String(best.wall.id),
      end: best.end,
      point: copyPoint(corner),
      distance: best.distance,
      mode: newOri === 'h' && oldOri === 'v' || newOri === 'v' && oldOri === 'h'
        ? 'orthogonal'
        : 'endpoint'
    });
  }

  return { points: out, wallUpdates: dedupeWallUpdates(updates) };
}

function dedupeWallUpdates(updates) {
  const map = new Map();
  for (const update of updates) {
    map.set(update.wallId + ':' + update.end, update);
  }
  return Array.from(map.values());
}

export function snapOrientation(dx, dy, toleranceDeg = 25) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12)) {
    return 'free';
  }

  const angle = Math.atan2(Math.abs(dy), Math.abs(dx));
  const tol = Math.max(0, Math.min(44.9, toleranceDeg)) * DEG;

  if (angle <= tol) return 'h';
  if (Math.abs(Math.PI / 2 - angle) <= tol) return 'v';
  return 'free';
}

function collapseCollinear(points, closed) {
  if (points.length <= 2) return points.map(copyPoint);

  const out = [copyPoint(points[0])];

  for (let i = 1; i < points.length; i++) {
    const cur = copyPoint(points[i]);

    if (out.length >= 2 && i < points.length - 1) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      if (sameStraightDirection(a, b, cur)) {
        out[out.length - 1] = cur;
        continue;
      }
    }

    out.push(cur);
  }

  if (closed && out.length >= 3) {
    out[out.length - 1] = copyPoint(out[0]);
  }

  return out;
}

function sameStraightDirection(a, b, c) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  const ab = Math.hypot(abx, aby);
  const bc = Math.hypot(bcx, bcy);
  if (ab < 1e-9 || bc < 1e-9) return true;

  const cross = Math.abs(abx * bcy - aby * bcx) / (ab * bc);
  const dot = abx * bcx + aby * bcy;
  return cross < 1e-6 && dot > 0;
}

function finitePositive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function copyPoint(p) {
  return { x: Number(p.x), y: Number(p.y) };
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
