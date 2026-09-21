/**
 * GE360 Rilievo — risultato del calcolo professionale.
 * Compatta la risposta del backend per salvarla nel telefono, traduce le domande
 * in azioni (ri-misura un muro, aggiungi una quota) e disegna la pianta calcolata.
 */

const r = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

export function compactResult(status, processed, meta = {}) {
  const p = processed || {};
  const totals = (status && status.totals) || (p.metadata && p.metadata.totals) || null;
  return {
    receivedAt: meta.receivedAt || new Date().toISOString(),
    fingerprint: meta.fingerprint || null,
    status: status ? status.status : 'UNKNOWN',
    version: status ? status.currentVersion : null,
    quality: status ? status.quality : null,
    lastError: status ? status.lastError || null : null,
    totals,
    ai: (p.metadata && p.metadata.ai) || null,
    walls: (p.walls || []).map(w => ({
      id: w.id,
      start: { x: r(w.start.x), y: r(w.start.y) },
      end: { x: r(w.end.x), y: r(w.end.y) },
      thicknessMm: w.thicknessMm,
      declaredLengthMm: r(w.declaredLengthMm),
      calculatedLengthMm: r(w.calculatedLengthMm),
      lengthSource: w.lengthSource || (w.measured === false ? 'SKETCH' : 'MEASURED'),
      suspect: !!w.suspect,
      suggestedLengthMm: w.suggestedLengthMm ?? null,
      withinTolerance: w.withinTolerance !== false
    })),
    openings: (p.openings || []).map(o => ({
      id: o.id, type: o.type, wallId: o.wallId,
      center: { x: r(o.center.x), y: r(o.center.y) },
      widthMm: o.widthMm, heightMm: o.heightMm, sillHeightMm: o.sillHeightMm
    })),
    rooms: (p.rooms || []).map(room => ({
      roomId: room.roomId, name: room.name, type: room.type || 'altro',
      polygon: (room.polygon || []).map(pt => ({ x: r(pt.x), y: r(pt.y) })),
      quality: room.quality, confidence: room.confidence,
      floorAreaM2: room.floorAreaM2, ceilingAreaM2: room.ceilingAreaM2,
      perimeterM: room.perimeterM, heightMm: room.heightMm, volumeM3: room.volumeM3,
      widthM: room.widthM, depthM: room.depthM, skirtingM: room.skirtingM,
      grossWallAreaM2: room.grossWallAreaM2, netWallAreaM2: room.netWallAreaM2,
      openingsAreaM2: room.openingsAreaM2, revealsAreaM2: room.revealsAreaM2,
      tilingHeightMm: room.tilingHeightMm ?? null, tilingAreaM2: room.tilingAreaM2 ?? null,
      paintAreaM2: room.paintAreaM2,
      openings: (room.openings || []).map(o => ({ id: o.id, type: o.type, widthMm: o.widthMm, heightMm: o.heightMm })),
      questions: room.questions || []
    }))
  };
}

/** Sostituisce gli id tecnici dei muri con "muro N" come li vede l'utente sul telefono. */
export function humanizeText(text, walls) {
  let out = String(text || '');
  (walls || []).forEach((w, i) => {
    if (!w || !w.id) return;
    out = out.split(w.id).join('muro ' + (i + 1));
  });
  return out;
}

const WALL_RE = /\b[Pp]aret[ei] ([A-Za-z0-9_-]+)/;

/** Cosa fare quando l'utente tocca una domanda. */
export function questionAction(question, walls) {
  const text = String(question || '');
  const ids = new Set((walls || []).map(w => w.id));
  if (/diagonal|tramezzo|distanza da un angolo/i.test(text)) return { type: 'quote' };
  const m = text.match(WALL_RE);
  if (m && ids.has(m[1])) return { type: 'wall', wallId: m[1] };
  for (const id of ids) {
    if (id && text.includes(id)) return { type: 'wall', wallId: id };
  }
  return { type: 'info' };
}

