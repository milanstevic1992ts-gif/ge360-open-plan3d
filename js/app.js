import { solveFloorPlan } from '../geometry-engine/index.js';
import { buildFaces, findFaceAtPoint, matchRoomFace, calculateSurfaces } from './room-surfaces.js';
import { straightenPolyline, snapPolylineCornersToWalls } from './sketch-snap.js';
import {
  createBackendMetadata,
  ensureBackendMetadata,
  refreshSourceRevision,
  validateForProcessing,
  buildProcessingPayload,
  applyBackendSnapshot,
  mergeVersions,
  isTerminalStatus
} from './processed-plan.js';
import { BackendClient } from './backend-client.js';
import { ProcessedPlanUI } from './processed-viewer.js';

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
  var presentationModel = null;
  var notes = [];
  var notePickMode = null;
  var pendingNoteTarget = null;
  var currentNoteId = null;
  var processedUI = null;
  var processingRunId = 0;
  var PROCESS_POLL_MS = 2000;
  var PROCESS_POLL_TIMEOUT_MS = 180000;

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
    var migrated = false;
    library.forEach(function (plan) {
      var hadBackend = !!(plan && plan.backend);
      var hadRevision = !!(plan && plan.sourceRevision);
      ensureBackendMetadata(plan);
      if (!hadBackend || !hadRevision) migrated = true;
    });
    if (migrated) saveLibrary();
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
      notes: plan ? (plan.notes || []).length : notes.length,
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
    plan.notes = clone(notes);
    plan.wallHeightM = wallHeightM;
    plan.view = { zoom: viewZoom, rotation: viewRotation };
    plan.surfaceSummary = surfaceCache && surfaceCache.totals ? clone(surfaceCache.totals) : null;
    plan.summary = summary();
    ensureBackendMetadata(plan);
    refreshSourceRevision(plan);
    saveLibrary();
    if (processedUI) processedUI.render(plan);
    if (showToast) toast('Salvato ✓');
  }

  function showDashboard() {
    closeSheet();
    closeTools();
    closeNoteEditor();
    closeNoteTargetChooser();
    $('editor').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    activePlanId = null;
    if (processedUI) processedUI.showTab('raw');
    renderDashboard();
  }

  function showEditor() {
    $('dashboard').classList.add('hidden');
    $('editor').classList.remove('hidden');
    if (processedUI) processedUI.showTab('raw');
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
      notes: [],
      wallHeightM: 2.70,
      view: { zoom: 1, rotation: 0 },
      backend: createBackendMetadata()
    };
    refreshSourceRevision(plan);
    library.unshift(plan);
    saveLibrary();
    openPlan(plan.id);
  }

  function openPlan(id) {
    var plan = library.find(function (p) { return p.id === id; });
    if (!plan) return;
    ensureBackendMetadata(plan);
    activePlanId = id;
    rawStrokes = clone(plan.rawStrokes || []);
    walls = clone(plan.walls || []);
    openings = clone(plan.openings || []);
    rooms = clone(plan.rooms || []);
    notes = clone(plan.notes || []);
    notePickMode = null;
    pendingNoteTarget = null;
    currentNoteId = null;
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
    refreshSourceRevision(plan);
    saveLibrary();
    if (processedUI) processedUI.render(plan);
    render();
    if (['UPLOADING', 'RAW', 'QUEUED', 'PROCESSING'].indexOf(plan.backend.status) !== -1 && settings.serverUrl && settings.apiKey) {
      setTimeout(function () { resumeProcessing(plan); }, 0);
    }
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
      meta.textContent = s.walls + ' muri · ' + (s.rooms ? s.rooms + ' ambienti · ' : '') + (s.notes ? s.notes + ' appunti · ' : '') + (Number.isFinite(s.floorM2) ? s.floorM2.toFixed(1).replace('.', ',') + ' m² · ' : '') + (s.missing ? s.missing + ' misure mancanti' : 'misure complete') + ' · ' + date;

      var actions = document.createElement('div');
      actions.className = 'plan-actions';
      actions.appendChild(makeButton('APRI', 'open-plan', function () { openPlan(plan.id); }));
      actions.appendChild(makeButton('ELABORA', 'send-plan', function () {
        openPlan(plan.id);
        if (processedUI) processedUI.showTab('processed');
        startProcessing(false);
      }));
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
    history.push(JSON.stringify({ rawStrokes: rawStrokes, walls: walls, openings: openings, rooms: rooms, notes: notes, wallHeightM: wallHeightM }));
    if (history.length > 30) history.shift();
  }

  function undo() {
    if (!history.length) return toast('Niente da annullare');
    var data = JSON.parse(history.pop());
    rawStrokes = data.rawStrokes || [];
    walls = data.walls || [];
    openings = data.openings || [];
    rooms = data.rooms || [];
    notes = data.notes || [];
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

    var simp = straightenPolyline(simplify(points), {
      axisToleranceDeg: 25,
      minSegment: 1 / viewZoom
    });
    if (simp.length < 2) return;

    var cornerSnap = snapPolylineCornersToWalls(simp, walls, {
      threshold: 46 / viewZoom,
      axisToleranceDeg: 25
    });
    simp = cornerSnap.points;

    checkpoint();

    cornerSnap.wallUpdates.forEach(function (update) {
      var original = update.originalPoint;
      walls.forEach(function (wall) {
        ['a', 'b'].forEach(function (end) {
          var p = wall[end];
          if (!p || dist(p, original) > 3 / viewZoom) return;
          wall[end] = { x: update.point.x, y: update.point.y };
        });
      });
    });

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

  function openingWorldPoint(opening, wallOverride) {
    var wall = wallOverride || walls.find(function (w) { return w.id === opening.wallId; });
    if (!wall) return null;
    var t = Number.isFinite(opening.position) ? opening.position : 0.5;
    if (Number.isFinite(opening.offsetCm) && Number.isFinite(opening.widthCm) && Number.isFinite(wall.lengthCm) && wall.lengthCm > 0) {
      var centerCm = opening.referenceEnd === 'b'
        ? wall.lengthCm - opening.offsetCm - opening.widthCm / 2
        : opening.offsetCm + opening.widthCm / 2;
      t = centerCm / wall.lengthCm;
    }
    t = Math.max(0, Math.min(1, t));
    return {
      x: wall.a.x + (wall.b.x - wall.a.x) * t,
      y: wall.a.y + (wall.b.y - wall.a.y) * t
    };
  }

  function nearestOpening(p) {
    var best = null;
    openings.forEach(function (opening) {
      var q = openingWorldPoint(opening);
      if (!q) return;
      var d = dist(p, q);
      if (d <= 34 / viewZoom && (!best || d < best.distance)) best = { opening: opening, distance: d };
    });
    return best;
  }

  function editWallMeasurement(wall) {
    if (!wall) return;
    selectedWallId = wall.id;
    numberText = Number.isFinite(wall.lengthCm) && wall.lengthCm > 0
      ? (wall.lengthCm / 100).toFixed(2).replace('.', ',')
      : '';
    openSheet('wall');
    render();
    vibrate(14);
  }

  function editOpening(opening) {
    if (!opening) return;
    currentOpeningId = opening.id;
    numberText = Number.isFinite(opening.widthCm) ? (opening.widthCm / 100).toFixed(2).replace('.', ',') : '';
    openSheet('opening-width');
    render();
    vibrate(14);
  }

  function deleteCurrentOpening() {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening) return;
    var label = opening.type === 'door' ? 'porta' : 'finestra';
    if (!confirm('Eliminare questa ' + label + '?')) return;
    checkpoint();
    openings = openings.filter(function (o) { return o.id !== opening.id; });
    notes = notes.filter(function (n) {
      return !(n.targetType === 'opening' && n.targetId === opening.id);
    });
    currentOpeningId = null;
    surfaceCache = null;
    persistActive();
    closeSheet();
    updateUI();
    render();
    toast((label === 'porta' ? 'Porta' : 'Finestra') + ' eliminata');
  }

  function startMeasureMode() {
    var missing = walls.filter(function (w) { return !w.lengthCm; });
    if (missing.length) return openNextMissing(missing[0].id);
    setMode('measure');
  }

  function cancelPickModes() {
    notePickMode = null;
    roomPickMode = false;
    $('notesBtn').classList.remove('active');
    $('roomBtn').classList.remove('active');
  }

  function noteTargetKey(type, id) {
    return String(type) + ':' + String(id || '');
  }

  function faceRoom(face) {
    if (!face) return null;
    var key = faceKey(face);
    return rooms.find(function (r) {
      return r.faceKey === key || faceKey({ wallIds: r.wallIds }) === key;
    }) || null;
  }

  function roomForWall(wallId) {
    return rooms.find(function (r) {
      return Array.isArray(r.wallIds) && r.wallIds.indexOf(wallId) !== -1;
    }) || null;
  }

  function openNoteTargetChooser() {
    if (!walls.length) return toast('Prima disegna la pianta');
    cancelPickModes();
    $('noteTargetBackdrop').classList.remove('hidden');
  }

  function closeNoteTargetChooser() {
    $('noteTargetBackdrop').classList.add('hidden');
  }

  function startNotePick(type) {
    cancelPickModes();
    notePickMode = type;
    closeNoteTargetChooser();
    $('notesBtn').classList.add('active');
    var label = type === 'wall' ? 'un muro'
      : type === 'opening' ? 'una porta o finestra'
      : type === 'floor' ? 'dentro il pavimento dell’ambiente'
      : type === 'ceiling' ? 'dentro l’ambiente del soffitto'
      : 'dentro l’ambiente';
    toast('Tocca ' + label);
  }

  function buildRoomTarget(type, face) {
    var room = faceRoom(face);
    var name = room ? room.name : 'Ambiente non nominato';
    var id = room ? room.id : faceKey(face);
    var cache = surfaceCache || refreshSurfaceCache();
    var metric = null;
    if (room && cache && cache.roomMetrics) {
      metric = cache.roomMetrics.find(function (m) { return m.room.id === room.id; }) || null;
    }
    var prefix = type === 'floor' ? 'Pavimento' : type === 'ceiling' ? 'Soffitto' : 'Ambiente';
    return {
      type: type,
      id: id,
      label: prefix + ' · ' + name,
      roomName: name,
      context: {
        areaM2: metric && Number.isFinite(metric.floorM2) ? Number(metric.floorM2.toFixed(2)) : null,
        ceilingM2: metric && Number.isFinite(metric.ceilingM2) ? Number(metric.ceilingM2.toFixed(2)) : null,
        wallHeightM: wallHeightM
      }
    };
  }

  function handleNotePick(p) {
    var type = notePickMode;
    if (!type) return false;

    var target = null;

    if (type === 'wall') {
      var wh = nearestWall(p);
      if (!wh) {
        toast('Tocca più vicino a un muro');
        return true;
      }
      var wall = wh.wall;
      var room = roomForWall(wall.id);
      var idx = walls.findIndex(function (w) { return w.id === wall.id; });
      target = {
        type: 'wall',
        id: wall.id,
        label: 'Muro ' + (idx + 1) + (room ? ' · ' + room.name : ''),
        roomName: room ? room.name : null,
        context: {
          lengthM: Number.isFinite(wall.lengthCm) ? wall.lengthCm / 100 : null,
          wallHeightM: wallHeightM,
          grossAreaM2: Number.isFinite(wall.lengthCm) ? Number(((wall.lengthCm / 100) * wallHeightM).toFixed(2)) : null
        }
      };
    } else if (type === 'opening') {
      var oh = nearestOpening(p);
      if (!oh) {
        toast('Tocca più vicino a una porta o finestra');
        return true;
      }
      var opening = oh.opening;
      var oroom = roomForWall(opening.wallId);
      target = {
        type: 'opening',
        id: opening.id,
        label: (opening.type === 'door' ? 'Porta' : 'Finestra') + (oroom ? ' · ' + oroom.name : ''),
        roomName: oroom ? oroom.name : null,
        context: {
          openingType: opening.type,
          widthM: Number.isFinite(opening.widthCm) ? opening.widthCm / 100 : null,
          offsetM: Number.isFinite(opening.offsetCm) ? opening.offsetCm / 100 : null,
          referenceEnd: opening.referenceEnd || null
        }
      };
    } else {
      var face = findFaceAtPoint(walls, p);
      if (!face) {
        toast('Non riconosco un ambiente qui');
        return true;
      }
      target = buildRoomTarget(type, face);
    }

    notePickMode = null;
    $('notesBtn').classList.remove('active');
    openNoteEditor(target);
    return true;
  }

  function existingNoteForTarget(target) {
    var key = noteTargetKey(target.type, target.id);
    return notes.find(function (n) { return n.targetKey === key; }) || null;
  }

  function renderNoteAi(note) {
    var box = $('noteAiResult');
    var cleaned = note && note.cleanedText ? String(note.cleanedText) : '';
    var tasks = note && Array.isArray(note.tasks) ? note.tasks : [];
    var clarifications = note && Array.isArray(note.needsClarification) ? note.needsClarification : [];

    if (!cleaned && !tasks.length && !clarifications.length) {
      box.classList.add('hidden');
      $('noteCleanedText').textContent = '';
      $('noteTasks').innerHTML = '';
      $('noteClarifications').innerHTML = '';
      return;
    }

    box.classList.remove('hidden');
    $('noteCleanedText').textContent = cleaned;

    var tasksEl = $('noteTasks');
    tasksEl.innerHTML = '';
    tasks.forEach(function (task) {
      var el = document.createElement('div');
      el.className = 'note-task';
      el.textContent = task;
      tasksEl.appendChild(el);
    });

    var clarEl = $('noteClarifications');
    clarEl.innerHTML = '';
    clarifications.forEach(function (item) {
      var el = document.createElement('div');
      el.className = 'note-clarification';
      el.textContent = item;
      clarEl.appendChild(el);
    });
  }

  function openNoteEditor(target) {
    pendingNoteTarget = target;
    var existing = existingNoteForTarget(target);
    currentNoteId = existing ? existing.id : null;
    $('noteTargetTitle').textContent = target.label;
    $('noteTargetMeta').textContent = target.roomName ? 'Ambiente: ' + target.roomName : '';
    $('noteRawText').value = existing ? existing.rawText || '' : '';
    $('deleteNoteBtn').classList.toggle('hidden', !existing);
    renderNoteAi(existing);
    $('noteEditorBackdrop').classList.remove('hidden');
    requestAnimationFrame(function () { $('noteRawText').focus(); });
  }

  function closeNoteEditor(saveDraft) {
    if (saveDraft !== false && pendingNoteTarget) {
      var raw = $('noteRawText').value.trim();
      if (raw) saveCurrentNote(true);
    }
    $('noteEditorBackdrop').classList.add('hidden');
    pendingNoteTarget = null;
    currentNoteId = null;
  }

  function saveCurrentNote(silent) {
    if (!pendingNoteTarget) return null;
    var raw = $('noteRawText').value.trim();
    if (!raw) {
      if (!silent) toast('Scrivi prima un appunto');
      return null;
    }

    var existing = currentNoteId ? notes.find(function (n) { return n.id === currentNoteId; }) : existingNoteForTarget(pendingNoteTarget);
    if (!existing) {
      checkpoint();
      existing = {
        id: uid('note'),
        targetKey: noteTargetKey(pendingNoteTarget.type, pendingNoteTarget.id),
        targetType: pendingNoteTarget.type,
        targetId: pendingNoteTarget.id,
        targetLabel: pendingNoteTarget.label,
        roomName: pendingNoteTarget.roomName || null,
        context: clone(pendingNoteTarget.context || {}),
        rawText: raw,
        cleanedText: '',
        tasks: [],
        needsClarification: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      notes.push(existing);
      currentNoteId = existing.id;
    } else {
      checkpoint();
      if (existing.rawText !== raw) {
        existing.cleanedText = '';
        existing.tasks = [];
        existing.needsClarification = [];
        existing.model = null;
        existing.rewrittenAt = null;
      }
      existing.rawText = raw;
      existing.targetLabel = pendingNoteTarget.label;
      existing.roomName = pendingNoteTarget.roomName || null;
      existing.context = clone(pendingNoteTarget.context || {});
      existing.updatedAt = new Date().toISOString();
    }

    persistActive();
    updateUI();
    $('deleteNoteBtn').classList.remove('hidden');
    renderNoteAi(existing);
    if (!silent) toast('Appunto salvato ✓');
    return existing;
  }

  async function rewriteCurrentNote() {
    var note = saveCurrentNote(true);
    if (!note) return toast('Scrivi prima un appunto');
    if (!settings.serverUrl || !settings.apiKey) {
      toast('Configura prima il Debian');
      openSettings();
      return;
    }

    var btn = $('rewriteNoteBtn');
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'IA IN LAVORAZIONE…';

    try {
      var plan = currentPlan();
      var res = await fetch(settings.serverUrl + '/notes/rewrite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GE360-API-Key': settings.apiKey
        },
        body: JSON.stringify({
          rawText: note.rawText,
          planId: activePlanId,
          planName: plan ? plan.name : null,
          targetType: note.targetType,
          targetId: note.targetId,
          targetLabel: note.targetLabel,
          roomName: note.roomName,
          context: note.context || {}
        })
      });

      if (!res.ok) {
        var detail = '';
        try {
          var err = await res.json();
          detail = err.detail || '';
        } catch (_) {}
        throw new Error(detail || ('HTTP ' + res.status));
      }

      var data = await res.json();
      note.cleanedText = data.cleanedText || note.rawText;
      note.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      note.needsClarification = Array.isArray(data.needsClarification) ? data.needsClarification : [];
      note.model = data.model || null;
      note.rewrittenAt = new Date().toISOString();
      note.updatedAt = note.rewrittenAt;
      persistActive();
      renderNoteAi(note);
      toast('Appunto sistemato ✓');
    } catch (e) {
      toast('IA non disponibile: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function deleteCurrentNote() {
    var note = currentNoteId ? notes.find(function (n) { return n.id === currentNoteId; }) : null;
    if (!note) return;
    if (!confirm('Eliminare questo appunto?')) return;
    checkpoint();
    notes = notes.filter(function (n) { return n.id !== note.id; });
    persistActive();
    updateUI();
    closeNoteEditor(false);
    toast('Appunto eliminato');
  }

  function setMode(next, announce) {
    cancelPickModes();
    mode = next;
    [['drawBtn', 'draw'], ['doorBtn', 'door'], ['windowBtn', 'window'], ['measureBtn', 'measure']].forEach(function (pair) {
      $(pair[0]).classList.toggle('active', pair[1] === mode);
    });
    if (announce !== false) {
      var msg = next === 'draw'
        ? 'Disegna col dito'
        : next === 'door'
          ? 'Tocca un muro o una porta esistente'
          : next === 'window'
            ? 'Tocca un muro o una finestra esistente'
            : 'Tocca il muro da modificare';
      toast(msg);
    }
  }

  function placeOpening(p) {
    var existing = nearestOpening(p);
    if (existing) return editOpening(existing.opening);
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
    $('deleteOpeningBtn').classList.toggle('hidden', type === 'wall');
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
    $('deleteOpeningBtn').classList.add('hidden');
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
      if (wall) {
        wall.lengthCm = Math.round(meters * 100);
        openings.filter(function (o) { return o.wallId === wall.id; }).forEach(function (o) {
          recalcOpeningPosition(o);
        });
      }
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
      numberText = op && Number.isFinite(op.offsetCm) ? (op.offsetCm / 100).toFixed(2).replace('.', ',') : '';
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
    var payload = buildProcessingPayload(plan);
    payload.summary = summary(plan);
    return payload;
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
    cancelPickModes();
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
    cancelPickModes();
    roomPickMode = true;
    $('roomBtn').classList.add('active');
    toast('Tocca dentro l’ambiente');
    vibrate(12);
  }

  function handleRoomPick(p) {
    var face = findFaceAtPoint(walls, p);
    if (!face) {
      toast('Ambiente troppo aperto o ambiguo: prova un altro punto');
      vibrate(60);
      return;
    }
    roomPickMode = false;
    $('roomBtn').classList.remove('active');
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
    notes.forEach(function (note) {
      if (['room', 'floor', 'ceiling'].indexOf(note.targetType) !== -1) {
        if (note.targetId !== key && note.targetId !== room.id) return;
        var prefix = note.targetType === 'floor' ? 'Pavimento' : note.targetType === 'ceiling' ? 'Soffitto' : 'Ambiente';
        note.targetId = room.id;
        note.targetKey = noteTargetKey(note.targetType, room.id);
        note.roomName = room.name;
        note.targetLabel = prefix + ' · ' + room.name;
        note.updatedAt = new Date().toISOString();
        return;
      }

      if (note.targetType === 'wall' && wallIds.indexOf(note.targetId) !== -1) {
        var wi = walls.findIndex(function (w) { return w.id === note.targetId; });
        note.roomName = room.name;
        note.targetLabel = 'Muro ' + (wi + 1) + ' · ' + room.name;
        note.updatedAt = new Date().toISOString();
        return;
      }

      if (note.targetType === 'opening') {
        var linkedOpening = openings.find(function (o) { return o.id === note.targetId; });
        if (!linkedOpening || wallIds.indexOf(linkedOpening.wallId) === -1) return;
        note.roomName = room.name;
        note.targetLabel = (linkedOpening.type === 'door' ? 'Porta' : 'Finestra') + ' · ' + room.name;
        note.updatedAt = new Date().toISOString();
      }
    });
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
    cancelPickModes();
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

  function presentationCard(label, value) {
    return '<div class="ps-card"><div class="ps-k">' + label + '</div><div class="ps-v">' + formatM2(value) + '</div></div>';
  }

  function openPresentation() {
    cancelPickModes();
    if (!walls.length) return toast('Prima disegna la pianta');
    var missing = walls.filter(function (w) { return !Number.isFinite(w.lengthCm) || w.lengthCm <= 0; });
    if (missing.length) {
      toast('Mancano ' + missing.length + ' misure');
      return openNextMissing(missing[0].id);
    }

    var solved = solvedPresentationWalls();
    var cleanWalls = solved.walls && solved.walls.length ? solved.walls : clone(walls);
    var cache = calculateSurfaces(cleanWalls, rooms, wallHeightM);
    presentationModel = {
      walls: cleanWalls,
      openings: clone(openings),
      rooms: clone(rooms),
      surfaces: cache
    };

    var plan = currentPlan();
    $('presentationTitle').textContent = plan && plan.name ? plan.name : 'Planimetria';
    var hasFaces = !!(cache.faces && cache.faces.length);
    var state = hasFaces ? surfaceStatus(cache.totals.status) : { label: 'DA VERIFICARE', cls: 'verify' };
    var displayTotals = hasFaces ? cache.totals : {
      floorM2: null,
      ceilingM2: null,
      wallsM2: null,
      wallsCeilingM2: null
    };
    $('presentationStamp').textContent = 'Rilievo indicativo · h ' + wallHeightM.toFixed(2).replace('.', ',') + ' m · ' + state.label;
    $('presentationSummary').innerHTML =
      presentationCard('PAVIMENTO', displayTotals.floorM2) +
      presentationCard('SOFFITTO', displayTotals.ceilingM2) +
      presentationCard('PARETI LORDE', displayTotals.wallsM2) +
      presentationCard('PARETI + SOFFITTO', displayTotals.wallsCeilingM2);

    var roomWrap = $('presentationRooms');
    roomWrap.innerHTML = '';
    cache.roomMetrics.forEach(function (m) {
      var chip = document.createElement('div');
      var st = surfaceStatus(m.status);
      chip.className = 'presentation-room-chip ' + (st.cls === 'ok' ? '' : st.cls);
      chip.textContent = m.room.name + ' · ' + formatM2(m.floorM2) + (st.cls === 'ok' ? '' : ' · ' + st.label);
      roomWrap.appendChild(chip);
    });

    $('presentationBackdrop').classList.remove('hidden');
    requestAnimationFrame(renderPresentation);
  }

  function closePresentation() {
    $('presentationBackdrop').classList.add('hidden');
    presentationModel = null;
  }

  function renderPresentation() {
    if (!presentationModel || $('presentationBackdrop').classList.contains('hidden')) return;
    var pc = $('presentationCanvas');
    var rect = pc.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var ratio = Math.min(3, window.devicePixelRatio || 1);
    pc.width = Math.round(rect.width * ratio);
    pc.height = Math.round(rect.height * ratio);
    var pctx = pc.getContext('2d');
    pctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    pctx.clearRect(0, 0, rect.width, rect.height);
    pctx.fillStyle = '#ffffff';
    pctx.fillRect(0, 0, rect.width, rect.height);

    var pwalls = presentationModel.walls.filter(function (w) { return w && w.a && w.b; });
    var bounds = solverPointBounds(pwalls);
    if (!bounds) return;
    var bw = Math.max(1, bounds.maxX - bounds.minX);
    var bh = Math.max(1, bounds.maxY - bounds.minY);
    var scale = Math.min((rect.width - 54) / bw, (rect.height - 68) / bh);
    var ox = (rect.width - bw * scale) / 2 - bounds.minX * scale;
    var oy = (rect.height - bh * scale) / 2 - bounds.minY * scale;

    function tp(p) { return { x: p.x * scale + ox, y: p.y * scale + oy }; }

    var faces = presentationModel.surfaces.faces || [];
    presentationModel.rooms.forEach(function (room, idx) {
      var face = matchRoomFace(room, faces);
      if (!face) return;
      pctx.fillStyle = idx % 2 ? 'rgba(14,165,233,.055)' : 'rgba(37,99,235,.045)';
      pctx.beginPath();
      face.polygon.forEach(function (p, i) {
        var sp = tp(p);
        if (i === 0) pctx.moveTo(sp.x, sp.y); else pctx.lineTo(sp.x, sp.y);
      });
      pctx.closePath();
      pctx.fill();
    });

    pctx.lineCap = 'round';
    pctx.lineJoin = 'round';
    pwalls.forEach(function (wall) {
      var a = tp(wall.a), b = tp(wall.b);
      pctx.strokeStyle = '#0f172a';
      pctx.lineWidth = 6;
      pctx.beginPath();
      pctx.moveTo(a.x, a.y);
      pctx.lineTo(b.x, b.y);
      pctx.stroke();

      if (Number.isFinite(wall.lengthCm)) {
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        var label = (wall.lengthCm / 100).toFixed(2).replace('.', ',') + ' m';
        pctx.font = '900 10px system-ui';
        var tw = pctx.measureText(label).width + 10;
        pctx.fillStyle = 'rgba(255,255,255,.96)';
        pctx.fillRect(mx - tw / 2, my - 8, tw, 16);
        pctx.fillStyle = '#475569';
        pctx.textAlign = 'center';
        pctx.textBaseline = 'middle';
        pctx.fillText(label, mx, my);
      }
    });

    presentationModel.openings.forEach(function (opening) {
      var wall = pwalls.find(function (w) { return w.id === opening.wallId; });
      if (!wall) return;
      var q = openingWorldPoint(opening, wall);
      if (!q) return;
      var p = tp(q);
      pctx.fillStyle = opening.type === 'door' ? '#16a34a' : '#0891b2';
      pctx.strokeStyle = '#ffffff';
      pctx.lineWidth = 3;
      pctx.beginPath();
      pctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      pctx.fill();
      pctx.stroke();
      pctx.fillStyle = '#ffffff';
      pctx.font = '900 8px system-ui';
      pctx.textAlign = 'center';
      pctx.textBaseline = 'middle';
      pctx.fillText(opening.type === 'door' ? 'P' : 'F', p.x, p.y + .5);
    });

    var metricByRoom = new Map();
    (presentationModel.surfaces.roomMetrics || []).forEach(function (m) { metricByRoom.set(m.room.id, m); });
    presentationModel.rooms.forEach(function (room) {
      var face = matchRoomFace(room, faces);
      if (!face) return;
      var p = tp(face.centroid);
      var metric = metricByRoom.get(room.id);
      var area = metric && Number.isFinite(metric.floorM2) ? metric.floorM2.toFixed(1).replace('.', ',') + ' m²' : '';
      var title = String(room.name || 'Ambiente').toUpperCase();
      pctx.textAlign = 'center';
      pctx.textBaseline = 'middle';
      pctx.fillStyle = '#0f172a';
      pctx.font = '1000 12px system-ui';
      pctx.fillText(title, p.x, p.y - 7);
      if (area) {
        pctx.fillStyle = '#2563eb';
        pctx.font = '900 11px system-ui';
        pctx.fillText(area, p.x, p.y + 9);
      }
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

  function backendClient(custom) {
    return new BackendClient(Object.assign({
      baseUrl: settings.serverUrl,
      apiKey: settings.apiKey,
      timeoutMs: 15000
    }, custom || {}));
  }

  async function testServer() {
    var url = $('serverUrl').value.trim().replace(/\/$/, '');
    var key = $('apiKey').value.trim();
    if (!url || !key) return toast('Inserisci URL e API Key');
    toast('Test collegamento…');
    try {
      await new BackendClient({ baseUrl: url, apiKey: key, timeoutMs: 10000 }).health();
      toast('Backend rilievi raggiungibile ✓');
    } catch (e) {
      toast('Connessione fallita: ' + e.message);
    }
  }

  function setProcessingState(plan, status, error) {
    ensureBackendMetadata(plan);
    plan.backend.status = status;
    plan.backend.error = error || null;
    saveLibrary();
    if (processedUI) processedUI.render(plan);
    renderDashboard();
  }

  function showMissingMeasures(plan, validation) {
    var count = validation.missingWallIds.length;
    $('missingMeasuresText').textContent = count === 1
      ? 'Manca la misura reale di 1 muro. Il backend non riceverà una lunghezza inventata.'
      : 'Mancano le misure reali di ' + count + ' muri. Il backend non riceverà lunghezze inventate.';
    $('missingMeasuresBackdrop').classList.remove('hidden');
  }

  function validateBeforeProcessing(plan) {
    var validation = validateForProcessing(plan);
    if (!validation.hasWalls) {
      toast('Prima disegna la planimetria');
      return false;
    }
    if (validation.missingWallIds.length) {
      showMissingMeasures(plan, validation);
      return false;
    }
    if (validation.invalidOpeningIds.length) {
      toast('Completa prima le misure di porte e finestre');
      return false;
    }
    return true;
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function finalizeProcessing(plan, client, runId) {
    if (runId !== processingRunId) return;
    try {
      var processed = await client.getProcessedPlan(plan.backend.remotePlanId);
      applyBackendSnapshot(plan, processed || {});
    } catch (e) {
      // Il risultato può essere già incluso nello status. Non distruggiamo dati validi.
      if (!plan.backend.files.svg && !plan.backend.files.png && !plan.backend.files.pdf && !plan.backend.files.plan3d && !plan.backend.files.glb) {
        plan.backend.warnings = (plan.backend.warnings || []).concat(['Endpoint processed non disponibile: ' + e.message]);
      }
    }

    try {
      var versions = await client.getVersions(plan.backend.remotePlanId);
      mergeVersions(plan, versions);
    } catch (_) {
      // Versioning opzionale finché il backend non lo espone.
    }

    if (plan.backend.status !== 'NEEDS_REVIEW' && plan.backend.status !== 'ERROR') plan.backend.status = 'PROCESSED';
    if (plan.backend.status === 'PROCESSED' || plan.backend.status === 'NEEDS_REVIEW') {
      plan.backend.sourceRevision = plan.sourceRevision;
      plan.backend.lastProcessedAt = plan.backend.lastProcessedAt || new Date().toISOString();
    }
    saveLibrary();
    if (processedUI) processedUI.render(plan);
    renderDashboard();
  }

  async function pollProcessing(plan, client, runId) {
    var startedAt = Date.now();
    while (runId === processingRunId && Date.now() - startedAt < PROCESS_POLL_TIMEOUT_MS) {
      await wait(PROCESS_POLL_MS);
      if (runId !== processingRunId) return;
      var snapshot = await client.getPlanStatus(plan.backend.remotePlanId);
      applyBackendSnapshot(plan, snapshot || {});
      saveLibrary();
      if (processedUI) processedUI.render(plan);
      if (isTerminalStatus(plan.backend.status)) {
        await finalizeProcessing(plan, client, runId);
        return;
      }
    }
    if (runId === processingRunId) {
      toast('Elaborazione ancora in corso. Lo stato resta salvato.');
    }
  }

  async function resumeProcessing(plan) {
    if (!plan || !plan.backend || !plan.backend.remotePlanId) return;
    if (!['UPLOADING', 'RAW', 'QUEUED', 'PROCESSING'].includes(plan.backend.status)) return;
    var runId = ++processingRunId;
    var client = backendClient();
    try {
      var snapshot = await client.getPlanStatus(plan.backend.remotePlanId);
      applyBackendSnapshot(plan, snapshot || {});
      saveLibrary();
      if (processedUI) processedUI.render(plan);
      if (isTerminalStatus(plan.backend.status)) await finalizeProcessing(plan, client, runId);
      else await pollProcessing(plan, client, runId);
    } catch (e) {
      setProcessingState(plan, 'ERROR', e.message || 'Backend non raggiungibile');
    }
  }

  async function startProcessing(reprocess) {
    persistActive();
    var plan = currentPlan();
    if (!plan) return;
    ensureBackendMetadata(plan);

    if (['UPLOADING', 'RAW', 'QUEUED', 'PROCESSING'].includes(plan.backend.status)) {
      if (processedUI) processedUI.showTab('processed');
      return toast('ELABORAZIONE IN CORSO');
    }
    if (!validateBeforeProcessing(plan)) return;
    if (!settings.serverUrl || !settings.apiKey) {
      openSettings();
      return toast('CONFIGURA BACKEND RILIEVI');
    }

    var runId = ++processingRunId;
    var client = backendClient();
    var payload = planPayload(plan);
    setProcessingState(plan, 'UPLOADING');
    if (processedUI) processedUI.showTab('processed');

    try {
      var started;
      if (reprocess && plan.backend.remotePlanId) {
        started = await client.reprocessPlan(plan.backend.remotePlanId, payload);
        applyBackendSnapshot(plan, started || {});
      } else {
        var created = await client.createPlan(payload);
        applyBackendSnapshot(plan, created || {});
        if (!plan.backend.remotePlanId) throw new Error('Il backend non ha restituito remotePlanId');
        started = await client.processPlan(plan.backend.remotePlanId, { sourceRevision: plan.sourceRevision });
        applyBackendSnapshot(plan, started || {});
      }

      if (!plan.backend.remotePlanId) throw new Error('remotePlanId mancante');
      if (!isTerminalStatus(plan.backend.status) && plan.backend.status !== 'PROCESSING') {
        plan.backend.status = plan.backend.status === 'RAW' ? 'QUEUED' : 'PROCESSING';
      }
      saveLibrary();
      if (processedUI) processedUI.render(plan);

      if (isTerminalStatus(plan.backend.status)) await finalizeProcessing(plan, client, runId);
      else await pollProcessing(plan, client, runId);
    } catch (e) {
      if (runId !== processingRunId) return;
      setProcessingState(plan, 'ERROR', e.message || 'Backend non raggiungibile');
      if (processedUI) processedUI.showTab('processed');
      toast('BACKEND NON RAGGIUNGIBILE · rilievo salvato');
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

  function openTools() {
    if (!walls.length) return toast('Prima disegna la pianta');
    cancelPickModes();
    $('toolsBackdrop').classList.remove('hidden');
  }

  function closeTools() {
    $('toolsBackdrop').classList.add('hidden');
  }

  function runTool(action) {
    closeTools();
    action();
  }

  function clearAll() {
    if (!confirm('Cancellare tutto il disegno di questo rilievo?')) return;
    checkpoint();
    rawStrokes = [];
    walls = [];
    openings = [];
    rooms = [];
    notes = [];
    notePickMode = null;
    pendingNoteTarget = null;
    currentNoteId = null;
    surfaceCache = null;
    persistActive();
    updateUI();
    render();
  }

  function updateUI() {
    var has = walls.length > 0;
    $('emptyHint').classList.toggle('hidden', has || !!currentStroke);
    $('statusPill').classList.toggle('hidden', !has);
    $('toolsBtn').classList.toggle('hidden', !has);
    $('clearBtn').classList.toggle('hidden', !has);
    $('solvePlanBtn').classList.toggle('hidden', !has);
    $('elaborateBtn').classList.toggle('hidden', !has);
    $('roomBtn').classList.toggle('hidden', !has);
    $('surfacesBtn').classList.toggle('hidden', !has);
    $('presentBtn').classList.toggle('hidden', !has);
    $('notesBtn').classList.toggle('hidden', !has);
    var notesTitle = $('notesBtn').querySelector('b');
    if (notesTitle) notesTitle.textContent = 'APPUNTI' + (notes.length ? ' · ' + notes.length : '');
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

  function noteAnchor(note) {
    if (!note) return null;

    if (note.targetType === 'wall') {
      var wall = walls.find(function (w) { return w.id === note.targetId; });
      if (!wall) return null;
      return { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 };
    }

    if (note.targetType === 'opening') {
      var opening = openings.find(function (o) { return o.id === note.targetId; });
      return opening ? openingWorldPoint(opening) : null;
    }

    var faces = buildFaces(walls);
    var room = rooms.find(function (r) { return r.id === note.targetId; });
    var face = room
      ? matchRoomFace(room, faces)
      : faces.find(function (f) { return faceKey(f) === note.targetId; });
    return face ? face.centroid : null;
  }

  function drawNoteMarkers() {
    notes.forEach(function (note) {
      var anchor = noteAnchor(note);
      if (!anchor) return;
      var p = worldToScreen(anchor);
      var oy = note.targetType === 'floor' ? 24 : note.targetType === 'ceiling' ? -24 : 0;
      var ox = note.targetType === 'room' ? 26 : note.targetType === 'wall' ? 18 : 0;
      p.x += ox;
      p.y += oy;

      ctx.save();
      ctx.fillStyle = '#f59e0b';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = '1000 8px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', p.x, p.y + .5);
      ctx.restore();
    });
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
    drawNoteMarkers();
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
    if (e.isPrimary === false) return;
    e.preventDefault();
    var p = point(e);
    if (roomPickMode) {
      handleRoomPick(p);
      return;
    }
    if (notePickMode) {
      handleNotePick(p);
      return;
    }
    if (mode === 'draw') {
      activePointerId = e.pointerId;
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      currentStroke = [p];
      $('emptyHint').classList.add('hidden');
      render();
    } else if (mode === 'measure') {
      var hitWall = nearestWall(p);
      if (!hitWall) return toast('Tocca più vicino a un muro');
      editWallMeasurement(hitWall.wall);
    } else {
      placeOpening(p);
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    if (e.isPrimary === false) return;
    if (mode !== 'draw' || currentStroke === null || e.pointerId !== activePointerId) return;
    e.preventDefault();
    var p = point(e);
    var last = currentStroke[currentStroke.length - 1];
    if (dist(last, p) >= 3 / viewZoom) currentStroke.push(p);
    render();
  });

  canvas.addEventListener('pointerup', function (e) {
    if (e.isPrimary === false) return;
    if (mode !== 'draw' || currentStroke === null || e.pointerId !== activePointerId) return;
    e.preventDefault();
    var p = point(e);
    if (dist(currentStroke[currentStroke.length - 1], p) > 2 / viewZoom) currentStroke.push(p);
    commitStroke();
  });

  canvas.addEventListener('pointercancel', function (e) {
    if (e.pointerId !== activePointerId) return;
    currentStroke = null;
    activePointerId = null;
    updateUI();
    render();
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
  $('measureBtn').addEventListener('click', startMeasureMode);
  $('doneBtn').addEventListener('click', exportJson);
  $('undoBtn').addEventListener('click', undo);
  $('saveBtn').addEventListener('click', function () { persistActive(true); });
  $('toolsBtn').addEventListener('click', openTools);
  $('closeToolsBtn').addEventListener('click', closeTools);
  $('toolsBackdrop').addEventListener('click', function (e) { if (e.target === $('toolsBackdrop')) closeTools(); });
  $('clearBtn').addEventListener('click', function () { runTool(clearAll); });
  $('confirmBtn').addEventListener('click', confirmSheet);
  $('laterBtn').addEventListener('click', later);
  $('cornerToggleBtn').addEventListener('click', toggleOpeningCorner);
  $('deleteOpeningBtn').addEventListener('click', deleteCurrentOpening);
  $('zoomOutBtn').addEventListener('click', function () { setZoom(viewZoom / 1.25); });
  $('zoomInBtn').addEventListener('click', function () { setZoom(viewZoom * 1.25); });
  $('zoomResetBtn').addEventListener('click', resetView);
  $('rotateBtn').addEventListener('click', rotateView);
  $('notesBtn').addEventListener('click', function () { runTool(openNoteTargetChooser); });
  $('roomBtn').addEventListener('click', function () { runTool(openRoomPicker); });
  $('surfacesBtn').addEventListener('click', function () { runTool(openSurfaces); });
  $('presentBtn').addEventListener('click', function () { runTool(openPresentation); });
  $('closePresentationBtn').addEventListener('click', closePresentation);
  $('presentationBackdrop').addEventListener('click', function (e) { if (e.target === $('presentationBackdrop')) closePresentation(); });
  $('solvePlanBtn').addEventListener('click', function () { runTool(openSolver); });
  $('elaborateBtn').addEventListener('click', function () { runTool(function () { startProcessing(false); }); });
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
  $('closeNoteTargetBtn').addEventListener('click', closeNoteTargetChooser);
  $('noteTargetBackdrop').addEventListener('click', function (e) { if (e.target === $('noteTargetBackdrop')) closeNoteTargetChooser(); });
  document.querySelectorAll('[data-note-target]').forEach(function (b) {
    b.addEventListener('click', function () { startNotePick(b.dataset.noteTarget); });
  });
  $('closeNoteEditorBtn').addEventListener('click', function () { closeNoteEditor(true); });
  $('noteEditorBackdrop').addEventListener('click', function (e) { if (e.target === $('noteEditorBackdrop')) closeNoteEditor(true); });
  $('saveRawNoteBtn').addEventListener('click', function () { saveCurrentNote(false); });
  $('rewriteNoteBtn').addEventListener('click', rewriteCurrentNote);
  $('deleteNoteBtn').addEventListener('click', deleteCurrentNote);
  $('wallHeightInput').addEventListener('change', changeWallHeight);
  $('planName').addEventListener('change', function () { persistActive(); });
  document.querySelectorAll('[data-key]').forEach(function (b) { b.addEventListener('click', function () { keypad(b.dataset.key); }); });
  $('sheetBackdrop').addEventListener('click', function (e) { if (e.target === $('sheetBackdrop')) later(); });
  $('closeMissingMeasuresBtn').addEventListener('click', function () { $('missingMeasuresBackdrop').classList.add('hidden'); });
  $('missingMeasuresBackdrop').addEventListener('click', function (e) { if (e.target === $('missingMeasuresBackdrop')) $('missingMeasuresBackdrop').classList.add('hidden'); });
  $('insertMissingMeasuresBtn').addEventListener('click', function () {
    $('missingMeasuresBackdrop').classList.add('hidden');
    if (processedUI) processedUI.showTab('raw');
    var missing = walls.filter(function (w) { return !Number.isFinite(w.lengthCm) || w.lengthCm <= 0; });
    if (missing.length) openNextMissing(missing[0].id);
  });
  $('settingsBackdrop').addEventListener('click', function (e) { if (e.target === $('settingsBackdrop')) closeSettings(); });
  window.addEventListener('resize', function () {
    resize();
    if (presentationModel) requestAnimationFrame(renderPresentation);
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden && activePlanId) persistActive(); });

  processedUI = new ProcessedPlanUI({
    getPlan: currentPlan,
    getClient: backendClient,
    toast: toast,
    onElaborate: function () { startProcessing(false); },
    onReprocess: function () { startProcessing(true); },
    onConfigure: openSettings
  });

  loadAll();
  showDashboard();
})();