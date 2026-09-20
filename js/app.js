import { solveFloorPlan } from '../geometry-engine/index.js';
import { buildFaces, findFaceAtPoint, matchRoomFace, calculateSurfaces } from './room-surfaces.js';

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('stage');
  var ctx = canvas.getContext('2d');
  var wrap = $('stageWrap');

  var LIBRARY_KEY = 'ge360-rilievo-library-v3';
  var SETTINGS_KEY = 'ge360-rilievo-settings-v1';

  var library = [];
  var settings = { serverUrl: '', apiKey: '' };
  var activePlanId = null;
  var mode = 'draw';
  var rawStrokes = [];
  var walls = [];
  var openings = [];
  var currentStroke = null;
  var activePointerId = null;
  var selectedWallId = null;
  var currentOpeningId = null;
  var sheetType = null;
  var numberText = '';
  var history = [];
  var dpr = 1;
  var viewZoom = 1;
  var viewRotation = 0;
  var MIN_ZOOM = 0.1;
  var MAX_ZOOM = 5;
  var solverMode = 'normal';
  var solverResult = null;
  var solverOriginal = null;
  var rooms = [];
  var wallHeightM = 2.70;
  var roomPickMode = false;
  var pendingRoomFace = null;
  var pendingRoomId = null;
  var selectedRoomName = '';
  var surfaceCache = null;

  function uid(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function vibrate(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch (_) {}
  }

  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.add('hidden'); }, 1500);
  }

  function parse(raw, fallback) {
    try {
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }

  function saveLibrary() {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  }

  function loadAll() {
    library = parse(localStorage.getItem(LIBRARY_KEY), []);
    settings = Object.assign(settings, parse(localStorage.getItem(SETTINGS_KEY), {}));
    renderDashboard();
    updateServerBadge();
  }

  function currentPlan() {
    for (var i = 0; i < library.length; i++) if (library[i].id === activePlanId) return library[i];
    return null;
  }

  function summary(plan) {
    var ws = plan ? (plan.walls || []) : walls;
    var os = plan ? (plan.openings || []) : openings;
    return {
      walls: ws.length,
      missing: ws.filter(function (w) { return !w.lengthCm; }).length,
      doors: os.filter(function (o) { return o.type === 'door'; }).length,
      windows: os.filter(function (o) { return o.type === 'window'; }).length,
      rooms: plan ? (plan.rooms || []).length : rooms.length,
      floorM2: plan && plan.surfaceSummary && Number.isFinite(plan.surfaceSummary.floorM2) ? plan.surfaceSummary.floorM2 : null
    };
  }

  function persistActive(showToast) {
    var plan = currentPlan();
    if (!plan) return;
    plan.name = ($('planName').value.trim() || 'Rilievo').slice(0, 40);
    plan.updatedAt = new Date().toISOString();
    plan.rawStrokes = clone(rawStrokes);
    plan.walls = clone(walls);
    plan.openings = clone(openings);
    plan.rooms = clone(rooms);
    plan.wallHeightM = wallHeightM;
    plan.view = { zoom: viewZoom, rotation: viewRotation };
    plan.surfaceSummary = surfaceCache && surfaceCache.totals ? clone(surfaceCache.totals) : null;
    plan.summary = summary();
    saveLibrary();
    if (showToast) toast('Salvato ✓');
  }

  function showDashboard() {
    closeSheet();
    $('editor').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    activePlanId = null;
    renderDashboard();
  }

  function showEditor() {
    $('dashboard').classList.add('hidden');
    $('editor').classList.remove('hidden');
    requestAnimationFrame(resize);
  }

  function newPlan() {
    var now = new Date().toISOString();
    var plan = {
      id: uid('plan'),
      name: 'Rilievo ' + new Date().toLocaleDateString('it-IT'),
      createdAt: now,
      updatedAt: now,
      rawStrokes: [],
      walls: [],
      openings: [],
      rooms: [],
      wallHeightM: 2.70,
      view: { zoom: 1, rotation: 0 }
    };
    library.unshift(plan);
    saveLibrary();
    openPlan(plan.id);
  }

  function openPlan(id) {
    var plan = library.find(function (p) { return p.id === id; });
    if (!plan) return;
    activePlanId = id;
    rawStrokes = clone(plan.rawStrokes || []);
    walls = clone(plan.walls || []);
    openings = clone(plan.openings || []);
    rooms = clone(plan.rooms || []);
    wallHeightM = Number.isFinite(plan.wallHeightM) && plan.wallHeightM > 0 ? plan.wallHeightM : 2.70;
    surfaceCache = null;
    roomPickMode = false;
    viewZoom = plan.view && Number.isFinite(plan.view.zoom) ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, plan.view.zoom)) : 1;
    viewRotation = plan.view && Number.isFinite(plan.view.rotation) ? ((plan.view.rotation % 360) + 360) % 360 : 0;
    history = [];
    currentStroke = null;
    selectedWallId = null;
    currentOpeningId = null;
    $('planName').value = plan.name || 'Rilievo';
    setMode('draw', false);
    showEditor();
    updateViewControls();
    updateUI();
    refreshSurfaceCache();
    render();
  }

  function deletePlan(id) {
    var plan = library.find(function (p) { return p.id === id; });
    if (!plan) return;
    if (!confirm('Eliminare "' + (plan.name || 'Rilievo') + '"?')) return;
    library = library.filter(function (p) { return p.id !== id; });
    saveLibrary();
    renderDashboard();
  }

  function makeButton(label, cls, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.className = cls;
    b.addEventListener('click', fn);
    return b;
  }

  function renderDashboard() {
    var grid = $('planGrid');
    grid.innerHTML = '';
    $('emptyLibrary').classList.toggle('hidden', library.length > 0);
    library.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });

    library.forEach(function (plan) {
      var card = document.createElement('article');
      card.className = 'plan-card';

      var preview = document.createElement('div');
      preview.className = 'plan-preview';
      var pc = document.createElement('canvas');
      preview.appendChild(pc);

      var info = document.createElement('div');
      info.className = 'plan-info';
      var s = summary(plan);
      var date = plan.updatedAt ? new Date(plan.updatedAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      var h3 = document.createElement('h3');
      h3.textContent = plan.name || 'Rilievo';
      var meta = document.createElement('div');
      meta.className = 'plan-meta';
      meta.textContent = s.walls + ' muri · ' + (s.rooms ? s.rooms + ' ambienti · ' : '') + (Number.isFinite(s.floorM2) ? s.floorM2.toFixed(1).replace('.', ',') + ' m² · ' : '') + (s.missing ? s.missing + ' misure mancanti' : 'misure complete') + ' · ' + date;

      var actions = document.createElement('div');
      actions.className = 'plan-actions';
      actions.appendChild(makeButton('APRI', 'open-plan', function () { openPlan(plan.id); }));
      actions.appendChild(makeButton('DEBIAN', 'send-plan', function () { sendPlan(plan.id); }));
      actions.appendChild(makeButton('🗑', 'delete-plan', function () { deletePlan(plan.id); }));

      info.appendChild(h3);
      info.appendChild(meta);
      info.appendChild(actions);
      card.appendChild(preview);
      card.appendChild(info);
      grid.appendChild(card);
      requestAnimationFrame(function () { drawPreview(pc, plan); });
    });
  }

  function drawPreview(c, plan) {
    var rect = c.getBoundingClientRect();
    var ratio = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(rect.width * ratio));
    c.height = Math.max(1, Math.round(rect.height * ratio));
    var pctx = c.getContext('2d');
    pctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    pctx.fillStyle = '#f8fafc';
    pctx.fillRect(0, 0, rect.width, rect.height);

    var ws = plan.walls || [];
    if (!ws.length) return;

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ws.forEach(function (w) {
      minX = Math.min(minX, w.a.x, w.b.x);
      minY = Math.min(minY, w.a.y, w.b.y);
      maxX = Math.max(maxX, w.a.x, w.b.x);
      maxY = Math.max(maxY, w.a.y, w.b.y);
    });
    var bw = Math.max(1, maxX - minX);
    var bh = Math.max(1, maxY - minY);
    var scale = Math.min((rect.width - 30) / bw, (rect.height - 30) / bh);
    var ox = (rect.width - bw * scale) / 2 - minX * scale;
    var oy = (rect.height - bh * scale) / 2 - minY * scale;

    pctx.strokeStyle = '#0f172a';
    pctx.lineWidth = 5;
    pctx.lineCap = 'round';
    ws.forEach(function (w) {
      pctx.beginPath();
      pctx.moveTo(w.a.x * scale + ox, w.a.y * scale + oy);
      pctx.lineTo(w.b.x * scale + ox, w.b.y * scale + oy);
      pctx.stroke();
    });
  }

  function checkpoint() {
    history.push(JSON.stringify({ rawStrokes: rawStrokes, walls: walls, openings: openings, rooms: rooms, wallHeightM: wallHeightM }));
    if (history.length > 30) history.shift();
  }

  function undo() {
    if (!history.length) return toast('Niente da annullare');
    var data = JSON.parse(history.pop());
    rawStrokes = data.rawStrokes || [];
    walls = data.walls || [];
    openings = data.openings || [];
    rooms = data.rooms || [];
    wallHeightM = Number.isFinite(data.wallHeightM) ? data.wallHeightM : wallHeightM;
    surfaceCache = null;
    closeSheet();
    persistActive();
    updateUI();
    render();
    vibrate(20);
  }

  function viewCenter() {
    return { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
  }

  function worldToScreen(p) {
    var center = viewCenter();
    var dx = p.x - center.x;
    var dy = p.y - center.y;
    var rad = viewRotation * Math.PI / 180;
    var cos = Math.cos(rad);
    var sin = Math.sin(rad);
    return {
      x: center.x + (dx * cos - dy * sin) * viewZoom,
      y: center.y + (dx * sin + dy * cos) * viewZoom
    };
  }

  function screenToWorld(p) {
    var center = viewCenter();
    var dx = (p.x - center.x) / viewZoom;
    var dy = (p.y - center.y) / viewZoom;
    var rad = viewRotation * Math.PI / 180;
    var cos = Math.cos(rad);
    var sin = Math.sin(rad);
    return {
      x: center.x + dx * cos + dy * sin,
      y: center.y - dx * sin + dy * cos
    };
  }

  function point(e) {
    var r = canvas.getBoundingClientRect();
    return screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
  }

  function updateViewControls() {
    $('zoomResetBtn').textContent = Math.round(viewZoom * 100) + '%';
  }

  function setZoom(next) {
    viewZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    updateViewControls();
    persistActive();
    render();
    vibrate(10);
  }

  function rotateView() {
    viewRotation = (viewRotation + 90) % 360;
    persistActive();
    render();
    vibrate(18);
    toast('Vista ruotata ' + viewRotation + '°');
  }

  function resetView() {
    viewZoom = 1;
    viewRotation = 0;
    updateViewControls();
    persistActive();
    render();
    toast('Vista ripristinata');
  }

  function openingReferenceLabel(opening) {
    if (!opening) return 'SINISTRO';
    var wall = walls.find(function (w) { return w.id === opening.wallId; });
    if (!wall) return opening.referenceEnd === 'b' ? 'DESTRO' : 'SINISTRO';
    var a = worldToScreen(wall.a);
    var b = worldToScreen(wall.b);
    if (Math.abs(a.x - b.x) < 1) return opening.referenceEnd === 'b' ? 'DESTRO' : 'SINISTRO';
    var leftEnd = a.x < b.x ? 'a' : 'b';
    return opening.referenceEnd === leftEnd ? 'SINISTRO' : 'DESTRO';
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function distToSegment(p, a, b) {
    var vx = b.x - a.x, vy = b.y - a.y;
    var len2 = vx * vx + vy * vy;
    if (!len2) return { distance: dist(p, a), t: 0 };
    var t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    var q = { x: a.x + vx * t, y: a.y + vy * t };
    return { distance: dist(p, q), t: t };
  }

  function pathLength(points) {
    var total = 0;
    for (var i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
    return total;
  }

  function rdp(points, epsilon) {
    if (points.length <= 2) return points.slice();
    var first = points[0], last = points[points.length - 1], index = -1, max = 0;
    for (var i = 1; i < points.length - 1; i++) {
      var d = distToSegment(points[i], first, last).distance;
      if (d > max) { max = d; index = i; }
    }
    if (max > epsilon && index > 0) {
      var left = rdp(points.slice(0, index + 1), epsilon);
      var right = rdp(points.slice(index), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  function simplify(points) {
    var out = points;
    for (var eps = 10; eps <= 34; eps += 4) {
      out = rdp(points, eps / viewZoom);
      if (out.length <= 14) break;
    }
    if (out.length >= 3 && dist(out[0], out[out.length - 1]) < 58) out[out.length - 1] = { x: out[0].x, y: out[0].y };
    return out;
  }

  function commitStroke() {
    var points = currentStroke;
    currentStroke = null;
    activePointerId = null;
    if (!points || points.length < 2 || pathLength(points) < 45 / viewZoom) { render(); return; }

    var simp = simplify(points);
    if (simp.length < 2) return;

    checkpoint();
    var stroke = {
      id: uid('s'),
      raw: points.map(function (p) { return { x: p.x, y: p.y }; }),
      simplified: simp.map(function (p) { return { x: p.x, y: p.y }; }),
      wallIds: []
    };
    rawStrokes.push(stroke);
    surfaceCache = null;

    for (var i = 1; i < simp.length; i++) {
      if (dist(simp[i - 1], simp[i]) < 24 / viewZoom) continue;
      var wall = {
        id: uid('w'),
        strokeId: stroke.id,
        a: { x: simp[i - 1].x, y: simp[i - 1].y },
        b: { x: simp[i].x, y: simp[i].y },
        lengthCm: null
      };
      walls.push(wall);
      stroke.wallIds.push(wall.id);
    }

    persistActive();
    updateUI();
    render();
    vibrate(25);

    if (stroke.wallIds.length) {
      toast(stroke.wallIds.length === 1 ? 'Inserisci subito la misura' : stroke.wallIds.length + ' lati: inserisci le misure');
      openNextMissing(stroke.wallIds[0]);
    }
  }

  function nearestWall(p) {
    var best = null;
    walls.forEach(function (wall) {
      var h = distToSegment(p, wall.a, wall.b);
      if (h.distance <= 55 / viewZoom && (!best || h.distance < best.distance)) best = { wall: wall, distance: h.distance, t: h.t };
    });
    return best;
  }

  function setMode(next, announce) {
    mode = next;
    [['drawBtn', 'draw'], ['doorBtn', 'door'], ['windowBtn', 'window']].forEach(function (pair) {
      $(pair[0]).classList.toggle('active', pair[1] === mode);
    });
    if (announce !== false) toast(next === 'draw' ? 'Disegna col dito' : next === 'door' ? 'Tocca il muro della porta' : 'Tocca il muro della finestra');
  }

  function placeOpening(p) {
    var hit = nearestWall(p);
    if (!hit) return toast('Tocca più vicino a un muro');
    checkpoint();
    var opening = {
      id: uid(mode === 'door' ? 'd' : 'f'),
      type: mode,
      wallId: hit.wall.id,
      position: Math.max(.06, Math.min(.94, hit.t)),
      widthCm: mode === 'door' ? 80 : 120,
      referenceEnd: hit.t <= 0.5 ? 'a' : 'b',
      offsetCm: null
    };
    openings.push(opening);
    currentOpeningId = opening.id;
    numberText = (opening.widthCm / 100).toFixed(2).replace('.', ',');
    openSheet('opening-width');
    persistActive();
    render();
  }

  function recalcOpeningPosition(opening) {
    if (!opening) return;
    var wall = walls.find(function (w) { return w.id === opening.wallId; });
    if (!wall || !wall.lengthCm || opening.offsetCm == null) return;

    var half = (opening.widthCm || 0) / 2;
    var centerFromA;
    if (opening.referenceEnd === 'b') {
      centerFromA = wall.lengthCm - opening.offsetCm - half;
    } else {
      centerFromA = opening.offsetCm + half;
    }
    var t = centerFromA / wall.lengthCm;
    opening.position = Math.max(.01, Math.min(.99, t));
  }

  function toggleOpeningCorner() {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening) return;
    opening.referenceEnd = opening.referenceEnd === 'a' ? 'b' : 'a';
    recalcOpeningPosition(opening);
    persistActive();
    openSheet('opening-offset');
    render();
    vibrate(20);
  }

  function openNextMissing(preferredId) {
    var target = preferredId ? walls.find(function (w) { return w.id === preferredId && !w.lengthCm; }) : null;
    if (!target) target = walls.find(function (w) { return !w.lengthCm; });
    if (!target) { selectedWallId = null; closeSheet(); return toast('Misure complete ✓'); }
    selectedWallId = target.id;
    numberText = target.lengthCm ? (target.lengthCm / 100).toFixed(2).replace('.', ',') : '';
    openSheet('wall');
    render();
  }

  function openSheet(type) {
    sheetType = type;
    $('sheetBackdrop').classList.remove('hidden');
    if (type === 'wall') {
      var idx = walls.findIndex(function (w) { return w.id === selectedWallId; });
      $('sheetKicker').textContent = 'MISURA MURO ' + (idx + 1) + ' DI ' + walls.length;
    } else {
      var o = openings.find(function (x) { return x.id === currentOpeningId; });
      if (type === 'opening-width') {
        $('sheetKicker').textContent = o && o.type === 'door' ? 'LARGHEZZA PORTA' : 'LARGHEZZA FINESTRA';
        $('cornerToggleBtn').classList.add('hidden');
      } else if (type === 'opening-offset') {
        var side = openingReferenceLabel(o);
        var otherSide = side === 'SINISTRO' ? 'DESTRO' : 'SINISTRO';
        $('sheetKicker').textContent = 'DISTANZA ANGOLO ' + side + ' → BORDO ' + (o && o.type === 'door' ? 'PORTA' : 'FINESTRA');
        $('cornerToggleBtn').classList.remove('hidden');
        $('cornerToggleBtn').textContent = '↔ USA ANGOLO ' + otherSide;
      }
    }
    if (type === 'wall') $('cornerToggleBtn').classList.add('hidden');
    updateSheetValue();
  }

  function closeSheet() {
    sheetType = null;
    $('sheetBackdrop').classList.add('hidden');
    $('cornerToggleBtn').classList.add('hidden');
    numberText = '';
    updateSheetValue();
  }

  function updateSheetValue() {
    $('sheetValue').innerHTML = (numberText || '0,00') + ' <span>m</span>';
  }

  function keypad(key) {
    if (key === '⌫') numberText = numberText.slice(0, -1);
    else if (key === ',') {
      if (numberText.indexOf(',') === -1) numberText += numberText ? ',' : '0,';
    } else if (numberText.length < 6) numberText += key;
    updateSheetValue();
  }

  function confirmSheet() {
    var meters = Number(numberText.replace(',', '.'));
    if (!numberText.trim() || !Number.isFinite(meters) || (sheetType === 'opening-offset' ? meters < 0 : meters <= 0)) return toast('Inserisci una misura');

    if (sheetType === 'wall') {
      checkpoint();
      var wall = walls.find(function (w) { return w.id === selectedWallId; });
      if (wall) wall.lengthCm = Math.round(meters * 100);
      surfaceCache = null;
      var strokeId = wall ? wall.strokeId : null;
      var next = walls.find(function (w) { return w.strokeId === strokeId && !w.lengthCm && w.id !== selectedWallId; });
      if (!next) next = walls.find(function (w) { return !w.lengthCm && w.id !== selectedWallId; });
      persistActive();
      if (next) {
        selectedWallId = next.id;
        numberText = '';
        openSheet('wall');
      } else {
        selectedWallId = null;
        closeSheet();
        refreshSurfaceCache();
        toast('Misure completate ✓');
      }
    } else if (sheetType === 'opening-width') {
      checkpoint();
      var op = openings.find(function (o) { return o.id === currentOpeningId; });
      if (op) op.widthCm = Math.round(meters * 100);
      surfaceCache = null;
      persistActive();
      numberText = '';
      openSheet('opening-offset');
      render();
      toast('Ora misura dall’angolo al bordo');
      return;
    } else if (sheetType === 'opening-offset') {
      checkpoint();
      var op2 = openings.find(function (o) { return o.id === currentOpeningId; });
      if (op2) {
        var ow = walls.find(function (w) { return w.id === op2.wallId; });
        var offsetCm = Math.round(meters * 100);
        if (ow && ow.lengthCm && offsetCm + op2.widthCm > ow.lengthCm) {
          toast('Non entra nel muro: riduci la distanza');
          vibrate(80);
          return;
        }
        op2.offsetCm = offsetCm;
        recalcOpeningPosition(op2);
        surfaceCache = null;
      }
      currentOpeningId = null;
      persistActive();
      closeSheet();
    }
    updateUI();
    render();
  }

  function later() {
    if (sheetType === 'wall') {
      selectedWallId = null;
      closeSheet();
    } else {
      currentOpeningId = null;
      closeSheet();
    }
  }

  function planPayload(plan) {
    return {
      version: 4,
      kind: 'ge360-rough-survey',
      planId: plan.id,
      name: plan.name || 'Rilievo',
      updatedAt: plan.updatedAt || new Date().toISOString(),
      rawStrokes: plan.rawStrokes || [],
      walls: plan.walls || [],
      openings: plan.openings || [],
      rooms: plan.rooms || [],
      wallHeightM: Number.isFinite(plan.wallHeightM) ? plan.wallHeightM : 2.70,
      surfaces: plan.surfaceSummary || null,
      summary: summary(plan)
    };
  }

  function solverInput() {
    return {
      version: 4,
      planId: activePlanId,
      walls: clone(walls),
      openings: clone(openings)
    };
  }

  function openSolver() {
    if (!walls.length) return toast('Prima disegna la planimetria');
    var missing = walls.filter(function (w) { return !Number.isFinite(w.lengthCm) || w.lengthCm <= 0; });
    if (missing.length) {
      toast('Mancano ' + missing.length + ' misure dei muri');
      return openNextMissing(missing[0].id);
    }
    var incompleteOpenings = openings.filter(function (o) {
      return !Number.isFinite(o.widthCm) || o.widthCm <= 0 || !Number.isFinite(o.offsetCm) || o.offsetCm < 0;
    });
    if (incompleteOpenings.length) {
      toast('Completa prima le misure di porte e finestre');
      return;
    }

    solverOriginal = {
      rawStrokes: clone(rawStrokes),
      walls: clone(walls),
      openings: clone(openings)
    };
    $('solveBackdrop').classList.remove('hidden');
    runSolver(solverMode);
  }

  function closeSolver() {
    $('solveBackdrop').classList.add('hidden');
    solverResult = null;
    solverOriginal = null;
  }

  function runSolver(nextMode) {
    solverMode = nextMode || 'normal';
    document.querySelectorAll('[data-solver-mode]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.solverMode === solverMode);
    });

    try {
      solverResult = solveFloorPlan(solverInput(), { mode: solverMode });
    } catch (e) {
      solverResult = {
        success: false,
        status: 'invalid',
        walls: [],
        openings: [],
        warnings: [],
        errors: [{ type: 'engine_exception', severity: 'error', message: e && e.message ? e.message : String(e) }],
        closure: { closed: false, errorCm: null },
        stats: { snappedAngles: 0, timeMs: 0 }
      };
    }
    renderSolverComparison();
  }

  function solverPointBounds(wallList) {
    var pts = [];
    (wallList || []).forEach(function (w) {
      if (w && w.a && Number.isFinite(w.a.x) && Number.isFinite(w.a.y)) pts.push(w.a);
      if (w && w.b && Number.isFinite(w.b.x) && Number.isFinite(w.b.y)) pts.push(w.b);
    });
    if (!pts.length) return null;
    var minX = Math.min.apply(null, pts.map(function (p) { return p.x; }));
    var minY = Math.min.apply(null, pts.map(function (p) { return p.y; }));
    var maxX = Math.max.apply(null, pts.map(function (p) { return p.x; }));
    var maxY = Math.max.apply(null, pts.map(function (p) { return p.y; }));
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  function drawSolverCanvas(canvasEl, wallList, openingList, solved) {
    var rect = canvasEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var ratio = Math.min(2, window.devicePixelRatio || 1);
    canvasEl.width = Math.round(rect.width * ratio);
    canvasEl.height = Math.round(rect.height * ratio);
    var pc = canvasEl.getContext('2d');
    pc.setTransform(ratio, 0, 0, ratio, 0, 0);
    pc.clearRect(0, 0, rect.width, rect.height);
    pc.fillStyle = solved ? '#faf5ff' : '#ffffff';
    pc.fillRect(0, 0, rect.width, rect.height);

    var usable = (wallList || []).filter(function (w) { return w && w.a && w.b; });
    var bounds = solverPointBounds(usable);
    if (!bounds) return;
    var bw = Math.max(1, bounds.maxX - bounds.minX);
    var bh = Math.max(1, bounds.maxY - bounds.minY);
    var scale = Math.min((rect.width - 30) / bw, (rect.height - 42) / bh);
    var ox = (rect.width - bw * scale) / 2 - bounds.minX * scale;
    var oy = (rect.height - bh * scale) / 2 - bounds.minY * scale;

    function tp(p) { return { x: p.x * scale + ox, y: p.y * scale + oy }; }

    pc.lineCap = 'round';
    pc.lineJoin = 'round';
    usable.forEach(function (w) {
      var a = tp(w.a), b = tp(w.b);
      pc.strokeStyle = solved ? '#5b21b6' : '#0f172a';
      pc.lineWidth = 5;
      pc.beginPath();
      pc.moveTo(a.x, a.y);
      pc.lineTo(b.x, b.y);
      pc.stroke();

      if (w.lengthCm) {
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        var label = (w.lengthCm / 100).toFixed(2).replace('.', ',') + ' m';
        pc.font = '800 9px system-ui';
        var tw = pc.measureText(label).width + 8;
        pc.fillStyle = 'rgba(255,255,255,.94)';
        pc.fillRect(mx - tw / 2, my - 8, tw, 16);
        pc.fillStyle = '#334155';
        pc.textAlign = 'center';
        pc.textBaseline = 'middle';
        pc.fillText(label, mx, my);
      }
    });

    (openingList || []).forEach(function (o) {
      var p = null;
      if (solved && o.center && Number.isFinite(o.center.x)) {
        p = tp(o.center);
      } else {
        var wall = usable.find(function (w) { return w.id === o.wallId; });
        if (wall && Number.isFinite(o.position)) {
          p = tp({
            x: wall.a.x + (wall.b.x - wall.a.x) * o.position,
            y: wall.a.y + (wall.b.y - wall.a.y) * o.position
          });
        }
      }
      if (!p) return;
      pc.fillStyle = o.type === 'door' ? '#22c55e' : '#06b6d4';
      pc.beginPath();
      pc.arc(p.x, p.y, 5, 0, Math.PI * 2);
      pc.fill();
    });
  }

  function renderSolverComparison() {
    if (!solverOriginal || !solverResult) return;
    requestAnimationFrame(function () {
      drawSolverCanvas($('solverBefore'), solverOriginal.walls, solverOriginal.openings, false);
      drawSolverCanvas($('solverAfter'), solverResult.walls, solverResult.openings, true);
    });

    var summaryEl = $('solverSummary');
    var closure = solverResult.closure || {};
    var stats = solverResult.stats || {};
    var gap = Number.isFinite(closure.errorCm) ? closure.errorCm : null;
    var gapText = gap == null ? 'nessun loop chiuso' : (closure.closed ? 'chiusura OK' : 'scarto ' + String(gap).replace('.', ',') + ' cm');
    if (solverResult.errors && solverResult.errors.length) {
      summaryEl.className = 'solver-summary error';
      summaryEl.textContent = 'Non applicabile · ' + solverResult.errors.length + ' errori · ' + gapText;
    } else if ((solverResult.warnings && solverResult.warnings.some(function (w) { return w.severity === 'warning'; })) || !closure.closed) {
      summaryEl.className = 'solver-summary warn';
      summaryEl.textContent = 'Sistemata con avvisi · ' + gapText + ' · ' + (stats.snappedAngles || 0) + ' correzioni angolari';
    } else {
      summaryEl.className = 'solver-summary ok';
      summaryEl.textContent = 'Pianta sistemata ✓ · ' + gapText + ' · ' + (stats.snappedAngles || 0) + ' correzioni · ' + (stats.timeMs || 0) + ' ms';
    }

    var messages = $('solverMessages');
    messages.innerHTML = '';
    var all = []
      .concat((solverResult.errors || []).map(function (x) { return { kind: 'error', message: x.message }; }))
      .concat((solverResult.warnings || []).filter(function (x) { return x.severity !== 'info'; }).map(function (x) { return { kind: 'warn', message: x.message }; }));
    all.slice(0, 5).forEach(function (m) {
      var el = document.createElement('div');
      el.className = 'solver-message ' + (m.kind === 'error' ? 'error' : '');
      el.textContent = m.message;
      messages.appendChild(el);
    });
    if (!all.length) {
      var ok = document.createElement('div');
      ok.className = 'solver-message info';
      ok.textContent = 'Nessuna incongruenza importante rilevata.';
      messages.appendChild(ok);
    }

    $('applySolverBtn').disabled = !solverResult.success || !(solverResult.walls || []).some(function (w) { return w.status === 'solved'; });
  }

  function applySolverResult() {
    if (!solverResult || !solverResult.success) return;
    var solvedWalls = (solverResult.walls || []).filter(function (w) { return w.status === 'solved' && w.a && w.b; });
    if (!solvedWalls.length) return;

    checkpoint();
    var plan = currentPlan();
    if (plan) {
      if (!Array.isArray(plan.geometryHistory)) plan.geometryHistory = [];
      plan.geometryHistory.push({
        savedAt: new Date().toISOString(),
        mode: solverMode,
        rawStrokes: clone(rawStrokes),
        walls: clone(walls),
        openings: clone(openings)
      });
      if (plan.geometryHistory.length > 3) plan.geometryHistory.shift();
      plan.geometryState = {
        engineVersion: solverResult.engineVersion || null,
        mode: solverMode,
        appliedAt: new Date().toISOString(),
        closure: clone(solverResult.closure || {}),
        stats: clone(solverResult.stats || {})
      };
    }

    var b = solverPointBounds(solvedWalls);
    var center = viewCenter();
    var solvedCenterX = (b.minX + b.maxX) / 2;
    var solvedCenterY = (b.minY + b.maxY) / 2;
    var dx = center.x - solvedCenterX;
    var dy = center.y - solvedCenterY;
    var byId = new Map(solvedWalls.map(function (w) { return [w.id, w]; }));

    walls = walls.map(function (old) {
      var sw = byId.get(old.id);
      if (!sw) return old;
      return Object.assign({}, old, {
        a: { x: sw.a.x + dx, y: sw.a.y + dy },
        b: { x: sw.b.x + dx, y: sw.b.y + dy },
        lengthCm: sw.lengthCm
      });
    });

    rawStrokes = [];
    surfaceCache = null;
    openings.forEach(function (o) { recalcOpeningPosition(o); });

    var bw = Math.max(1, b.maxX - b.minX);
    var bh = Math.max(1, b.maxY - b.minY);
    viewZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min((canvas.clientWidth - 70) / bw, (canvas.clientHeight - 120) / bh)));
    viewRotation = 0;
    updateViewControls();
    refreshSurfaceCache();
    persistActive();
    updateUI();
    render();
    closeSolver();
    toast('Pianta sistemata ✓');
  }

  function faceKey(face) {
    return (face && face.wallIds ? face.wallIds.slice().sort().join('|') : '');
  }

  function openRoomPicker() {
    if (!walls.length) return toast('Prima disegna la pianta');
    roomPickMode = true;
    $('roomBtn').classList.add('active');
    toast('Tocca dentro l’ambiente');
    vibrate(12);
  }

  function handleRoomPick(p) {
    roomPickMode = false;
    $('roomBtn').classList.remove('active');
    var face = findFaceAtPoint(walls, p);
    if (!face) {
      toast('Ambiente troppo aperto o ambiguo: avvicina un po’ i muri');
      vibrate(60);
      return;
    }
    pendingRoomFace = face;
    var key = faceKey(face);
    var existing = rooms.find(function (r) { return r.faceKey === key || faceKey({ wallIds: r.wallIds }) === key; });
    pendingRoomId = existing ? existing.id : null;
    selectedRoomName = existing ? existing.name : '';
    $('roomCustomName').value = existing && existing.custom ? existing.name : '';
    document.querySelectorAll('[data-room-name]').forEach(function (b) {
      b.classList.toggle('selected', existing && existing.name === b.dataset.roomName);
    });
    $('roomBackdrop').classList.remove('hidden');
  }

  function closeRoomModal() {
    $('roomBackdrop').classList.add('hidden');
    pendingRoomFace = null;
    pendingRoomId = null;
    selectedRoomName = '';
    $('roomCustomName').value = '';
    document.querySelectorAll('[data-room-name]').forEach(function (b) { b.classList.remove('selected'); });
  }

  function selectRoomPreset(name, button) {
    selectedRoomName = name;
    document.querySelectorAll('[data-room-name]').forEach(function (b) { b.classList.toggle('selected', b === button); });
    if (name === 'Altro') {
      $('roomCustomName').focus();
    } else {
      $('roomCustomName').value = '';
    }
  }

  function saveRoom() {
    if (!pendingRoomFace) return;
    var custom = $('roomCustomName').value.trim();
    var name = custom || (selectedRoomName && selectedRoomName !== 'Altro' ? selectedRoomName : '');
    if (!name) return toast('Scegli o scrivi il nome ambiente');

    checkpoint();
    var wallIds = pendingRoomFace.wallIds.slice().sort();
    var key = wallIds.join('|');
    var room = pendingRoomId ? rooms.find(function (r) { return r.id === pendingRoomId; }) : null;
    if (!room) {
      room = { id: uid('room'), name: name, wallIds: wallIds, faceKey: key, custom: !!custom };
      rooms.push(room);
    } else {
      room.name = name;
      room.wallIds = wallIds;
      room.faceKey = key;
      room.custom = !!custom;
    }
    surfaceCache = null;
    persistActive();
    closeRoomModal();
    refreshSurfaceCache();
    render();
    toast(name + ' salvato ✓');
  }

  function parseHeightInput() {
    var n = Number(String($('wallHeightInput').value || '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function solvedPresentationWalls() {
    var missing = walls.filter(function (w) { return !Number.isFinite(w.lengthCm) || w.lengthCm <= 0; });
    if (missing.length) return { result: null, missing: missing.length, walls: [] };
    try {
      var result = solveFloorPlan(solverInput(), { mode: 'normal', maxClosureGapCm: 20 });
      var solved = (result.walls || []).filter(function (w) { return w && w.a && w.b && Number.isFinite(w.lengthCm); });
      return { result: result, missing: 0, walls: solved };
    } catch (e) {
      return { result: null, missing: 0, walls: [], error: e };
    }
  }

  function refreshSurfaceCache() {
    var solved = solvedPresentationWalls();
    if (solved.missing || !solved.walls.length) {
      surfaceCache = null;
      return null;
    }
    surfaceCache = calculateSurfaces(solved.walls, rooms, wallHeightM);
    var plan = currentPlan();
    if (plan && surfaceCache) plan.surfaceSummary = clone(surfaceCache.totals);
    return surfaceCache;
  }

  function formatM2(v) {
    return Number.isFinite(v) ? v.toFixed(1).replace('.', ',') + ' m²' : '—';
  }

  function surfaceStatus(status) {
    if (status === 'verify') return { label: 'DA VERIFICARE', cls: 'verify' };
    if (status === 'estimated') return { label: 'STIMATO', cls: 'estimated' };
    return { label: 'OK', cls: 'ok' };
  }

  function totalBox(label, value) {
    return '<div class="surface-total"><div class="k">' + label + '</div><div class="v">' + formatM2(value) + '</div></div>';
  }

  function openSurfaces() {
    if (!walls.length) return toast('Prima disegna la pianta');
    var missing = walls.filter(function (w) { return !Number.isFinite(w.lengthCm) || w.lengthCm <= 0; });
    if (missing.length) {
      toast('Mancano ' + missing.length + ' misure');
      return openNextMissing(missing[0].id);
    }
    $('wallHeightInput').value = wallHeightM.toFixed(2).replace('.', ',');
    $('surfacesBackdrop').classList.remove('hidden');
    renderSurfaceSummary();
  }

  function closeSurfaces() {
    $('surfacesBackdrop').classList.add('hidden');
  }

  function renderSurfaceSummary() {
    var cache = refreshSurfaceCache();
    var totalsEl = $('surfaceTotals');
    var roomsEl = $('surfaceRooms');
    totalsEl.innerHTML = '';
    roomsEl.innerHTML = '';

    if (!cache || !cache.faces.length) {
      totalsEl.innerHTML = '<div class="surface-total" style="grid-column:1/-1"><div class="k">SUPERFICI</div><div class="v">—</div><div style="font-size:12px;color:#64748b;margin-top:5px">Non riesco ancora a riconoscere un ambiente: avvicina un po’ i capi dei muri o aggiungi il lato mancante.</div></div>';
      return;
    }

    var totalState = surfaceStatus(cache.totals.status);
    totalsEl.innerHTML =
      '<div class="surface-status ' + totalState.cls + '" style="grid-column:1/-1"><b>' + totalState.label + '</b><span>' +
      (cache.totals.status === 'ok' ? ' Contorni riconosciuti.' : cache.totals.status === 'estimated' ? ' Piccoli gap chiusi automaticamente per la stima.' : ' Stima utilizzabile, ma controlla il disegno se ti serve maggiore precisione.') +
      '</span></div>' +
      totalBox('PAVIMENTO', cache.totals.floorM2) +
      totalBox('SOFFITTO', cache.totals.ceilingM2) +
      totalBox('PARETI LORDE', cache.totals.wallsM2) +
      totalBox('PARETI + SOFFITTO', cache.totals.wallsCeilingM2);

    if (!rooms.length) {
      roomsEl.innerHTML = '<div class="surface-room"><h3>Ambienti non nominati</h3><div style="font-size:12px;color:#64748b">Usa il pulsante AMBIENTE e tocca dentro ogni stanza per darle un nome.</div></div>';
      return;
    }

    cache.roomMetrics.forEach(function (m) {
      var card = document.createElement('div');
      card.className = 'surface-room';
      var title = document.createElement('h3');
      title.textContent = m.room.name + ' ';
      var state = surfaceStatus(m.status);
      var badge = document.createElement('span');
      badge.className = 'surface-badge ' + state.cls;
      badge.textContent = state.label;
      title.appendChild(badge);
      card.appendChild(title);
      if (Number.isFinite(m.maxGapCm) && m.maxGapCm > 0) {
        var gapInfo = document.createElement('div');
        gapInfo.className = 'surface-gap';
        gapInfo.textContent = 'Chiusura stimata: ' + m.maxGapCm.toFixed(0) + ' cm';
        card.appendChild(gapInfo);
      }
      var grid = document.createElement('div');
      grid.className = 'surface-room-grid';
      grid.innerHTML =
        '<div>Pavimento<b>' + formatM2(m.floorM2) + '</b></div>' +
        '<div>Soffitto<b>' + formatM2(m.ceilingM2) + '</b></div>' +
        '<div>Pareti lorde<b>' + formatM2(m.wallsM2) + '</b></div>' +
        '<div>Pareti + soffitto<b>' + formatM2(m.wallsCeilingM2) + '</b></div>';
      card.appendChild(grid);
      roomsEl.appendChild(card);
    });
    persistActive();
  }

  function changeWallHeight() {
    var h = parseHeightInput();
    if (!h) return;
    wallHeightM = h;
    surfaceCache = null;
    persistActive();
    renderSurfaceSummary();
    render();
  }

  function drawRoomAreas() {
    if (!rooms.length) return;
    var faces = buildFaces(walls);
    var palette = ['rgba(37,99,235,.055)','rgba(16,185,129,.055)','rgba(245,158,11,.055)','rgba(124,58,237,.05)'];
    rooms.forEach(function (room, idx) {
      var face = matchRoomFace(room, faces);
      if (!face || !face.polygon || face.polygon.length < 3) return;
      ctx.save();
      ctx.fillStyle = palette[idx % palette.length];
      ctx.beginPath();
      face.polygon.forEach(function (p, i) {
        var sp = worldToScreen(p);
        if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }

  function drawRoomLabels() {
    if (!rooms.length) return;
    var faces = buildFaces(walls);
    var byRoom = new Map();
    if (surfaceCache && surfaceCache.roomMetrics) {
      surfaceCache.roomMetrics.forEach(function (m) { byRoom.set(m.room.id, m); });
    }
    rooms.forEach(function (room) {
      var face = matchRoomFace(room, faces);
      if (!face) return;
      var p = worldToScreen(face.centroid);
      var metric = byRoom.get(room.id);
      var area = metric && Number.isFinite(metric.floorM2) ? metric.floorM2.toFixed(1).replace('.', ',') + ' m²' : '';
      var title = String(room.name || 'Ambiente').toUpperCase();
      var state = surfaceStatus(metric ? metric.status : face.quality);
      var statusText = state.label;

      ctx.save();
      ctx.font = '1000 12px system-ui';
      var w1 = ctx.measureText(title).width;
      ctx.font = '800 11px system-ui';
      var w2 = area ? ctx.measureText(area).width : 0;
      ctx.font = '900 9px system-ui';
      var w3 = ctx.measureText(statusText).width;
      var boxW = Math.max(w1, w2, w3) + 20;
      var boxH = area ? 58 : 42;
      ctx.fillStyle = 'rgba(255,255,255,.94)';
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1.5;
      roundRect(p.x - boxW / 2, p.y - boxH / 2, boxW, boxH, 11);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '1000 12px system-ui';
      ctx.fillText(title, p.x, p.y - (area ? 14 : 7));
      if (area) {
        ctx.fillStyle = '#2563eb';
        ctx.font = '800 11px system-ui';
        ctx.fillText(area, p.x, p.y + 3);
      }
      ctx.fillStyle = state.cls === 'ok' ? '#15803d' : state.cls === 'estimated' ? '#b45309' : '#b91c1c';
      ctx.font = '900 9px system-ui';
      ctx.fillText(statusText, p.x, p.y + (area ? 19 : 10));
      ctx.restore();
    });
  }

  function openSettings() {
    $('serverUrl').value = settings.serverUrl || '';
    $('apiKey').value = settings.apiKey || '';
    $('settingsBackdrop').classList.remove('hidden');
  }

  function closeSettings() {
    $('settingsBackdrop').classList.add('hidden');
  }

  function saveSettings() {
    settings.serverUrl = $('serverUrl').value.trim().replace(/\/$/, '');
    settings.apiKey = $('apiKey').value.trim();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    updateServerBadge();
    closeSettings();
    toast('Collegamento salvato ✓');
  }

  function updateServerBadge() {
    var ok = !!(settings.serverUrl && settings.apiKey);
    $('serverBadge').className = 'server-badge ' + (ok ? 'online' : 'offline');
    $('serverBadge').textContent = ok ? '● Debian configurato' : '● Debian non collegato';
  }

  async function testServer() {
    var url = $('serverUrl').value.trim().replace(/\/$/, '');
    var key = $('apiKey').value.trim();
    if (!url || !key) return toast('Inserisci URL e API Key');
    toast('Test collegamento…');
    try {
      var res = await fetch(url + '/health', { headers: { 'X-GE360-API-Key': key } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      toast('Debian raggiungibile ✓');
    } catch (e) {
      toast('Connessione fallita: ' + e.message);
    }
  }

  async function sendPlan(id) {
    var plan = library.find(function (p) { return p.id === id; });
    if (!plan) return;
    if (!settings.serverUrl || !settings.apiKey) {
      openSettings();
      return toast('Configura prima il Debian');
    }
    toast('Invio al planner…');
    try {
      var res = await fetch(settings.serverUrl + '/plans/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GE360-API-Key': settings.apiKey },
        body: JSON.stringify(planPayload(plan))
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      plan.backend = { sentAt: new Date().toISOString(), status: 'sent' };
      saveLibrary();
      renderDashboard();
      toast('Inviato al Debian ✓');
    } catch (e) {
      toast('Errore: ' + e.message);
    }
  }

  function exportJson() {
    persistActive();
    var plan = currentPlan();
    if (!plan || !plan.walls || !plan.walls.length) return toast('Prima fai uno schizzo');
    var missing = plan.walls.filter(function (w) { return !w.lengthCm; }).length;
    if (missing) {
      toast('Mancano ' + missing + ' misure');
      return openNextMissing();
    }
    var blob = new Blob([JSON.stringify(planPayload(plan), null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'GE360-' + (plan.name || 'rilievo').replace(/[^a-z0-9_-]+/gi, '-') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function clearAll() {
    if (!confirm('Cancellare tutto il disegno di questo rilievo?')) return;
    checkpoint();
    rawStrokes = [];
    walls = [];
    openings = [];
    rooms = [];
    surfaceCache = null;
    persistActive();
    updateUI();
    render();
  }

  function updateUI() {
    var has = walls.length > 0;
    $('emptyHint').classList.toggle('hidden', has || !!currentStroke);
    $('statusPill').classList.toggle('hidden', !has);
    $('clearBtn').classList.toggle('hidden', !has);
    $('solvePlanBtn').classList.toggle('hidden', !has);
    $('roomBtn').classList.toggle('hidden', !has);
    $('surfacesBtn').classList.toggle('hidden', !has);
    var missing = walls.filter(function (w) { return !w.lengthCm; }).length;
    $('statusPill').textContent = walls.length + ' muri · ' + (missing ? missing + ' da misurare' : 'misure complete ✓');
    $('measureLabel').textContent = missing ? 'MISURE ' + missing : 'MISURE ✓';
  }

  function drawPolyline(points, color, width) {
    if (!points || points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var firstScreen = worldToScreen(points[0]);
    ctx.beginPath();
    ctx.moveTo(firstScreen.x, firstScreen.y);
    for (var i = 1; i < points.length; i++) {
      var sp = worldToScreen(points[i]);
      ctx.lineTo(sp.x, sp.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawMeasure(wall) {
    var mid = worldToScreen({ x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 });
    var x = mid.x;
    var y = mid.y;
    var text = wall.lengthCm ? (wall.lengthCm / 100).toFixed(2).replace('.', ',') + ' m' : '?';
    ctx.save();
    ctx.font = '900 13px system-ui';
    var width = Math.max(42, ctx.measureText(text).width + 16);
    ctx.fillStyle = wall.lengthCm ? '#fff' : '#fef3c7';
    ctx.strokeStyle = wall.lengthCm ? '#cbd5e1' : '#f59e0b';
    ctx.lineWidth = 2;
    roundRect(x - width / 2, y - 18, width, 36, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  function drawOpening(opening) {
    var wall = walls.find(function (w) { return w.id === opening.wallId; });
    if (!wall) return;
    var wp = {
      x: wall.a.x + (wall.b.x - wall.a.x) * opening.position,
      y: wall.a.y + (wall.b.y - wall.a.y) * opening.position
    };
    var openingScreen = worldToScreen(wp);
    var x = openingScreen.x;
    var y = openingScreen.y;
    ctx.save();
    ctx.fillStyle = opening.type === 'door' ? '#22c55e' : '#06b6d4';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '900 12px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opening.type === 'door' ? 'P' : 'F', x, y + 1);
    ctx.restore();

    if (sheetType === 'opening-offset' && opening.id === currentOpeningId) {
      var cornerWorld = opening.referenceEnd === 'b' ? wall.b : wall.a;
      var corner = worldToScreen(cornerWorld);
      var sideShort = openingReferenceLabel(opening) === 'SINISTRO' ? 'SX' : 'DX';
      ctx.save();
      ctx.fillStyle = '#f59e0b';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(corner.x, corner.y, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.font = '1000 10px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(sideShort, corner.x, corner.y + 1);
      ctx.restore();
    }
  }

  function render() {
    if ($('editor').classList.contains('hidden')) return;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);

    drawRoomAreas();
    rawStrokes.forEach(function (s) { drawPolyline(s.raw, '#cbd5e1', 3); });
    walls.forEach(function (wall) {
      ctx.save();
      ctx.strokeStyle = wall.id === selectedWallId ? '#2563eb' : '#0f172a';
      ctx.lineWidth = wall.id === selectedWallId ? 10 : 8;
      ctx.lineCap = 'round';
      var sa = worldToScreen(wall.a);
      var sb = worldToScreen(wall.b);
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
      ctx.restore();
    });
    walls.forEach(drawMeasure);
    openings.forEach(drawOpening);
    drawRoomLabels();
    if (currentStroke) drawPolyline(currentStroke, '#2563eb', 7);
  }

  function resize() {
    if ($('editor').classList.contains('hidden')) return;
    var rect = canvas.getBoundingClientRect();
    dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    render();
  }

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    var p = point(e);
    if (roomPickMode) {
      handleRoomPick(p);
      return;
    }
    if (mode === 'draw') {
      activePointerId = e.pointerId;
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      currentStroke = [p];
      $('emptyHint').classList.add('hidden');
      render();
    } else {
      placeOpening(p);
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    if (mode !== 'draw' || currentStroke === null || e.pointerId !== activePointerId) return;
    e.preventDefault();
    var p = point(e);
    var last = currentStroke[currentStroke.length - 1];
    if (dist(last, p) >= 3 / viewZoom) currentStroke.push(p);
    render();
  });

  canvas.addEventListener('pointerup', function (e) {
    if (mode !== 'draw' || currentStroke === null || e.pointerId !== activePointerId) return;
    e.preventDefault();
    var p = point(e);
    if (dist(currentStroke[currentStroke.length - 1], p) > 2 / viewZoom) currentStroke.push(p);
    commitStroke();
  });

  $('newPlanBtn').addEventListener('click', newPlan);
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettingsBtn').addEventListener('click', closeSettings);
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('testServerBtn').addEventListener('click', testServer);
  $('backBtn').addEventListener('click', function () { persistActive(); showDashboard(); });
  $('drawBtn').addEventListener('click', function () { setMode('draw'); });
  $('doorBtn').addEventListener('click', function () { setMode('door'); });
  $('windowBtn').addEventListener('click', function () { setMode('window'); });
  $('measureBtn').addEventListener('click', function () { openNextMissing(); });
  $('doneBtn').addEventListener('click', exportJson);
  $('undoBtn').addEventListener('click', undo);
  $('saveBtn').addEventListener('click', function () { persistActive(true); });
  $('clearBtn').addEventListener('click', clearAll);
  $('confirmBtn').addEventListener('click', confirmSheet);
  $('laterBtn').addEventListener('click', later);
  $('cornerToggleBtn').addEventListener('click', toggleOpeningCorner);
  $('zoomOutBtn').addEventListener('click', function () { setZoom(viewZoom / 1.25); });
  $('zoomInBtn').addEventListener('click', function () { setZoom(viewZoom * 1.25); });
  $('zoomResetBtn').addEventListener('click', resetView);
  $('rotateBtn').addEventListener('click', rotateView);
  $('roomBtn').addEventListener('click', openRoomPicker);
  $('surfacesBtn').addEventListener('click', openSurfaces);
  $('solvePlanBtn').addEventListener('click', openSolver);
  $('closeSolverBtn').addEventListener('click', closeSolver);
  $('cancelSolverBtn').addEventListener('click', closeSolver);
  $('applySolverBtn').addEventListener('click', applySolverResult);
  document.querySelectorAll('[data-solver-mode]').forEach(function (b) {
    b.addEventListener('click', function () { runSolver(b.dataset.solverMode); });
  });
  $('solveBackdrop').addEventListener('click', function (e) { if (e.target === $('solveBackdrop')) closeSolver(); });
  $('closeRoomBtn').addEventListener('click', closeRoomModal);
  $('saveRoomBtn').addEventListener('click', saveRoom);
  $('roomBackdrop').addEventListener('click', function (e) { if (e.target === $('roomBackdrop')) closeRoomModal(); });
  document.querySelectorAll('[data-room-name]').forEach(function (b) {
    b.addEventListener('click', function () { selectRoomPreset(b.dataset.roomName, b); });
  });
  $('closeSurfacesBtn').addEventListener('click', closeSurfaces);
  $('surfacesBackdrop').addEventListener('click', function (e) { if (e.target === $('surfacesBackdrop')) closeSurfaces(); });
  $('wallHeightInput').addEventListener('change', changeWallHeight);
  $('planName').addEventListener('change', function () { persistActive(); });
  document.querySelectorAll('[data-key]').forEach(function (b) { b.addEventListener('click', function () { keypad(b.dataset.key); }); });
  $('sheetBackdrop').addEventListener('click', function (e) { if (e.target === $('sheetBackdrop')) later(); });
  $('settingsBackdrop').addEventListener('click', function (e) { if (e.target === $('settingsBackdrop')) closeSettings(); });
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', function () { if (document.hidden && activePlanId) persistActive(); });

  loadAll();
  showDashboard();
})();