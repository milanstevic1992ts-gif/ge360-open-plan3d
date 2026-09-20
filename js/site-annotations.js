export const WORK_PRESETS = Object.freeze({
  wall: Object.freeze([
    { code:'wall_demolish', label:'MURO DA DEMOLIRE', category:'demolition' },
    { code:'wall_new', label:'NUOVO MURO', category:'construction' },
    { code:'wall_opening_new', label:'NUOVO VARCO', category:'construction' },
    { code:'wall_opening_close', label:'CHIUDERE APERTURA', category:'construction' },
    { code:'wall_tile', label:'PIASTRELLARE PARETE', category:'finish' },
    { code:'wall_plaster_paint', label:'RASARE E PITTURARE', category:'finish' },
    { code:'wall_drywall', label:'CARTONGESSO', category:'construction' }
  ]),
  floor: Object.freeze([
    { code:'floor_demolish', label:'DEMOLIRE PAVIMENTO', category:'demolition' },
    { code:'floor_demolish_rebuild', label:'DEMOLIRE E RIFARE PAVIMENTO', category:'demolition' },
    { code:'floor_tile', label:'POSA PIASTRELLE', category:'finish' },
    { code:'floor_spc', label:'POSA SPC / LVT', category:'finish' },
    { code:'floor_level', label:'AUTOLIVELLANTE', category:'construction' },
    { code:'floor_screed', label:'RIFARE MASSETTO', category:'construction' }
  ]),
  ceiling: Object.freeze([
    { code:'ceiling_false', label:'NUOVO CONTROSOFFITTO', category:'construction' },
    { code:'ceiling_cove', label:'NUOVA VELETTA', category:'construction' },
    { code:'ceiling_demolish', label:'DEMOLIRE CONTROSOFFITTO', category:'demolition' },
    { code:'ceiling_plaster', label:'RASARE SOFFITTO', category:'finish' },
    { code:'ceiling_paint', label:'PITTURARE SOFFITTO', category:'finish' }
  ]),
  room: Object.freeze([
    { code:'room_complete', label:'RISTRUTTURAZIONE COMPLETA', category:'general' },
    { code:'room_demolition', label:'DEMOLIZIONI', category:'demolition' },
    { code:'room_plaster', label:'RASATURE', category:'finish' },
    { code:'room_paint', label:'PITTURAZIONE', category:'finish' }
  ]),
  opening: Object.freeze([
    { code:'opening_remove', label:'RIMUOVERE APERTURA', category:'demolition' },
    { code:'opening_replace', label:'SOSTITUIRE', category:'construction' },
    { code:'opening_widen', label:'ALLARGARE VARCO', category:'construction' },
    { code:'opening_close', label:'CHIUDERE VARCO', category:'construction' }
  ])
});

export function presetsForTarget(type) {
  return (WORK_PRESETS[type] || WORK_PRESETS.room).map(item => ({ ...item }));
}

export function normalizeWorkItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    if (!raw) continue;
    const code = typeof raw === 'string' ? raw : raw.code;
    if (!code || seen.has(code)) continue;
    let found = null;
    for (const list of Object.values(WORK_PRESETS)) {
      found = list.find(x => x.code === code);
      if (found) break;
    }
    if (found) {
      out.push({ ...found });
      seen.add(code);
    } else if (typeof raw === 'object' && raw.label) {
      out.push({
        code: String(code),
        label: String(raw.label),
        category: String(raw.category || 'general')
      });
      seen.add(code);
    }
  }
  return out;
}

export function workItemsLabel(items, fallback = '') {
  const normalized = normalizeWorkItems(items);
  if (normalized.length) return normalized.map(x => x.label).join(' + ');
  return String(fallback || '').trim();
}

export function noteDisplayStyle(value) {
  return value === 'text' ? 'text' : 'callout';
}

export function migrateIntervention(note) {
  if (!note || typeof note !== 'object') return note;
  note.workItems = normalizeWorkItems(note.workItems || (note.workCode ? [{
    code: note.workCode,
    label: note.workLabel || note.workCode,
    category: note.workCategory || 'general'
  }] : []));
  note.displayStyle = noteDisplayStyle(note.displayStyle);
  note.kind = 'intervention';
  return note;
}

export function openingInterval(opening, wall) {
  if (!opening || !wall) return null;
  let centerT = Number.isFinite(opening.position) ? opening.position : 0.5;

  if (
    Number.isFinite(opening.offsetCm) &&
    Number.isFinite(opening.widthCm) &&
    Number.isFinite(wall.lengthCm) &&
    wall.lengthCm > 0
  ) {
    const centerCm = opening.referenceEnd === 'b'
      ? wall.lengthCm - opening.offsetCm - opening.widthCm / 2
      : opening.offsetCm + opening.widthCm / 2;
    centerT = centerCm / wall.lengthCm;
  }

  centerT = Math.max(0, Math.min(1, centerT));
  let widthRatio = 0.16;
  if (Number.isFinite(opening.widthCm) && opening.widthCm > 0 && Number.isFinite(wall.lengthCm) && wall.lengthCm > 0) {
    widthRatio = opening.widthCm / wall.lengthCm;
  }
  widthRatio = Math.max(0.02, Math.min(0.9, widthRatio));

  let startT = centerT - widthRatio / 2;
  let endT = centerT + widthRatio / 2;
  if (startT < 0) {
    endT -= startT;
    startT = 0;
  }
  if (endT > 1) {
    startT -= endT - 1;
    endT = 1;
  }
  startT = Math.max(0, startT);
  endT = Math.min(1, endT);

  return { startT, endT, centerT:(startT + endT) / 2, widthRatio:endT - startT };
}

export function mergeOpeningIntervals(openings, wall) {
  const intervals = (openings || [])
    .filter(o => o && o.wallId === wall.id)
    .map(o => ({ opening:o, interval:openingInterval(o, wall) }))
    .filter(x => x.interval)
    .sort((a,b) => a.interval.startT - b.interval.startT);

  const blocked = [];
  for (const entry of intervals) {
    const cur = { startT:entry.interval.startT, endT:entry.interval.endT };
    const last = blocked[blocked.length - 1];
    if (last && cur.startT <= last.endT) last.endT = Math.max(last.endT, cur.endT);
    else blocked.push(cur);
  }

  const visible = [];
  let cursor = 0;
  for (const gap of blocked) {
    if (gap.startT > cursor) visible.push({ startT:cursor, endT:gap.startT });
    cursor = Math.max(cursor, gap.endT);
  }
  if (cursor < 1) visible.push({ startT:cursor, endT:1 });

  return { entries:intervals, visibleSegments:visible };
}
