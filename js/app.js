(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('stage');
  const ctx = canvas.getContext('2d');
  const wrap = $('stageWrap');

  const STORAGE_KEY = 'ge360-rilievo-v2';
  const MAX_HISTORY = 30;

  let mode = 'draw';
  let rawStrokes = [];
  let walls = [];
  let openings = [];
  let currentStroke = null;
  let activePointerId = null;
  let selectedWallId = null;
  let currentOpeningId = null;
  let sheetType = null;
  let numberText = '';
  let history = [];
  let dpr = 1;
  let idCounter = 1;

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${idCounter++}`;
  }

  function vibrate(ms = 12) {
    try { navigator.vibrate?.(ms); } catch (_) {}
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 1300);
  }

  function snapshot() {
    return JSON.stringify({ rawStrokes, walls, openings, idCounter });
  }

  function checkpoint() {
    history.push(snapshot());
    if (history.length > MAX_HISTORY) history.shift();
  }

  function restoreSnapshot(raw) {
    const data = JSON.parse(raw);
    rawStrokes = data.rawStrokes || [];
    walls = data.walls || [];
    openings = data.openings || [];
    idCounter = data.idCounter || 1;
    currentStroke = null;
    selectedWallId = null;
    currentOpeningId = null;
    closeSheet();
    autoSave();
    updateUI();
    render();
  }

  function undo() {
    if (!history.length) {
      toast('Niente da annullare');
      return;
    }
    restoreSnapshot(history.pop());
    vibrate(20);
  }

  function pointFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: Date.now() };
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function distToSegment(p, a, b) {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (!len2) return { distance: dist(p, a), t: 0, point: { x: a.x, y: a.y } };
    let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + vx * t, y: a.y + vy * t };
    return { distance: dist(p, q), t, point: q };
  }

  function pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
    return total;
  }

  function rdp(points, epsilon) {
    if (points.length <= 2) return points.slice();
    const first = points[0];
    const last = points[points.length - 1];
    let index = -1;
    let max = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = distToSegment(points[i], first, last).distance;
      if (d > max) { index = i; max = d; }
    }
    if (max > epsilon && index > 0) {
      const left = rdp(points.slice(0, index + 1), epsilon);
      const right = rdp(points.slice(index), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  function removeTinySegments(points, minLen = 32) {
    if (points.length <= 2) return points;
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      if (dist(out[out.length - 1], points[i]) >= minLen) out.push(points[i]);
    }
    const last = points[points.length - 1];
    if (dist(out[out.length - 1], last) < minLen && out.length > 1) out[out.length - 1] = last;
    else out.push(last);
    return out;
  }

  function simplifyStroke(points) {
    let simplified = points;
    for (let eps = 12; eps <= 38; eps += 4) {
      simplified = rdp(points, eps);
      if (simplified.length <= 18) break;
    }
    simplified = removeTinySegments(simplified, 30);

    if (simplified.length >= 3 && dist(simplified[0], simplified[simplified.length - 1]) < 58) {
      simplified[simplified.length - 1] = { ...simplified[0] };
    }
    return simplified;
  }

  function createWallsFromStroke(stroke) {
    const created = [];
    for (let i = 1; i < stroke.simplified.length; i++) {
      const a = stroke.simplified[i - 1];
      const b = stroke.simplified[i];
      if (dist(a, b) < 28) continue;
      const wall = {
        id: uid('w'),
        strokeId: stroke.id,
        order: i - 1,
        a: { x: a.x, y: a.y },
        b: { x: b.x, y: b.y },
        lengthCm: null
      };
      walls.push(wall);
      created.push(wall.id);
    }
    stroke.wallIds = created;
  }

  function commitStroke() {
    const points = currentStroke;
    currentStroke = null;
    activePointerId = null;
    if (!points || points.length < 3 || pathLength(points) < 70) {
      render();
      return;
    }

    const simplified = simplifyStroke(points);
    if (simplified.length < 2) return;

    checkpoint();
    const stroke = {
      id: uid('s'),
      raw: points.map(p => ({ x: p.x, y: p.y })),
      simplified: simplified.map(p => ({ x: p.x, y: p.y })),
      wallIds: []
    };
    rawStrokes.push(stroke);
    createWallsFromStroke(stroke);
    autoSave();
    updateUI();
    render();
    vibrate(22);
    toast(`${stroke.wallIds.length} lati riconosciuti`);
  }

  function nearestWall(p, threshold = 44) {
    let best = null;
    for (const wall of walls) {
      const hit = distToSegment(p, wall.a, wall.b);
      if (hit.distance <= threshold && (!best || hit.distance < best.distance)) {
        best = { wall, ...hit };
      }
    }
    return best;
  }

  function setMode(next) {
    mode = next;
    for (const [id, value] of [['drawBtn','draw'],['doorBtn','door'],['windowBtn','window']]) {
      $(id).classList.toggle('active', value === mode);
    }
    const messages = {
      draw: 'Disegna col dito',
      door: 'Tocca un muro dove c’è la porta',
      window: 'Tocca un muro dove c’è la finestra'
    };
    toast(messages[mode]);
    vibrate();
  }

  function placeOpening(p) {
    const hit = nearestWall(p, 52);
    if (!hit) {
      vibrate(70);
      toast('Tocca più vicino a un muro');
      return;
    }
    checkpoint();
    const opening = {
      id: uid(mode === 'door' ? 'd' : 'f'),
      type: mode,
      wallId: hit.wall.id,
      position: Math.max(0.06, Math.min(0.94, hit.t)),
      widthCm: mode === 'door' ? 80 : 120
    };
    openings.push(opening);
    currentOpeningId = opening.id;
    numberText = (opening.widthCm / 100).toFixed(2).replace('.', ',');
    openSheet('opening');
    autoSave();
    render();
    vibrate(24);
  }

  function openNextMissingMeasure(preferredId = null) {
    let target = preferredId ? walls.find(w => w.id === preferredId) : null;
    if (!target) target = walls.find(w => !w.lengthCm);
    if (!target) {
      selectedWallId = null;
      closeSheet();
      toast('Tutte le misure sono inserite ✓');
      return;
    }
    selectedWallId = target.id;
    numberText = target.lengthCm ? (target.lengthCm / 100).toFixed(2).replace('.', ',') : '';
    openSheet('wall');
    render();
  }

  function openSheet(type) {
    sheetType = type;
    $('sheetBackdrop').classList.remove('hidden');
    if (type === 'wall') {
      const idx = walls.findIndex(w => w.id === selectedWallId);
      $('sheetKicker').textContent = `MISURA MURO ${idx + 1} DI ${walls.length}`;
    } else {
      const o = openings.find(x => x.id === currentOpeningId);
      $('sheetKicker').textContent = o?.type === 'door' ? 'LARGHEZZA PORTA' : 'LARGHEZZA FINESTRA';
    }
    updateSheetValue();
  }

  function closeSheet() {
    sheetType = null;
    $('sheetBackdrop').classList.add('hidden');
    numberText = '';
    updateSheetValue();
  }

  function updateSheetValue() {
    $('sheetValue').innerHTML = `${numberText || '0,00'} <span>m</span>`;
  }

  function keypad(key) {
    vibrate(7);
    if (key === '⌫’) numberText = numberText.slice(0, -1);
    else if (key === ',') {
      if (!numberText.includes(',')) numberText += numberText ? ',' : '0,';
    } else if (numberText.length < 6) numberText += key;
    updateSheetValue();
  }

  function parseMeters() {
    const value = Number(numberText.replace(',', '.'));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function confirmSheet() {
    const meters = parseMeters();
    if (!meters) {
      vibrate(80);
      toast('Inserisci una misura');
      return;
    }

    if (sheetType === 'wall') {
      checkpoint();
      const wall = walls.find(w => w.id === selectedWallId);
      if (wall) wall.lengthCm = Math.round(meters * 100);
      const justDone = selectedWallId;
      autoSave();
      const next = walls.find(w => !w.lengthCm && w.id !== justDone);
      if (next) {
        selectedWallId = next.id;
        numberText = '';
        openSheet('wall');
      } else {
        selectedWallId = null;
        closeSheet();
        toast('Misure completate ✓');
      }
    } else if (sheetType === 'opening') {
      checkpoint();
      const opening = openings.find(o => o.id === currentOpeningId);
      if (opening) opening.widthCm = Math.round(meters * 100);
      currentOpeningId = null;
      autoSave();
      closeSheet();
    }
    updateUI();
    render();
    vibrate(28);
  }

  function later() {
    if (sheetType === 'wall') {
      const current = selectedWallId;
      const idx = walls.findIndex(w => w.id === current);
      const rest = walls.slice(idx + 1).concat(walls.slice(0, idx));
      const next = rest.find(w => !w.lengthCm && w.id !== current);
      if (next) {
        selectedWallId = next.id;
        numberText = '';
        openSheet('wall');
      } else {
        selectedWallId = null;
        closeSheet();
      }
    } else {
      currentOpeningId = null;
      closeSheet();
    }
  }

  function autoSave(showToast = false) {
    const data = exportData();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    if (showToast) toast('Salvato sul telefono ✓');
  }

  function exportData() {
    return {
      version: 2,
      kind: 'ge360-rough-survey',
      updatedAt: new Date().toISOString(),
      viewport: { width: wrap.clientWidth, height: wrap.clientHeight },
      rawStrokes,
      walls,
      openings,
      summary: {
        strokes: rawStrokes.length,
        walls: walls.length,
        measuredWalls: walls.filter(w => w.lengthCm).length,
        missingMeasures: walls.filter(w => !w.lengthCm).length,
        doors: openings.filter(o => o.type === 'door').length,
        windows: openings.filter(o => o.type === 'window').length
      }
    };
  }

  function exportJson() {
    if (!walls.length) {
      toast('Prima fai uno schizzo');
      return;
    }
    const missing = walls.filter(w => !w.lengthCm).length;
    if (missing) {
      toast(`Mancano ${missing} misure`);
      openNextMissingMeasure();
      return;
    }
    autoSave();
    const blob = new Blob([JSON.stringify(exportData(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `GE360-rilievo-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Rilievo pronto ✓');
  }

  function clearAll() {
    if (!confirm('Cancellare tutto il rilievo?')) return;
    checkpoint();
    rawStrokes = [];
    walls = [];
    openings = [];
    selectedWallId = null;
    currentOpeningId = null;
    autoSave();
    updateUI();
    render();
  }

  function updateUI() {
    const hasData = walls.length > 0;
    $('emptyHint').classList.toggle('hidden', hasData || !!currentStroke);
    $('statusPill').classList.toggle('hidden', !hasData);
    $('clearBtn').classList.toggle('hidden', !hasData);
    const missing = walls.filter(w => !w.lengthCm).length;
    $('statusPill').textContent = `${walls.length} muri · ${missing ? `${missing} da misurare` : 'misure complete ✓'}`;
    $('measureLabel').textContent = missing ? `MISURE ${missing}` : 'MISURE ✓';
  }

  function drawPolyline(points, color, width, dash = []) {
    if (!points || points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.restore();
  }

  function formatLength(cm) {
    return cm ? `${(cm / 100).toFixed(2).replace('.', ',')} m` : '?';
  }

  function drawMeasureLabel(wall) {
    const x = (wall.a.x + wall.b.x) / 2;
    const y = (wall.a.y + wall.b.y) / 2;
    const text = formatLength(wall.lengthCm);
    ctx.save();
    ctx.font = '900 13px system-ui';
    const width = Math.max(42, ctx.measureText(text).width + 16);
    ctx.fillStyle = wall.lengthCm ? '#ffffff' : '#fef3c7';
    ctx.strokeStyle = wall.lengthCm ? '#cbd5e1' : '#f59e0b';
    ctx.lineWidth = 2;
    roundRect(ctx, x - width / 2, y - 18, width, 36, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  function roundRect(context, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    context.beginPath();
    context.moveTo(x + rr, y);
    context.arcTo(x + w, y, x + w, y + h, rr);
    context.arcTo(x + w, y + h, x, y + h, rr);
    context.arcTo(x, y + h, x, y, rr);
    context.arcTo(x, y, x + w, y, rr);
    context.closePath();
  }

  function drawOpening(opening) {
    const wall = walls.find(w => w.id === opening.wallId);
    if (!wall) return;
    const x = wall.a.x + (wall.b.x - wall.a.x) * opening.position;
    const y = wall.a.y + (wall.b.y - wall.a.y) * opening.position;
    ctx.save();
    ctx.fillStyle = opening.type === 'door' ? '#22c55e' : '#06b6d4';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 12px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opening.type === 'door' ? 'P' : 'F', x, y + 1);
    ctx.restore();
  }

  function render() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);

    for (const stroke of rawStrokes) drawPolyline(stroke.raw, '#cbd5e1', 3);
    for (const wall of walls) {
      ctx.save();
      ctx.strokeStyle = wall.id === selectedWallId ? '#2563eb' : '#0f172a';
      ctx.lineWidth = wall.id === selectedWallId ? 10 : 8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(wall.a.x, wall.a.y);
      ctx.lineTo(wall.b.x, wall.b.y);
      ctx.stroke();
      ctx.restore();
    }
    for (const wall of walls) drawMeasureLabel(wall);
    for (const opening of openings) drawOpening(opening);
    if (currentStroke) drawPolyline(currentStroke, '#2563eb', 7);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    render();
  }

  function loadSaved() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!data) return;
      rawStrokes = Array.isArray(data.rawStrokes) ? data.rawStrokes : [];
      walls = Array.isArray(data.walls) ? data.walls : [];
      openings = Array.isArray(data.openings) ? data.openings : [];
    } catch (_) {}
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const p = pointFromEvent(e);
    if (mode === 'draw') {
      activePointerId = e.pointerId;
      canvas.setPointerCapture?.(e.pointerId);
      currentStroke = [p];
      $('emptyHint').classList.add('hidden');
      render();
    } else if (mode === 'door' || mode === 'window') {
      placeOpening(p);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (mode !== 'draw' || currentStroke === null || e.pointerId !== activePointerId) return;
    e.preventDefault();
    const p = pointFromEvent(e);
    const last = currentStroke[currentStroke.length - 1];
    if (dist(last, p) >= 3) currentStroke.push(p);
    render();
  });

  canvas.addEventListener('pointerup', (e) => {
    if (mode !== 'draw' || currentStroke === null || e.pointerId !== activePointerId) return;
    e.preventDefault();
    const p = pointFromEvent(e);
    const last = currentStroke[currentStroke.length - 1];
    if (dist(last, p) > 2) currentStroke.push(p);
    commitStroke();
  });

  canvas.addEventListener('pointercancel', () => {
    currentStroke = null;
    activePointerId = null;
    updateUI();
    render();
  });

  $('drawBtn').addEventListener('click', () => setMode('draw'));
  $('doorBtn').addEventListener('click', () => setMode('door'));
  $('windowBtn').addEventListener('click', () => setMode('window'));
  $('measureBtn').addEventListener('click', () => openNextMissingMeasure());
  $('doneBtn').addEventListener('click', exportJson);
  $('undoBtn').addEventListener('click', undo);
  $('saveBtn').addEventListener('click', () => autoSave(true));
  $('clearBtn').addEventListener('click', clearAll);
  $('confirmBtn').addEventListener('click', confirmSheet);
  $('laterBtn').addEventListener('click', later);
  document.querySelectorAll('[data-key]').forEach(btn => btn.addEventListener('click', () => keypad(btn.dataset.key)));
  $('sheetBackdrop').addEventListener('click', (e) => {
    if (e.target === $('sheetBackdrop')) later();
  });

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoSave(); });

  loadSaved();
  resize();
  updateUI();
  render();
})();
