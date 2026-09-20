import { fmt, round, toDeg, wrapAngle } from "./geometry.js";

const TYPE_LABEL = { door: "La porta", window: "La finestra" };
const label = (o) => `${TYPE_LABEL[o.type] ?? "L'apertura"} ${o.id}`;

export function openingIntervalFromA(L, widthCm, offsetCm, referenceEnd) {
  const start = referenceEnd === "b" ? L - offsetCm - widthCm : offsetCm;
  return { start, end: start + widthCm, center: start + widthCm / 2 };
}

export function normalizeOpenings(rawOpenings, walls, opts, errors, warnings) {
  if (rawOpenings === undefined || rawOpenings === null) return [];
  if (!Array.isArray(rawOpenings)) {
    errors.push({ type: "invalid_openings", severity: "error", message: "\"openings\" deve essere un array." });
    return [];
  }
  const tol = opts.openingToleranceCm;
  const wallById = new Map();
  for (const w of walls) if (w.id !== null && !wallById.has(w.id)) wallById.set(w.id, w);
  const seen = new Set();
  const out = rawOpenings.map((raw, index) => {
    const o = {
      index,
      id: raw && raw.id != null ? String(raw.id) : `opening_${index}`,
      type: raw && raw.type ? String(raw.type) : "opening",
      wallId: raw && raw.wallId != null ? String(raw.wallId) : null,
      widthCm: raw ? Number(raw.widthCm) : NaN,
      offsetCm: raw ? Number(raw.offsetCm) : NaN,
      referenceEnd: raw ? raw.referenceEnd : undefined,
      raw,
      valid: true,
      wallIndex: -1,
    };
    const fail = (type, message, extra = {}) => {
      o.valid = false;
      errors.push({ type, severity: "error", message, openings: [o.id], ...extra });
    };
    if (!raw || typeof raw !== "object") {
      fail("invalid_opening", `Apertura #${index} non valida.`);
      return o;
    }
    if (seen.has(o.id)) warnings.push({ type: "duplicate_opening_id", severity: "warning", message: `ID apertura duplicato: ${o.id}.`, openings: [o.id] });
    seen.add(o.id);

    if (o.referenceEnd === undefined || o.referenceEnd === null) {
      o.referenceEnd = "a";
      warnings.push({ type: "opening_reference_defaulted", severity: "info", message: `${label(o)} non indica "referenceEnd": uso l'estremità "a".`, openings: [o.id] });
    } else if (o.referenceEnd !== "a" && o.referenceEnd !== "b") {
      fail("opening_invalid_reference", `${label(o)}: referenceEnd deve essere "a" oppure "b".`);
    }
    const wall = o.wallId !== null ? wallById.get(o.wallId) : undefined;
    if (!wall) {
      fail("opening_wall_not_found", `${label(o)} è collegata a un muro inesistente (${o.wallId}).`);
      return o;
    }
    o.wallIndex = wall.index;
    if (wall.status !== "ok" && wall.reason !== "duplicate_wall") {
      fail("opening_wall_unavailable", `${label(o)} è su un muro non utilizzabile (${wall.id}).`, { walls: [wall.id] });
    }
    if (!Number.isFinite(o.widthCm) || o.widthCm <= 0) fail("opening_invalid_width", `${label(o)}: larghezza mancante o non valida.`);
    if (!Number.isFinite(o.offsetCm) || o.offsetCm < 0) fail("opening_invalid_offset", `${label(o)}: offset mancante o negativo.`);
    if (!o.valid || !Number.isFinite(wall.L)) return o;

    const L = wall.L;
    if (o.widthCm > L + tol) {
      fail("opening_wider_than_wall", `${label(o)} (${fmt(o.widthCm)} cm) è più larga del muro ${wall.id} (${fmt(L)} cm).`, { walls: [wall.id] });
    } else if (o.offsetCm + o.widthCm > L + tol) {
      fail(
        "opening_out_of_bounds",
        `${label(o)} (${fmt(o.widthCm)} cm) con offset ${fmt(o.offsetCm)} cm termina a ${fmt(o.offsetCm + o.widthCm)} cm, oltre la lunghezza del muro ${wall.id} (${fmt(L)} cm).`,
        { walls: [wall.id] }
      );
    }
    return o;
  });

  const byWall = new Map();
  for (const o of out) {
    if (!o.valid) continue;
    const L = walls[o.wallIndex].L;
    const iv = openingIntervalFromA(L, o.widthCm, o.offsetCm, o.referenceEnd);
    if (!byWall.has(o.wallIndex)) byWall.set(o.wallIndex, []);
    byWall.get(o.wallIndex).push({ o, ...iv });
  }
  for (const [wi, list] of byWall) {
    list.sort((p, q) => p.start - q.start);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (cur.start < prev.end - tol) {
        warnings.push({
          type: "overlapping_openings",
          severity: "warning",
          message: `Le aperture ${prev.o.id} e ${cur.o.id} si sovrappongono sul muro ${walls[wi].id} di ${fmt(prev.end - cur.start)} cm.`,
          openings: [prev.o.id, cur.o.id],
          walls: [walls[wi].id],
        });
      }
    }
  }
  return out;
}

export function placeOpenings(openings, walls, wallGeom, precision) {
  return openings.map((o) => {
    const base = {
      id: o.id,
      type: o.type,
      wallId: o.wallId,
      widthCm: o.widthCm,
      referenceEnd: o.referenceEnd,
      offsetCm: o.offsetCm,
      valid: o.valid,
    };
    const g = o.valid ? wallGeom.get(o.wallIndex) : undefined;
    if (!g) return base;
    const iv = openingIntervalFromA(g.L, o.widthCm, o.offsetCm, o.referenceEnd);
    const c = Math.cos(g.theta);
    const s = Math.sin(g.theta);
    const at = (d) => ({ x: round(g.A.x + c * d, precision), y: round(g.A.y + s * d, precision) });
    return {
      ...base,
      startFromACm: round(iv.start, precision),
      endFromACm: round(iv.end, precision),
      centerFromACm: round(iv.center, precision),
      start: at(iv.start),
      end: at(iv.end),
      center: at(iv.center),
      angleDeg: round(toDeg(wrapAngle(g.theta)), 4),
    };
  });
}
