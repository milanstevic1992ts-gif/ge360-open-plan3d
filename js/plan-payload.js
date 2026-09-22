/**
 * GE360 Rilievo — costruzione del payload per il backend (contratto v4 + rilievo fedele v2).
 *
 * Regole:
 * - lo schizzo è solo una traccia: le coordinate vanno così come sono;
 * - un muro non misurato viaggia con lengthCm = null (il backend lo calcola dalle altre misure);
 * - le quote punto-punto (diagonali, posizione tramezzi) sono agganciate agli estremi dei muri
 *   e le coordinate vengono risolte al momento dell'invio, così seguono eventuali spostamenti.
 */

export const PLAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const WALL_REFERENCES = ['interior', 'partitionAxis', 'axis'];
export const DEFAULT_WALL_THICKNESS_CM = 12;

const ROOM_TYPES = [
  ['bagno', ['bagno', 'wc', 'servizio', 'lavanderia', 'doccia']],
  ['cucina', ['cucina', 'cottura']],
  ['camera', ['camera', 'letto', 'cameretta']],
  ['soggiorno', ['soggiorno', 'salotto', 'sala', 'living', 'open space', 'pranzo']],
  ['disimpegno', ['corridoio', 'disimpegno', 'ingresso', 'atrio']],
  ['ripostiglio', ['ripostiglio', 'sgabuzzino', 'cabina']],
  ['studio', ['studio', 'ufficio']],
  ['esterno', ['terrazza', 'terrazzo', 'balcone', 'loggia', 'veranda']]
];

export function roomTypeFromName(name) {
  const text = String(name || '').toLowerCase();
  for (const [type, words] of ROOM_TYPES) {
    if (words.some(w => text.includes(w))) return type;
  }
  return 'altro';
}

