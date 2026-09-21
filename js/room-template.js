export const ROOM_TEMPLATE_UNITS_PER_M = 80;

export function rectRoomGeometry(center, widthM, heightM, unitsPerM = ROOM_TEMPLATE_UNITS_PER_M) {
  const cx = finite(center && center.x, 0);
  const cy = finite(center && center.y, 0);
  const w = positive(widthM, 'widthM') * unitsPerM;
  const h = positive(heightM, 'heightM') * unitsPerM;
  const hw = w / 2;
  const hh = h / 2;
  const corners = [
    { x: cx - hw, y: cy - hh },
    { x: cx + hw, y: cy - hh },
    { x: cx + hw, y: cy + hh },
    { x: cx - hw, y: cy + hh }
  ];
  const lengths = [
    Math.round(widthM * 100),
    Math.round(heightM * 100),
    Math.round(widthM * 100),
    Math.round(heightM * 100)
  ];
  const segments = corners.map((a, i) => ({
    a: { x: a.x, y: a.y },
    b: { x: corners[(i + 1) % 4].x, y: corners[(i + 1) % 4].y },
    lengthCm: lengths[i]
  }));
  return {
    center: { x: cx, y: cy },
    widthM,
    heightM,
    corners,
    closed: corners.concat([{ x: corners[0].x, y: corners[0].y }]),
    segments
  };
}

export function snapRectRoomCenter(center, widthM, heightM, walls, thresholdUnits = 30) {
  const geom = rectRoomGeometry(center, widthM, heightM);
  let best = null;
  const targets = [];
  (walls || []).forEach(w => {
    if (w && w.a && Number.isFinite(w.a.x) && Number.isFinite(w.a.y)) targets.push(w.a);
    if (w && w.b && Number.isFinite(w.b.x) && Number.isFinite(w.b.y)) targets.push(w.b);
  });

  geom.corners.forEach(corner => {
    targets.forEach(target => {
      const d = Math.hypot(target.x - corner.x, target.y - corner.y);
      if (d <= thresholdUnits && (!best || d < best.distance)) {
        best = { corner, target, distance: d };
      }
    });
  });

  if (!best) {
    return { center: { x: center.x, y: center.y }, snapped: false, target: null, distance: null };
  }
  return {
    center: {
      x: center.x + best.target.x - best.corner.x,
      y: center.y + best.target.y - best.corner.y
    },
    snapped: true,
    target: { x: best.target.x, y: best.target.y },
    distance: best.distance
  };
}

function positive(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(name + ' must be positive');
  return n;
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