export function isResultStale(result, fingerprint) {
  return !!(result && result.fingerprint && fingerprint && result.fingerprint !== fingerprint);
}

export function statusInfo(status) {
  if (status === 'PROCESSED') return { cls: 'ok', label: 'CALCOLATO' };
  if (status === 'NEEDS_REVIEW') return { cls: 'review', label: 'DA VERIFICARE' };
  if (status === 'ERROR') return { cls: 'error', label: 'ERRORE' };
  return { cls: 'pending', label: status || '—' };
}

export function qualityLabel(q) {
  if (q === 'OK') return 'OK';
  if (q === 'ESTIMATED') return 'STIMATO';
  if (q === 'NEEDS_REVIEW') return 'DA VERIFICARE';
  return q || '';
}

export function fmtNum(v, digits = 2, unit = '') {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits).replace('.', ',') + (unit ? ' ' + unit : '');
}

/** Disegna la pianta calcolata dal backend (coordinate in mm). */
export function drawBackendPlan(canvas, result, { dpr = 1, highlightWallId = null } = {}) {
  if (!canvas || !result) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, rect.width), H = Math.max(1, rect.height);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const pts = [];
  (result.walls || []).forEach(w => { pts.push(w.start, w.end); });
  (result.rooms || []).forEach(room => room.polygon.forEach(p => pts.push(p)));
  if (!pts.length) return;
  const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
  const pad = 28;
  const s = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY));
  const ox = (W - (maxX - minX) * s) / 2, oy = (H - (maxY - minY) * s) / 2;
  const tp = p => ({ x: ox + (p.x - minX) * s, y: oy + (p.y - minY) * s });

  const fills = ['#eff6ff', '#f0fdf4', '#fefce8', '#fdf2f8', '#f5f3ff', '#ecfeff'];
  (result.rooms || []).forEach((room, i) => {
    if (!room.polygon.length) return;
    ctx.beginPath();
    room.polygon.forEach((p, j) => { const q = tp(p); j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
    ctx.closePath();
    ctx.fillStyle = room.quality === 'NEEDS_REVIEW' ? '#fef2f2' : fills[i % fills.length];
    ctx.fill();
  });

  (result.walls || []).forEach(w => {
    const a = tp(w.start), b = tp(w.end);
    ctx.save();
    ctx.lineCap = 'square';
    ctx.lineWidth = Math.max(3, (w.thicknessMm || 120) * s);
    ctx.strokeStyle = w.id === highlightWallId ? '#2563eb'
      : w.suspect || !w.withinTolerance ? '#dc2626'
        : w.lengthSource === 'SKETCH' ? '#f59e0b'
          : w.lengthSource === 'CALCULATED' ? '#7c3aed' : '#0f172a';
    if (w.lengthSource !== 'MEASURED') ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  });

  const wallById = new Map((result.walls || []).map(w => [w.id, w]));
  (result.openings || []).forEach(o => {
    const w = wallById.get(o.wallId);
    if (!w) return;
    const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, half = o.widthMm / 2;
    const a = tp({ x: o.center.x - ux * half, y: o.center.y - uy * half });
    const b = tp({ x: o.center.x + ux * half, y: o.center.y + uy * half });
    ctx.save();
    ctx.lineWidth = Math.max(4, (w.thicknessMm || 120) * s + 2);
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = o.type === 'door' ? '#16a34a' : '#0891b2';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
  });

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  (result.rooms || []).forEach(room => {
    if (!room.polygon.length) return;
    const c = room.polygon.reduce((acc, p) => ({ x: acc.x + p.x / room.polygon.length, y: acc.y + p.y / room.polygon.length }), { x: 0, y: 0 });
    const q = tp(c);
    ctx.fillStyle = '#0f172a';
    ctx.font = '900 11px system-ui';
    ctx.fillText(room.name, q.x, q.y - 7);
    ctx.font = '800 10px system-ui';
    ctx.fillStyle = '#334155';
    ctx.fillText(fmtNum(room.floorAreaM2, 2, 'm²'), q.x, q.y + 8);
  });
}