function positive(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nonNegative(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function safePlanId(id) {
  const raw = String(id || '');
  if (PLAN_ID_RE.test(raw)) return raw;
  const clean = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return clean || null;
}

/** Coordinate dell'estremo di un muro ({wallId, end}) o del punto salvato. */
export function resolveAnchor(anchor, walls) {
  if (!anchor) return null;
  if (anchor.wallId) {
    const wall = (walls || []).find(w => w.id === anchor.wallId);
    const p = wall && wall[anchor.end === 'b' ? 'b' : 'a'];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
  }
  if (Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) return { x: anchor.x, y: anchor.y };
  return null;
}

export function buildPlanPayload(plan, extra = {}) {
  const walls = (plan.walls || []).map(w => {
    const out = Object.assign({}, w);
    out.lengthCm = positive(w.lengthCm);
    const allowedStates = ['existing', 'demolish', 'new', 'close-opening', 'new-opening'];
    out.constructionState = allowedStates.includes(String(w.constructionState))
      ? String(w.constructionState)
      : 'existing';

    const constructionThicknessCm = positive(w.constructionThicknessCm);
    if (out.constructionState === 'demolish' || out.constructionState === 'new') {
      if (constructionThicknessCm) {
        out.constructionThicknessCm = constructionThicknessCm;
        // thicknessMm resta compatibile con il normalizzatore geometrico backend,
        // ma deriva dalla misura esplicita dell'utente e non da un valore fittizio.
        out.thicknessMm = Math.round(constructionThicknessCm * 10);
      } else {
        delete out.constructionThicknessCm;
        delete out.thicknessMm;
      }
    } else {
      delete out.constructionThicknessCm;
      delete out.thicknessMm;
      delete out.thicknessCm;
    }
    return out;
  });
  const openings = (plan.openings || []).map(o => {
    const out = Object.assign({}, o);
    ['widthCm', 'heightCm'].forEach(k => { out[k] = positive(o[k]); });
    ['offsetCm', 'sillHeightCm'].forEach(k => { out[k] = nonNegative(o[k]); });
    if (o.type === 'door') {
      delete out.sillHeightCm;
      const allowedKinds = ['internal', 'double', 'sliding', 'armored', 'armored-double'];
      const fallbackKind = o.armored ? (Number(o.leaves) === 2 ? 'armored-double' : 'armored') : 'internal';
      out.doorKind = allowedKinds.includes(String(o.doorKind)) ? String(o.doorKind) : fallbackKind;
      out.armored = out.doorKind === 'armored' || out.doorKind === 'armored-double';
      out.sliding = out.doorKind === 'sliding';
      out.leaves = out.doorKind === 'double' || out.doorKind === 'armored-double' ? 2 : 1;
      out.category = out.armored ? 'armored' : 'interior';
      if (out.sliding) {
        out.slideTo = out.slideTo === 'a' ? 'a' : 'b';
        delete out.hingeEnd;
        delete out.swingDirection;
        delete out.swingSide;
      } else {
        out.hingeEnd = out.hingeEnd === 'b' ? 'b' : 'a';
        out.swingDirection = out.swingDirection === 'outward' ? 'outward' : 'inward';
        out.swingSide = Number(out.swingSide) === -1 ? -1 : 1;
        delete out.slideTo;
      }
    } else if (o.type === 'window') {
      const allowedWindowKinds = ['single', 'double', 'triple', 'sliding', 'balcony', 'balcony-double'];
      const fallbackWindowKind = Number(o.leaves) === 3 ? 'triple' : Number(o.leaves) === 2 ? 'double' : 'single';
      out.windowKind = allowedWindowKinds.includes(String(o.windowKind)) ? String(o.windowKind) : fallbackWindowKind;
      out.sliding = out.windowKind === 'sliding';
      out.balconyDoor = out.windowKind === 'balcony' || out.windowKind === 'balcony-double';
      out.leaves = out.windowKind === 'triple' ? 3 :
        (out.windowKind === 'double' || out.windowKind === 'sliding' || out.windowKind === 'balcony-double' ? 2 : 1);
      if (out.balconyDoor) out.sillHeightCm = 0;
    }
    return out;
  });
  const rooms = (plan.rooms || []).map(r => {
    const out = Object.assign({}, r);
    out.type = r.type || roomTypeFromName(r.name);
    out.heightCm = positive(r.heightCm);
    out.tilingHeightCm = positive(r.tilingHeightCm);
    if (out.heightCm == null) delete out.heightCm;
    if (out.tilingHeightCm == null) delete out.tilingHeightCm;
    return out;
  });
  const diagonals = [];
  (plan.diagonals || []).forEach(d => {
    const a = resolveAnchor(d.a, plan.walls);
    const b = resolveAnchor(d.b, plan.walls);
    const len = positive(d.lengthCm);
    if (a && b && len) diagonals.push({ id: d.id, a, b, lengthCm: len });
  });
  const wallReference = WALL_REFERENCES.includes(plan.wallReference) ? plan.wallReference : 'interior';
  return Object.assign({
    version: 4,
    kind: 'ge360-rough-survey',
    planId: safePlanId(plan.id),
    name: String(plan.name || 'Rilievo').slice(0, 200),
    updatedAt: plan.updatedAt || new Date().toISOString(),
    rawStrokes: plan.rawStrokes || [],
    walls,
    openings,
    rooms,
    diagonals,
    notes: plan.notes || [],
    works: plan.works || [],
    wallHeightM: positive(plan.wallHeightM) || 2.70,
    wallReference,
    surfaces: plan.surfaceSummary || null
  }, extra);
}

/** Impronta del contenuto geometrico: serve a capire se un risultato del server è ancora attuale. */
export function payloadFingerprint(payload) {
  const core = JSON.stringify({
    walls: (payload.walls || []).map(w => [w.id, w.a, w.b, w.lengthCm, w.constructionState, w.constructionThicknessCm, w.thicknessMm]),
    openings: (payload.openings || []).map(o => [o.id, o.wallId, o.type, o.doorKind, o.windowKind, o.category, o.leaves, o.sliding, o.armored, o.balconyDoor, o.hingeEnd, o.swingDirection, o.swingSide, o.slideTo, o.widthCm, o.offsetCm, o.referenceEnd, o.heightCm, o.sillHeightCm, o.position]),
    rooms: (payload.rooms || []).map(r => [r.id, r.name, r.type, r.wallIds, r.heightCm, r.tilingHeightCm]),
    diagonals: payload.diagonals,
    h: payload.wallHeightM,
    ref: payload.wallReference
  });
  let h = 2166136261;
  for (let i = 0; i < core.length; i++) {
    h ^= core.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + '-' + core.length.toString(36);
}

export function measuredWallCount(payload) {
  return (payload.walls || []).filter(w => positive(w.lengthCm)).length;
}

