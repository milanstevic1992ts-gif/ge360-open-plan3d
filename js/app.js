import { solveFloorPlan } from '../geometry-engine/index.js';
import { buildFaces, findFaceAtPoint, matchRoomFace, calculateSurfaces } from './room-surfaces.js';
import { straightenPolyline, snapPolylineCornersToWalls } from './sketch-snap.js';
import { backendRootFromApi, normalizeBackendApiUrl, parseBridgeQr } from './backend-bridge.js';
import { rectRoomGeometry, snapRectRoomCenter } from './room-template.js';
import { buildPlanPayload, payloadFingerprint, measuredWallCount, roomTypeFromName, DEFAULT_WALL_THICKNESS_CM } from './plan-payload.js';
import { createBackendClient } from './backend-client.js';
import { compactResult, humanizeText, questionAction, isResultStale, statusInfo, qualityLabel, fmtNum, drawBackendPlan, decisionWalls, fmtRange, confidenceLabel, isAgentCorrected } from './backend-results.js';
import { createOfflineQueue, isRetryableBackendError } from './offline-queue.js';
import { savePhotoBlob, getPhotoBlob, deletePhotoBlob, targetKey as photoTargetKey } from './photo-store.js';
import { laserAvailable, scanLaserDevices, connectLaserDevice, disconnectLaserDevice, restoreLaserDevice, listenLaser } from './laser-client.js';
import { openingPresetSpec, detectOpeningPreset, fitOpeningToWall, offsetForReference, doorPresetKeys, doorKindSpec, applyDoorKind, normalizeDoorKind, normalizeWindowKind, windowKindSpec, applyWindowKind } from './opening-presets.js';
import { BUNDLED_WORK_CATALOG, loadCachedWorkCatalog, saveCachedWorkCatalog, loadWorkUsage, recordWorkUse, searchWorkCatalog } from './work-catalog.js';
import { createPdfReader } from './pdf-reader.js';
import { wallConstructionMetrics, summarizeConstruction, constructionWorkLines } from './construction-quantities.js';

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('stage');
  var ctx = canvas.getContext('2d');
  var wrap = $('stageWrap');

  var LIBRARY_KEY = 'ge360-rilievo-library-v3';
  var SETTINGS_KEY = 'ge360-rilievo-settings-v1';

  var library = [];
  var settings = { serverUrl: '', apiKey: '', bridgeConfigured: false, bridgeConnected: false, bridgeAddress: '', bridgeEndpoint: '', bridgePairedAt: null };
  var activePlanId = null;
  var mode = 'draw';
  var rawStrokes = [];
  var walls = [];
  var openings = [];
  var currentStroke = null;
  var activePointerId = null;
  var selectedWallId = null;
  var selectedEntity = null;
  var selectionDrag = null;
  var wallStateEditingId = null;
  var wallStateDraft = 'existing';
  var wallThicknessDraft = null;
  var currentOpeningId = null;
  var sheetType = null;
  var numberText = '';
  var history = [];
  var dpr = 1;
  var viewZoom = 1;
  var viewRotation = 0;
  var viewPanX = 0;
  var viewPanY = 0;
  var touchPointers = new Map();
  var twoFingerPan = null;
  var blockTouchUntilRelease = false;
  var firstTouchRoomCenter = null;
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
  var works = [];
  var workCatalogState = loadCachedWorkCatalog(localStorage);
  var workCatalog = workCatalogState.works || BUNDLED_WORK_CATALOG;
  var workTarget = { type: 'plan', id: null, name: 'Tutta la casa', roomType: 'altro' };
  var notePickMode = null;
  var pendingNoteTarget = null;
  var currentNoteId = null;
  var roomPlacementMode = false;
  var roomDraft = null;
  var diagonals = [];
  var quoteFirst = null;
  var currentDiagonalId = null;
  var wallThicknessCm = DEFAULT_WALL_THICKNESS_CM;
  var wallReference = 'interior';
  var calcBusy = false;
  var resultPlanId = null;
  var resultHighlightWallId = null;
  var resultOverride = null;
  var resultOverrideVersion = null;
  var offlineQueue = createOfflineQueue(localStorage);
  var syncBusy = false;
  var photoCaptureTarget = null;
  var laserDevices = [];
  var laserListenerReady = false;
  var laserConnected = false;
  var openingQuickIsNew = false;
  var openingQuickOriginal = null;
  var openingCustomFlow = false;
  var openingPositionFlow = false;
  var resultHighlightWallIds = [];
  var pdfArchivePlanId = null;
  var pdfReader = null;
  var pdfReaderBlob = null;
  var pdfReaderVersion = null;
  var pdfReaderFilename = '';
  var connectionState = {
    checking: false,
    checked: false,
    reachable: false,
    authenticated: false,
    apiOk: false,
    pdfOk: null,
    latencyMs: null,
    checkedAt: null,
    error: null
  };

  function uid(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  // cm -> "3,45" oppure "3,457" se c'è il millimetro
  function metersText(cm) {
    if (!Number.isFinite(cm)) return '';
    var mm = Math.round(cm * 10);
    return (mm % 10 === 0 ? (cm / 100).toFixed(2) : (cm / 100).toFixed(3)).replace('.', ',');
  }

  // metri digitati -> cm con precisione al millimetro
  function metersToCm(meters) {
    return Math.round(meters * 1000) / 10;
  }

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
    library.forEach(function (plan) {
      if (!Array.isArray(plan.photos)) plan.photos = [];
      if (plan.backend && !Array.isArray(plan.backend.localHistory)) plan.backend.localHistory = [];
    });
    settings = Object.assign(settings, parse(localStorage.getItem(SETTINGS_KEY), {}));
    renderDashboard();
    updateServerBadge();
    restoreBridgeTunnel();
    initLaser();
    setTimeout(function () { flushOfflineQueue(); flushPendingPhotos(); }, 1200);
    setTimeout(refreshConnectionIndicator, 1600);
  }

  function currentPlan() {
    for (var i = 0; i < library.length; i++) if (library[i].id === activePlanId) return library[i];
    return null;
  }

  function authoritativeResult(plan) {
    if (!plan || !plan.backend || !plan.backend.result) return null;
    var result = plan.backend.result;
    try {
      // Do not call planPayload() here: planPayload includes summary(), while
      // summary() itself asks for the authoritative result.
      var fingerprintPayload = buildPlanPayload(
        Object.assign({}, plan, { notes: plan.notes || [] }),
        { summary: {} }
      );
      if (isResultStale(result, payloadFingerprint(fingerprintPayload))) return null;
    } catch (_) { return null; }
    return result;
  }

  function summary(plan) {
    var ws = plan ? (plan.walls || []) : walls;
    var os = plan ? (plan.openings || []) : openings;
    var authoritative = plan ? authoritativeResult(plan) : null;
    var serverFloor = authoritative && authoritative.totals && authoritative.totals.floorAreaM2;
    return {
      walls: ws.length,
      missing: ws.filter(function (w) { return !w.lengthCm; }).length,
      doors: os.filter(function (o) { return o.type === 'door'; }).length,
      windows: os.filter(function (o) { return o.type === 'window'; }).length,
      rooms: plan ? (plan.rooms || []).length : rooms.length,
      notes: plan ? (plan.notes || []).length : notes.length,
      works: plan ? (plan.works || []).length : works.length,
      photos: plan ? (plan.photos || []).length : 0,
      floorM2: Number.isFinite(serverFloor) ? serverFloor :
        (plan && plan.surfaceSummary && Number.isFinite(plan.surfaceSummary.floorM2) ? plan.surfaceSummary.floorM2 : null),
      authoritative: !!authoritative
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
    plan.works = clone(works);
    plan.wallHeightM = wallHeightM;
    plan.diagonals = clone(diagonals);
    plan.wallThicknessCm = wallThicknessCm;
    plan.wallReference = wallReference;
    plan.view = { zoom: viewZoom, rotation: viewRotation, panX: viewPanX, panY: viewPanY };
    plan.surfaceSummary = surfaceCache && surfaceCache.totals ? clone(surfaceCache.totals) : null;
    plan.summary = summary();
    saveLibrary();
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
      notes: [],
      works: [],
      photos: [],
      wallHeightM: 2.70,
      diagonals: [],
      wallThicknessCm: DEFAULT_WALL_THICKNESS_CM,
      wallReference: 'interior',
      view: { zoom: 1, rotation: 0, panX: 0, panY: 0 }
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
    notes = clone(plan.notes || []);
    works = clone(plan.works || []);
    diagonals = clone(plan.diagonals || []);
    quoteFirst = null;
    currentDiagonalId = null;
    wallThicknessCm = Number.isFinite(plan.wallThicknessCm) && plan.wallThicknessCm > 0 ? plan.wallThicknessCm : DEFAULT_WALL_THICKNESS_CM;
    wallReference = plan.wallReference || 'interior';
    notePickMode = null;
    pendingNoteTarget = null;
    currentNoteId = null;
    roomPlacementMode = false;
    roomDraft = null;
    $('roomPlacementBar').classList.add('hidden');
    wallHeightM = Number.isFinite(plan.wallHeightM) && plan.wallHeightM > 0 ? plan.wallHeightM : 2.70;
    surfaceCache = null;
    roomPickMode = false;
    viewZoom = plan.view && Number.isFinite(plan.view.zoom) ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, plan.view.zoom)) : 1;
    viewRotation = plan.view && Number.isFinite(plan.view.rotation) ? ((plan.view.rotation % 360) + 360) % 360 : 0;
    viewPanX = plan.view && Number.isFinite(plan.view.panX) ? plan.view.panX : 0;
    viewPanY = plan.view && Number.isFinite(plan.view.panY) ? plan.view.panY : 0;
    touchPointers.clear();
    twoFingerPan = null;
    blockTouchUntilRelease = false;
    firstTouchRoomCenter = null;
    history = [];
    currentStroke = null;
    selectedWallId = null;
    selectedEntity = null;
    selectionDrag = null;
    $('selectionBar').classList.add('hidden');
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
      meta.textContent = s.walls + ' muri · ' + (s.rooms ? s.rooms + ' ambienti · ' : '') + (s.works ? s.works + ' lavori · ' : '') + (s.notes ? s.notes + ' appunti · ' : '') + (s.photos ? s.photos + ' foto · ' : '') + (Number.isFinite(s.floorM2) ? s.floorM2.toFixed(1).replace('.', ',') + ' m²' + (s.authoritative ? ' server · ' : ' indicativi · ') : '') + (s.missing ? s.missing + ' misure mancanti' : 'misure complete') + ' · ' + date;
      if (offlineQueue.has(plan.id)) {
        var pendingSync = document.createElement('span');
        pendingSync.className = 'backend-badge pending';
        pendingSync.textContent = 'DA INVIARE';
        meta.appendChild(document.createElement('br'));
        meta.appendChild(pendingSync);
      }

      var actions = document.createElement('div');
      actions.className = 'plan-actions';
      actions.appendChild(makeButton('APRI', 'open-plan', function () { openPlan(plan.id); }));
      actions.appendChild(makeButton(calcBusy ? '…' : 'CALCOLA', 'send-plan', function () { sendPlan(plan.id); }));
      if (plan.backend && plan.backend.result) {
        actions.appendChild(makeButton('RISULTATO', 'send-plan result-plan', function () { openResult(plan.id); }));
        actions.appendChild(makeButton('PDF (' + knownPdfVersionCount(plan) + ')', 'pdf-plan', function () { openPdfArchive(plan.id); }));
        var bInfo = statusInfo(plan.backend.result.status);
        var badge = document.createElement('span');
        badge.className = 'backend-badge ' + bInfo.cls;
        badge.textContent = bInfo.label + (Number.isFinite(plan.backend.result.totals && plan.backend.result.totals.floorAreaM2) ? ' · ' + fmtNum(plan.backend.result.totals.floorAreaM2, 2, 'm²') : '');
        meta.appendChild(document.createElement('br'));
        meta.appendChild(badge);
      }
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

  function geometrySnapshot() {
    return JSON.stringify({
      rawStrokes: rawStrokes,
      walls: walls,
      openings: openings,
      rooms: rooms,
      notes: notes,
      works: works,
      diagonals: diagonals,
      wallHeightM: wallHeightM
    });
  }

  function pushHistorySnapshot(snapshot) {
    history.push(snapshot);
    if (history.length > 30) history.shift();
  }

  function restoreGeometrySnapshot(snapshot) {
    var data = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    rawStrokes = clone(data.rawStrokes || []);
    walls = clone(data.walls || []);
    openings = clone(data.openings || []);
    rooms = clone(data.rooms || []);
    notes = clone(data.notes || []);
    works = clone(data.works || []);
    diagonals = clone(data.diagonals || []);
    wallHeightM = Number.isFinite(data.wallHeightM) ? data.wallHeightM : wallHeightM;
    surfaceCache = null;
  }

  function checkpoint() {
    pushHistorySnapshot(geometrySnapshot());
  }

  function undo() {
    if (!history.length) return toast('Niente da annullare');
    var data = JSON.parse(history.pop());
    rawStrokes = data.rawStrokes || [];
    walls = data.walls || [];
    openings = data.openings || [];
    rooms = data.rooms || [];
    notes = data.notes || [];
    works = data.works || [];
    diagonals = data.diagonals || [];
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
      x: center.x + viewPanX + (dx * cos - dy * sin) * viewZoom,
      y: center.y + viewPanY + (dx * sin + dy * cos) * viewZoom
    };
  }

  function screenToWorld(p) {
    var center = viewCenter();
    var dx = (p.x - center.x - viewPanX) / viewZoom;
    var dy = (p.y - center.y - viewPanY) / viewZoom;
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
    viewPanX = 0;
    viewPanY = 0;
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

  function selectionWallIds(entity) {
    if (!entity) return [];
    if (entity.type === 'wall') return entity.id ? [entity.id] : [];
    return Array.isArray(entity.wallIds) ? entity.wallIds.slice() : [];
  }

  function faceForWallIds(wallIds) {
    var key = faceKey({ wallIds: wallIds || [] });
    if (!key) return null;
    return buildFaces(walls).find(function (face) { return faceKey(face) === key; }) || null;
  }

  var WALL_STATES = ['existing', 'demolish', 'new', 'close-opening', 'new-opening'];

  function wallConstructionState(wall) {
    var state = wall && String(wall.constructionState || 'existing');
    return WALL_STATES.indexOf(state) !== -1 ? state : 'existing';
  }

  function wallStateLabel(state) {
    return {
      'existing': 'ESISTENTE',
      'demolish': 'DA DEMOLIRE',
      'new': 'NUOVO MURO',
      'close-opening': 'CHIUSURA APERTURA',
      'new-opening': 'NUOVA APERTURA'
    }[state] || 'ESISTENTE';
  }

  function wallStateNeedsThickness(state) {
    return state === 'demolish' || state === 'new';
  }

  function parseWallThicknessInput() {
    var raw = String($('wallThicknessCustom').value || '').trim().replace(',', '.');
    if (!raw) return null;
    var value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : NaN;
  }

  function renderWallStateDraft() {
    var needsThickness = wallStateNeedsThickness(wallStateDraft);
    document.querySelectorAll('#wallStateBackdrop [data-wall-state]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.wallState === wallStateDraft);
    });

    $('wallThicknessPanel').classList.toggle('hidden', !needsThickness);
    document.querySelectorAll('#wallThicknessPanel [data-wall-thickness]').forEach(function (button) {
      button.classList.toggle('active', Number(button.dataset.wallThickness) === Number(wallThicknessDraft));
    });

    if (needsThickness && Number.isFinite(wallThicknessDraft)) {
      $('wallThicknessCustom').value = String(wallThicknessDraft).replace('.', ',');
    } else if (!needsThickness) {
      $('wallThicknessCustom').value = '';
    }

    var summary = 'Stato: ' + wallStateLabel(wallStateDraft);
    if (needsThickness) {
      summary += Number.isFinite(wallThicknessDraft)
        ? ' · spessore ' + String(wallThicknessDraft).replace('.', ',') + ' cm'
        : ' · scegli lo spessore';
    } else {
      summary += ' · nessuno spessore richiesto';
    }
    $('wallStateSummary').textContent = summary;
  }

  function openWallStateEditor() {
    if (!selectedEntity || selectedEntity.type !== 'wall') return toast('Seleziona prima un muro');
    var wall = walls.find(function (w) { return w.id === selectedEntity.id; });
    if (!wall) return toast('Muro non trovato');
    wallStateEditingId = wall.id;
    wallStateDraft = wallConstructionState(wall);
    wallThicknessDraft = Number.isFinite(Number(wall.constructionThicknessCm))
      ? Number(wall.constructionThicknessCm)
      : null;
    renderWallStateDraft();
    $('wallStateBackdrop').classList.remove('hidden');
  }

  function closeWallStateEditor() {
    wallStateEditingId = null;
    wallStateDraft = 'existing';
    wallThicknessDraft = null;
    $('wallStateBackdrop').classList.add('hidden');
  }

  function setWallConstructionState(state) {
    if (WALL_STATES.indexOf(state) === -1) return;
    wallStateDraft = state;
    if (!wallStateNeedsThickness(state)) wallThicknessDraft = null;
    var wall = walls.find(function (w) { return w.id === wallStateEditingId; });
    if (
      wallStateNeedsThickness(state) &&
      wall &&
      wallConstructionState(wall) === state &&
      Number.isFinite(Number(wall.constructionThicknessCm))
    ) {
      wallThicknessDraft = Number(wall.constructionThicknessCm);
    }
    renderWallStateDraft();
    vibrate(10);
  }

  function chooseWallThickness(value) {
    var thickness = Number(value);
    if (!Number.isFinite(thickness) || thickness <= 0) return;
    wallThicknessDraft = Math.round(thickness * 10) / 10;
    $('wallThicknessCustom').value = String(wallThicknessDraft).replace('.', ',');
    renderWallStateDraft();
    vibrate(8);
  }

  function saveWallConstructionState() {
    var wall = walls.find(function (w) { return w.id === wallStateEditingId; });
    if (!wall) return closeWallStateEditor();

    if (wallStateNeedsThickness(wallStateDraft)) {
      var custom = parseWallThicknessInput();
      if (Number.isNaN(custom)) return toast('Inserisci uno spessore valido');
      if (Number.isFinite(custom)) wallThicknessDraft = custom;
      if (!Number.isFinite(wallThicknessDraft) || wallThicknessDraft <= 0) {
        return toast('Scegli lo spessore del muro');
      }
      if (wallThicknessDraft < 3 || wallThicknessDraft > 100) {
        return toast('Spessore muro non valido');
      }
    }

    checkpoint();
    wall.constructionState = wallStateDraft;
    if (wallStateNeedsThickness(wallStateDraft)) {
      wall.constructionThicknessCm = wallThicknessDraft;
    } else {
      delete wall.constructionThicknessCm;
      delete wall.thicknessCm;
      delete wall.thicknessMm;
    }

    surfaceCache = null;
    persistActive();
    closeWallStateEditor();
    updateSelectionBar();
    render();
    vibrate(16);
    toast('Muro: ' + wallStateLabel(wall.constructionState));
  }


  function selectableEntityAt(p) {
    // Aperture prima dei muri: altrimenti una porta coincide geometricamente col muro
    // e sarebbe quasi impossibile selezionarla in modalità modifica.
    var openingHit = nearestOpening(p);
    if (openingHit && openingHit.distance <= 34 / viewZoom) {
      var op = openingHit.opening;
      return {
        type: 'opening',
        id: op.id,
        wallId: op.wallId,
        name: op.type === 'door' ? 'Porta' : 'Finestra'
      };
    }

    var wallHit = nearestWall(p);
    if (wallHit && wallHit.distance <= 28 / viewZoom) {
      return { type: 'wall', id: wallHit.wall.id, wallIds: [wallHit.wall.id], name: 'Muro' };
    }

    var face = findFaceAtPoint(walls, p);
    if (!face) return null;
    var room = faceRoom(face);
    var wallIds = face.wallIds.slice().sort();
    return {
      type: 'room',
      id: room ? room.id : null,
      faceKey: faceKey(face),
      wallIds: wallIds,
      name: room ? (room.name || 'Ambiente') : 'Stanza'
    };
  }

  function updateSelectionBar() {
    var bar = $('selectionBar');
    if (!selectedEntity || mode !== 'select') {
      bar.classList.add('hidden');
      return;
    }

    $('workSelectedBtn').classList.toggle('hidden', selectedEntity.type === 'opening');
    $('wallStateBtn').classList.toggle('hidden', selectedEntity.type !== 'wall');

    if (selectedEntity.type === 'wall') {
      var wall = walls.find(function (w) { return w.id === selectedEntity.id; });
      var measure = wall && Number.isFinite(wall.lengthCm) ? ' · ' + metersText(wall.lengthCm) + ' m' : '';
      var state = wallConstructionState(wall);
      var stateSuffix = state !== 'existing' ? ' · ' + wallStateLabel(state) : '';
      $('selectionLabel').textContent = 'MURO' + measure + stateSuffix;
      $('wallStateBtn').textContent = state === 'existing' ? 'STATO' : wallStateLabel(state);
      $('selectionHint').textContent = 'Trascina con un dito per spostare il muro';
    } else if (selectedEntity.type === 'opening') {
      var opening = openings.find(function (o) { return o.id === selectedEntity.id; });
      if (!opening) {
        clearSelection(false);
        return;
      }
      var label;
      if (opening.type === 'door') label = doorKindSpec(opening.doorKind || 'internal').label;
      else label = windowKindSpec(opening.windowKind || 'single', settings).label;
      $('selectionLabel').textContent = String(label).toUpperCase() +
        (Number.isFinite(opening.widthCm) ? ' · ' + openingCmText(opening.widthCm) + ' cm' : '');
      $('selectionHint').textContent = 'Trascina lungo il muro · MODIFICA per misure e tipo';
    } else {
      var room = selectedEntity.id ? rooms.find(function (r) { return r.id === selectedEntity.id; }) : null;
      $('selectionLabel').textContent = 'STANZA · ' + String(room ? room.name : (selectedEntity.name || 'Ambiente')).toUpperCase();
      $('selectionHint').textContent = 'Trascina con un dito per spostare la stanza';
    }
    bar.classList.remove('hidden');
  }

  function clearSelection(announce) {
    selectedEntity = null;
    selectionDrag = null;
    $('selectionBar').classList.add('hidden');
    if (announce) toast('Selezione annullata');
    render();
  }

  function beginSelectionPointer(p, pointerId) {
    var hit = selectableEntityAt(p);
    if (!hit) {
      clearSelection(false);
      toast('Tocca un muro o dentro una stanza');
      return false;
    }

    selectedEntity = hit;
    activePointerId = pointerId;
    selectionDrag = {
      pointerId: pointerId,
      start: { x: p.x, y: p.y },
      last: { x: p.x, y: p.y },
      wallIds: selectionWallIds(hit),
      beforeSnapshot: geometrySnapshot(),
      moved: false,
      checkpointed: false
    };
    updateSelectionBar();
    render();
    vibrate(10);
    return true;
  }

  function translateWallSet(wallIds, dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return;
    var selected = new Set(wallIds || []);
    var joints = [];
    var touched = new Set();

    walls.forEach(function (wall) {
      if (!selected.has(wall.id)) return;
      joints.push({ x: wall.a.x, y: wall.a.y }, { x: wall.b.x, y: wall.b.y });
    });

    walls.forEach(function (wall) {
      if (!selected.has(wall.id)) return;
      wall.a.x += dx; wall.a.y += dy;
      wall.b.x += dx; wall.b.y += dy;
      touched.add(wall.id);
    });

    walls.forEach(function (wall) {
      if (selected.has(wall.id)) return;
      ['a', 'b'].forEach(function (end) {
        var pt = wall[end];
        var attached = joints.some(function (joint) {
          return Math.abs(pt.x - joint.x) < 0.02 && Math.abs(pt.y - joint.y) < 0.02;
        });
        if (!attached) return;
        pt.x += dx;
        pt.y += dy;
        touched.add(wall.id);
      });
    });

    rawStrokes.forEach(function (stroke) {
      if (!Array.isArray(stroke.wallIds)) return;
      if (stroke.wallIds.some(function (id) { return touched.has(id); })) stroke.manualEdited = true;
    });

    surfaceCache = null;
  }

  function openingOverlapAtPosition(opening, position) {
    var wall = openingWall(opening);
    if (!wall || !Number.isFinite(wall.lengthCm) || wall.lengthCm <= 0 ||
        !Number.isFinite(opening.widthCm)) return false;
    var center = position * wall.lengthCm;
    var start = center - opening.widthCm / 2;
    var end = center + opening.widthCm / 2;
    return openings.some(function (other) {
      if (!other || other.id === opening.id || other.wallId !== opening.wallId ||
          !Number.isFinite(other.widthCm)) return false;
      var otherCenter = Number(other.position);
      if (!Number.isFinite(otherCenter)) {
        var point = openingWorldPoint(other, wall);
        if (!point) return false;
        otherCenter = dist(wall.a, point) / Math.max(1e-6, dist(wall.a, wall.b));
      }
      var oc = otherCenter * wall.lengthCm;
      var os = oc - other.widthCm / 2;
      var oe = oc + other.widthCm / 2;
      return start < oe - 0.5 && end > os + 0.5;
    });
  }

  function moveOpeningAlongWall(opening, p) {
    var wall = openingWall(opening);
    if (!opening || !wall) return false;
    var hit = distToSegment(p, wall.a, wall.b);
    var t = hit.t;

    if (Number.isFinite(wall.lengthCm) && wall.lengthCm > 0 && Number.isFinite(opening.widthCm)) {
      var halfT = Math.min(.49, opening.widthCm / wall.lengthCm / 2);
      t = Math.max(halfT, Math.min(1 - halfT, t));
      if (openingOverlapAtPosition(opening, t)) return false;
      var centerCm = t * wall.lengthCm;
      opening.offsetCm = opening.referenceEnd === 'b'
        ? Math.round((wall.lengthCm - centerCm - opening.widthCm / 2) * 10) / 10
        : Math.round((centerCm - opening.widthCm / 2) * 10) / 10;
      opening.offsetCm = Math.max(0, opening.offsetCm);
    } else {
      t = Math.max(.02, Math.min(.98, t));
      opening.offsetCm = null;
    }

    opening.position = t;
    if (opening.type === 'door') syncDoorMotion(opening);
    surfaceCache = null;
    return true;
  }

  function updateSelectionDrag(p, pointerId) {
    if (!selectionDrag || selectionDrag.pointerId !== pointerId) return false;
    var threshold = 4 / viewZoom;
    if (!selectionDrag.moved && dist(selectionDrag.start, p) < threshold) return true;

    if (!selectionDrag.checkpointed) {
      pushHistorySnapshot(selectionDrag.beforeSnapshot);
      selectionDrag.checkpointed = true;
    }

    if (selectedEntity && selectedEntity.type === 'opening') {
      var opening = openings.find(function (o) { return o.id === selectedEntity.id; });
      if (!opening) return true;
      var movedOpening = moveOpeningAlongWall(opening, p);
      if (movedOpening) {
        selectionDrag.moved = true;
        selectionDrag.last = { x: p.x, y: p.y };
      } else {
        selectionDrag.blocked = true;
      }
      render();
      return true;
    }

    selectionDrag.moved = true;
    var from = selectionDrag.last;
    translateWallSet(selectionDrag.wallIds, p.x - from.x, p.y - from.y);
    selectionDrag.last = { x: p.x, y: p.y };
    render();
    return true;
  }

  function finishSelectionDrag(pointerId) {
    if (!selectionDrag || selectionDrag.pointerId !== pointerId) return false;
    var moved = selectionDrag.moved;
    selectionDrag = null;
    activePointerId = null;
    if (moved) {
      refreshSurfaceCache();
      persistActive();
      updateUI();
      updateSelectionBar();
      render();
      vibrate(16);
      toast(selectedEntity && selectedEntity.type === 'opening' ? 'Apertura spostata sul muro ✓' : 'Elemento spostato ✓');
    }
    return true;
  }

  function cancelSelectionDragForNavigation() {
    if (!selectionDrag) return;
    if (selectionDrag.moved) {
      restoreGeometrySnapshot(selectionDrag.beforeSnapshot);
      if (selectionDrag.checkpointed && history.length && history[history.length - 1] === selectionDrag.beforeSnapshot) history.pop();
    }
    selectionDrag = null;
    activePointerId = null;
    updateSelectionBar();
  }

  function deleteSelectedEntity() {
    if (!selectedEntity) return;
    var entity = clone(selectedEntity);

    if (entity.type === 'opening') {
      var selectedOpening = openings.find(function (o) { return o.id === entity.id; });
      if (!selectedOpening) return clearSelection(false);
      var openingLabel = selectedOpening.type === 'door' ? 'porta' : 'finestra';
      if (!confirm('Eliminare questa ' + openingLabel + '?')) return;
      checkpoint();
      openings = openings.filter(function (o) { return o.id !== entity.id; });
      notes = notes.filter(function (n) { return !(n.targetType === 'opening' && n.targetId === entity.id); });
      selectedEntity = null;
      selectionDrag = null;
      surfaceCache = null;
      persistActive();
      updateUI();
      render();
      vibrate(20);
      toast(openingLabel === 'porta' ? 'Porta eliminata' : 'Finestra eliminata');
      return;
    }
    var isRoom = entity.type === 'room';
    var question = isRoom
      ? 'Eliminare questa stanza? I muri esclusivi della stanza verranno eliminati.'
      : 'Eliminare questo muro? Verranno eliminate anche porte e finestre presenti sul muro.';
    if (!confirm(question)) return;

    checkpoint();
    var removeWallIds = new Set();
    var deletedRoomIds = new Set();

    if (entity.type === 'wall') {
      removeWallIds.add(entity.id);
      rooms.forEach(function (room) {
        if (Array.isArray(room.wallIds) && room.wallIds.indexOf(entity.id) !== -1) deletedRoomIds.add(room.id);
      });
    } else {
      if (entity.id) deletedRoomIds.add(entity.id);
      var otherRooms = rooms.filter(function (room) { return !entity.id || room.id !== entity.id; });
      (entity.wallIds || []).forEach(function (wallId) {
        var shared = otherRooms.some(function (room) {
          return Array.isArray(room.wallIds) && room.wallIds.indexOf(wallId) !== -1;
        });
        if (!shared) removeWallIds.add(wallId);
      });
    }

    rooms.forEach(function (room) {
      if (Array.isArray(room.wallIds) && room.wallIds.some(function (id) { return removeWallIds.has(id); })) {
        deletedRoomIds.add(room.id);
      }
    });

    var deletedOpeningIds = new Set(
      openings.filter(function (opening) { return removeWallIds.has(opening.wallId); })
        .map(function (opening) { return opening.id; })
    );

    walls = walls.filter(function (wall) { return !removeWallIds.has(wall.id); });
    openings = openings.filter(function (opening) { return !deletedOpeningIds.has(opening.id); });
    rooms = rooms.filter(function (room) { return !deletedRoomIds.has(room.id); });
    diagonals = diagonals.filter(function (diagonal) {
      return !(diagonal.a && removeWallIds.has(diagonal.a.wallId)) &&
        !(diagonal.b && removeWallIds.has(diagonal.b.wallId));
    });
    notes = notes.filter(function (note) {
      if (note.targetType === 'wall' && removeWallIds.has(note.targetId)) return false;
      if (note.targetType === 'opening' && deletedOpeningIds.has(note.targetId)) return false;
      if (['room', 'floor', 'ceiling'].indexOf(note.targetType) !== -1) {
        if (deletedRoomIds.has(note.targetId)) return false;
        if (entity.faceKey && note.targetId === entity.faceKey) return false;
      }
      return true;
    });
    works = works.filter(function (work) {
      return !(work.targetType === 'room' && deletedRoomIds.has(work.targetId));
    });
    rawStrokes = rawStrokes.filter(function (stroke) {
      return !(Array.isArray(stroke.wallIds) && stroke.wallIds.some(function (id) { return removeWallIds.has(id); }));
    });

    if (selectedWallId && removeWallIds.has(selectedWallId)) selectedWallId = null;
    currentOpeningId = null;
    selectedEntity = null;
    selectionDrag = null;
    $('selectionBar').classList.add('hidden');
    surfaceCache = null;
    refreshSurfaceCache();
    persistActive();
    updateUI();
    render();
    vibrate(25);
    toast(isRoom ? 'Stanza eliminata' : 'Muro eliminato');
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
    numberText = Number.isFinite(wall.lengthCm) && wall.lengthCm > 0 ? metersText(wall.lengthCm) : '';
    openSheet('wall');
    render();
    vibrate(14);
  }

  function editSelectedEntity() {
    if (!selectedEntity) return toast('Seleziona prima un muro o una stanza');

    if (selectedEntity.type === 'wall') {
      var wall = walls.find(function (w) { return w.id === selectedEntity.id; });
      if (!wall) return toast('Muro non trovato');
      editWallMeasurement(wall);
      return;
    }

    if (selectedEntity.type === 'opening') {
      var selectedOpening = openings.find(function (o) { return o.id === selectedEntity.id; });
      if (!selectedOpening) return toast('Apertura non trovata');
      editOpening(selectedOpening);
      return;
    }

    var face = faceForWallIds(selectedEntity.wallIds || []);
    if (!face) return toast('Non riesco a riconoscere questa stanza');

    var existing = selectedEntity.id
      ? rooms.find(function (r) { return r.id === selectedEntity.id; })
      : faceRoom(face);

    pendingRoomFace = face;
    pendingRoomId = existing ? existing.id : null;
    selectedRoomName = existing ? existing.name : '';
    $('roomCustomName').value = existing && existing.custom ? existing.name : '';
    $('roomHeightInput').value = existing && existing.heightCm ? metersText(existing.heightCm) : '';
    $('roomTilingInput').value = existing && existing.tilingHeightCm ? metersText(existing.tilingHeightCm) : '';
    document.querySelectorAll('[data-room-name]').forEach(function (b) {
      b.classList.toggle('selected', !!existing && existing.name === b.dataset.roomName);
    });
    $('roomBackdrop').classList.remove('hidden');
    vibrate(14);
  }

  function editOpening(opening) {
    if (!opening) return;
    openOpeningQuick(opening, false);
    render();
    vibrate(14);
  }

  function deleteCurrentOpening() {
    if (sheetType === 'diagonal') return deleteCurrentDiagonal();
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
    $('openingQuickBackdrop').classList.add('hidden');
    openingQuickIsNew = false;
    openingQuickOriginal = null;
    openingCustomFlow = false;
    openingPositionFlow = false;
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
    cancelRectRoomPlacement(false);
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
    renderNotePhotos();
    $('noteEditorBackdrop').classList.remove('hidden');
    requestAnimationFrame(function () { $('noteRawText').focus(); });
  }


  function notePhotoTarget() {
    if (!pendingNoteTarget) return null;
    return {
      type: pendingNoteTarget.type === 'floor' || pendingNoteTarget.type === 'ceiling' ? 'room' : pendingNoteTarget.type,
      id: pendingNoteTarget.id,
      label: pendingNoteTarget.label || 'Foto cantiere'
    };
  }

  function renderNotePhotos() {
    var plan = currentPlan();
    var target = notePhotoTarget();
    var wrap = $('notePhotos');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!plan || !target) {
      $('notePhotoCount').textContent = 'Nessuna foto';
      return;
    }
    var key = photoTargetKey(target.type, target.id);
    var list = (plan.photos || []).filter(function (p) { return p.targetKey === key; });
    $('notePhotoCount').textContent = list.length ? list.length + (list.length === 1 ? ' foto' : ' foto') : 'Nessuna foto';
    list.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'note-photo';
      var left = document.createElement('span');
      left.innerHTML = '<b>📷 ' + String(p.filename || 'Foto').replace(/[<>]/g, '') + '</b>';
      var state = document.createElement('span');
      state.className = p.uploaded ? 'uploaded' : 'pending';
      state.textContent = p.uploaded ? 'SERVER ✓' : 'DA INVIARE';
      row.appendChild(left);
      row.appendChild(state);
      wrap.appendChild(row);
    });
  }

  function capturePhotoForCurrentTarget() {
    var target = notePhotoTarget();
    if (!target) return toast('Seleziona prima un muro o una stanza');
    photoCaptureTarget = target;
    $('photoInput').value = '';
    $('photoInput').click();
  }

  async function onPhotoSelected() {
    var input = $('photoInput');
    var file = input.files && input.files[0];
    var plan = currentPlan();
    var target = photoCaptureTarget;
    if (!file || !plan || !target) return;
    var id = uid('photo');
    var meta = {
      id: id,
      planId: plan.id,
      targetType: target.type,
      targetId: target.id || null,
      targetKey: photoTargetKey(target.type, target.id),
      caption: target.label,
      filename: file.name || (id + '.jpg'),
      mimeType: file.type || 'image/jpeg',
      size: file.size || 0,
      createdAt: new Date().toISOString(),
      uploaded: false
    };
    try {
      await savePhotoBlob(Object.assign({}, meta, { blob: file }));
      if (!Array.isArray(plan.photos)) plan.photos = [];
      plan.photos.push(meta);
      saveLibrary();
      renderNotePhotos();
      toast('Foto salvata sul telefono ✓');
      flushPendingPhotos();
    } catch (e) {
      toast('Impossibile salvare la foto: ' + (e.message || e));
    } finally {
      photoCaptureTarget = null;
      input.value = '';
    }
  }

  async function syncPlanPhotos(plan, remotePlanId) {
    if (!plan || !settings.serverUrl || !settings.apiKey) return;
    var pending = (plan.photos || []).filter(function (p) { return !p.uploaded; });
    if (!pending.length) return;
    var client = backendClient();
    for (var i = 0; i < pending.length; i++) {
      var meta = pending[i];
      var stored = await getPhotoBlob(meta.id);
      if (!stored || !stored.blob) continue;
      try {
        var result = await client.uploadPhoto(remotePlanId || plan.id, stored.blob, meta);
        meta.uploaded = true;
        meta.uploadedAt = new Date().toISOString();
        meta.remoteId = result && result.photo ? result.photo.id : null;
        meta.remoteUrl = result && result.photo ? result.photo.url : null;
        saveLibrary();
      } catch (e) {
        if (isRetryableBackendError(e)) break;
        meta.uploadError = e.message || String(e);
        saveLibrary();
      }
    }
    if (plan.id === activePlanId) renderNotePhotos();
  }

  async function flushPendingPhotos() {
    if (!settings.serverUrl || !settings.apiKey || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    for (var i = 0; i < library.length; i++) {
      var plan = library[i];
      if (!plan.backend || !plan.backend.planId) continue;
      try { await syncPlanPhotos(plan, plan.backend.planId); } catch (_) {}
    }
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
    if (next !== 'select') clearSelection(false);
    mode = next;
    [['drawBtn', 'draw'], ['selectBtn', 'select'], ['doorBtn', 'door'], ['windowBtn', 'window'], ['measureBtn', 'measure'], ['quoteBtn', 'quote']].forEach(function (pair) {
      $(pair[0]).classList.toggle('active', pair[1] === mode);
    });
    quoteFirst = null;
    updateSelectionBar();
    if (announce !== false) {
      var msg = next === 'draw'
        ? 'Disegna col dito'
        : next === 'select'
          ? 'Tocca una stanza o un muro; trascina per spostare'
          : next === 'door'
            ? 'Tocca il muro nel punto della porta'
            : next === 'window'
              ? 'Tocca il muro nel punto della finestra'
              : next === 'quote'
                ? 'Tocca il primo angolo (o una quota esistente)'
                : 'Tocca il muro da modificare';
      toast(msg);
    }
  }

  function preferredDoorPreset(kind) {
    var normalized = normalizeDoorKind(kind);
    if (normalized === 'double' || normalized === 'armored-double') return '140';
    if (normalized === 'armored') return '90';
    return '80';
  }

  function placeOpening(p) {
    var existing = nearestOpening(p);
    if (existing) return editOpening(existing.opening);
    var hit = nearestWall(p);
    if (!hit) return toast('Tocca più vicino a un muro');

    var initial;
    var lastKey;
    var doorKind = null;

    if (mode === 'door') {
      doorKind = normalizeDoorKind(settings.lastDoorKind || 'internal');
      lastKey = settings.lastDoorPreset || preferredDoorPreset(doorKind);
      initial = openingPresetSpec('door', lastKey, settings, { doorKind: doorKind }) ||
        openingPresetSpec('door', preferredDoorPreset(doorKind), settings, { doorKind: doorKind }) ||
        openingPresetSpec('door', doorPresetKeys(doorKind)[0], settings, { doorKind: doorKind });
    } else {
      var windowKind = normalizeWindowKind(settings.lastWindowKind || settings.lastWindowPreset || 'single');
      lastKey = 'standard';
      initial = openingPresetSpec('window', 'standard', settings, { windowKind: windowKind }) ||
        openingPresetSpec('window', 'standard', settings, { windowKind: 'single' });
    }

    checkpoint();
    var opening = {
      id: uid(mode === 'door' ? 'd' : 'f'),
      type: mode,
      wallId: hit.wall.id,
      position: Math.max(.02, Math.min(.98, hit.t)),
      widthCm: initial ? initial.widthCm : 80,
      heightCm: initial ? initial.heightCm : (mode === 'door' ? 210 : 120),
      referenceEnd: hit.t <= 0.5 ? 'a' : 'b',
      offsetCm: null,
      presetKey: null
    };

    if (mode === 'door') {
      opening = applyDoorKind(opening, doorKind);
      if (initial) {
        opening.widthCm = initial.widthCm;
        opening.heightCm = initial.heightCm;
      }
    } else {
      var initialWindowKind = normalizeWindowKind(settings.lastWindowKind || settings.lastWindowPreset || 'single');
      opening = applyWindowKind(opening, initialWindowKind, settings);
      if (initial) {
        opening.widthCm = initial.widthCm;
        opening.heightCm = initial.heightCm;
        opening.sillHeightCm = initial.sillHeightCm;
      }
    }

    openings.push(opening);
    openOpeningQuick(opening, true);
    render();
  }

  function openingWall(opening) {
    return opening ? walls.find(function (w) { return w.id === opening.wallId; }) : null;
  }

  function openingCmText(value) {
    return Number.isFinite(Number(value)) ? String(Math.round(Number(value) * 10) / 10).replace('.', ',') : '';
  }

  function parseCmInput(id, allowZero) {
    var raw = String($(id).value || '').trim().replace(',', '.');
    if (!raw) return null;
    var value = Number(raw);
    if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) return NaN;
    return Math.round(value * 10) / 10;
  }

  function renderDoorPresetButtons(opening) {
    var wrap = $('doorPresetWrap');
    if (!wrap || !opening || opening.type !== 'door') return;
    var kind = normalizeDoorKind(opening.doorKind || 'internal');
    var active = openingQuickIsNew ? null : detectOpeningPreset(opening, settings);
    var last = settings.lastDoorKind === kind ? settings.lastDoorPreset : null;
    wrap.innerHTML = '';

    doorPresetKeys(kind).forEach(function (key) {
      var button = document.createElement('button');
      button.type = 'button';
      button.dataset.openingPreset = key;
      if (key === active) button.classList.add('active');
      if (key === last) button.classList.add('last-used');
      button.innerHTML = '<b>' + key + '</b><small>cm</small>';
      wrap.appendChild(button);
    });

    var custom = document.createElement('button');
    custom.type = 'button';
    custom.dataset.openingPreset = 'custom';
    custom.className = 'custom' + (active === 'custom' ? ' active' : '');
    custom.innerHTML = '<b>✎</b><small>PERSONALIZZATA</small>';
    wrap.appendChild(custom);

    document.querySelectorAll('#doorTypeWrap [data-door-kind]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.doorKind === kind);
    });
  }

  function setDoorKind(kind) {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening || opening.type !== 'door') return;
    var normalized = normalizeDoorKind(kind);
    var before = clone(opening);
    var next = applyDoorKind(opening, normalized);
    var preferred = settings.lastDoorKind === normalized && settings.lastDoorPreset
      ? settings.lastDoorPreset
      : preferredDoorPreset(normalized);
    var spec = openingPresetSpec('door', preferred, settings, { doorKind: normalized }) ||
      openingPresetSpec('door', preferredDoorPreset(normalized), settings, { doorKind: normalized }) ||
      openingPresetSpec('door', doorPresetKeys(normalized)[0], settings, { doorKind: normalized });

    if (spec) {
      next.widthCm = spec.widthCm;
      next.heightCm = spec.heightCm;
      next.presetKey = spec.key;
    }
    var wall = openingWall(opening);
    var fit = fitOpeningToWall(next, wall && wall.lengthCm);
    if (!fit.fits) {
      Object.assign(opening, before);
      return toast('Questo tipo di porta non entra nel muro');
    }
    Object.assign(opening, fit.opening);
    syncDoorMotion(opening);
    renderOpeningQuick();
    render();
    vibrate(12);
  }

  function renderWindowTypeButtons(opening) {
    if (!opening || opening.type !== 'window') return;
    var kind = normalizeWindowKind(opening.windowKind || 'single');
    document.querySelectorAll('#windowTypeWrap [data-window-kind]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.windowKind === kind);
    });
    var meta = windowKindSpec(kind, settings);
    $('standardWindowSize').textContent =
      openingCmText(meta.widthCm) + '×' + openingCmText(meta.heightCm) + ' cm' +
      (meta.balconyDoor ? ' · pavimento' : ' · dav. ' + openingCmText(meta.sillHeightCm));
    var detected = openingQuickIsNew ? null : detectOpeningPreset(opening, settings);
    document.querySelectorAll('#windowPresetWrap [data-opening-preset]').forEach(function (button) {
      var key = button.dataset.openingPreset;
      button.classList.toggle('active', key === 'standard' ? detected === kind : detected === 'custom');
      button.classList.toggle('last-used', key === 'standard' && settings.lastWindowKind === kind);
    });
  }

  function setWindowKind(kind) {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening || opening.type !== 'window') return;
    var normalized = normalizeWindowKind(kind);
    var next = applyWindowKind(opening, normalized, settings);
    var wall = openingWall(opening);
    var fit = fitOpeningToWall(next, wall && wall.lengthCm);
    if (!fit.fits) return toast('Questa finestra non entra nel muro');
    Object.assign(opening, fit.opening);
    renderOpeningQuick();
    render();
    vibrate(12);
  }

  function renderOpeningQuick() {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening) return;
    var isDoor = opening.type === 'door';

    if (isDoor) {
      opening.doorKind = normalizeDoorKind(opening.doorKind || (opening.armored ? 'armored' : 'internal'));
      var doorMeta = doorKindSpec(opening.doorKind);
      opening.category = doorMeta.armored ? 'armored' : 'interior';
      opening.leaves = doorMeta.leaves;
      opening.sliding = doorMeta.sliding;
      opening.armored = doorMeta.armored;
      $('openingQuickTitle').textContent = doorMeta.label;
    } else {
      $('openingQuickTitle').textContent = 'Finestra';
    }

    $('openingQuickHint').textContent = isDoor
      ? 'Scegli il tipo e la misura. Subito dopo scegli l’angolo e la distanza fino al bordo della porta.'
      : 'Scegli il tipo. Subito dopo scegli l’angolo e la distanza fino al bordo della finestra.';

    $('doorTypeWrap').classList.toggle('hidden', !isDoor);
    $('doorPresetWrap').classList.toggle('hidden', !isDoor);
    $('windowTypeWrap').classList.toggle('hidden', isDoor);
    $('windowPresetWrap').classList.toggle('hidden', isDoor);
    $('openingAdvancedSillRow').classList.toggle('hidden', isDoor);
    $('deleteOpeningQuickBtn').classList.toggle('hidden', openingQuickIsNew);

    if (isDoor) {
      syncDoorMotion(opening);
      renderDoorPresetButtons(opening);
      renderDoorMotionControls(opening);
    } else {
      opening.windowKind = normalizeWindowKind(opening.windowKind || 'single');
      var windowMeta = windowKindSpec(opening.windowKind, settings);
      opening.leaves = windowMeta.leaves;
      opening.sliding = windowMeta.sliding;
      opening.balconyDoor = windowMeta.balconyDoor;
      if (windowMeta.balconyDoor) opening.sillHeightCm = 0;
      $('openingQuickTitle').textContent = windowMeta.label;
      $('doorSwingControls').classList.add('hidden');
      renderWindowTypeButtons(opening);
    }

    var wall = openingWall(opening);
    var side = openingReferenceLabel(opening);
    var pos = Number.isFinite(opening.offsetCm)
      ? openingCmText(opening.offsetCm) + ' cm dal lato ' + side.toLowerCase()
      : 'posizione dal punto toccato';
    var label = isDoor ? doorKindSpec(opening.doorKind).label : windowKindSpec(opening.windowKind, settings).label;
    $('openingPresetMeta').textContent =
      label + ' · ' + openingCmText(opening.widthCm) + '×' +
      openingCmText(opening.heightCm) + ' cm · ' + pos;

    $('openingAdvancedWidth').value = openingCmText(opening.widthCm);
    $('openingAdvancedHeight').value = openingCmText(
      Number.isFinite(opening.heightCm) ? opening.heightCm : (isDoor ? 210 : 120)
    );
    $('openingAdvancedSill').value = isDoor ? '' : openingCmText(
      Number.isFinite(opening.sillHeightCm) ? opening.sillHeightCm : 90
    );
    $('openingAdvancedOffset').value = Number.isFinite(opening.offsetCm) ? openingCmText(opening.offsetCm) : '';
    $('openingReferenceBtn').textContent = '↔ ORA MISURO DAL LATO ' + side + ' · CAMBIA LATO';
    $('openingAdvancedOffset').placeholder = (!wall || !Number.isFinite(wall.lengthCm))
      ? 'da posizione schizzo'
      : 'automatica';
  }

  function openOpeningQuick(opening, isNew) {
    if (!opening) return;
    currentOpeningId = opening.id;
    openingQuickIsNew = !!isNew;
    openingQuickOriginal = isNew ? null : clone(opening);
    openingCustomFlow = false;
    $('openingAdvanced').open = false;
    renderOpeningQuick();
    $('openingQuickBackdrop').classList.remove('hidden');
  }

  function closeOpeningQuick(cancelNew) {
    $('openingQuickBackdrop').classList.add('hidden');
    if (cancelNew && currentOpeningId) {
      if (openingQuickIsNew) {
        openings = openings.filter(function (o) { return o.id !== currentOpeningId; });
      } else if (openingQuickOriginal) {
        var existing = openings.find(function (o) { return o.id === currentOpeningId; });
        if (existing) Object.assign(existing, clone(openingQuickOriginal));
      }
      surfaceCache = null;
      persistActive();
      render();
    }
    openingQuickIsNew = false;
    openingQuickOriginal = null;
    openingPositionFlow = false;
    if (!openingCustomFlow) currentOpeningId = null;
  }

  function suggestedOpeningOffset(opening, wall) {
    if (!opening || !wall || !Number.isFinite(wall.lengthCm) || wall.lengthCm <= 0 ||
        !Number.isFinite(opening.widthCm)) return null;
    var centerCm = Math.max(0, Math.min(wall.lengthCm, (Number(opening.position) || 0.5) * wall.lengthCm));
    var fromA = centerCm - opening.widthCm / 2;
    var fromB = wall.lengthCm - centerCm - opening.widthCm / 2;
    var value = opening.referenceEnd === 'b' ? fromB : fromA;
    return Math.max(0, Math.min(wall.lengthCm - opening.widthCm, value));
  }

  function startOpeningPositionFromCorner(opening) {
    if (!opening) return;
    var wall = openingWall(opening);
    var suggested = Number.isFinite(opening.offsetCm)
      ? opening.offsetCm
      : suggestedOpeningOffset(opening, wall);
    if (Number.isFinite(suggested)) {
      opening.offsetCm = Math.round(suggested * 10) / 10;
      recalcOpeningPosition(opening);
    }
    openingPositionFlow = true;
    openingCustomFlow = false;
    $('openingQuickBackdrop').classList.add('hidden');
    numberText = Number.isFinite(opening.offsetCm) ? metersText(opening.offsetCm) : '';
    openSheet('opening-offset');
    render();
    toast('Scegli l’angolo e misura fino al bordo dell’apertura');
  }

  function finalizeOpeningPositionFlow(opening) {
    if (!opening) return;
    var key = detectOpeningPreset(opening, settings);
    opening.presetKey = key || 'custom';
    if (opening.type === 'door') {
      var kind = normalizeDoorKind(opening.doorKind || 'internal');
      var meta = doorKindSpec(kind);
      settings.lastDoorKind = kind;
      settings.lastDoorPreset = doorPresetKeys(kind).includes(String(key)) ? String(key) : 'custom';
      if (meta.armored) settings.armoredDoorHeightCm = Number(opening.heightCm) || Number(settings.armoredDoorHeightCm) || 210;
      else settings.doorHeightCm = Number(opening.heightCm) || Number(settings.doorHeightCm) || 210;
    } else {
      settings.lastWindowKind = normalizeWindowKind(opening.windowKind || 'single');
      settings.lastWindowPreset = key === settings.lastWindowKind ? key : 'custom';
    }
    persistSettings();
    surfaceCache = null;
    persistActive();
    openingPositionFlow = false;
    openingCustomFlow = false;
    openingQuickIsNew = false;
    openingQuickOriginal = null;
    currentOpeningId = null;
    closeSheet();
    updateUI();
    render();
    vibrate(22);
    toast((opening.type === 'door' ? 'Porta' : 'Finestra') + ' posizionata da angolo ✓');
  }

  function cancelOpeningPositionFlow() {
    if (!openingPositionFlow) return false;
    var id = currentOpeningId;
    if (openingQuickIsNew) {
      openings = openings.filter(function (o) { return o.id !== id; });
    } else if (openingQuickOriginal) {
      var current = openings.find(function (o) { return o.id === id; });
      if (current) Object.assign(current, clone(openingQuickOriginal));
    }
    openingPositionFlow = false;
    openingCustomFlow = false;
    openingQuickIsNew = false;
    openingQuickOriginal = null;
    currentOpeningId = null;
    surfaceCache = null;
    persistActive();
    closeSheet();
    render();
    toast('Posizionamento annullato');
    return true;
  }

  function applyOpeningPreset(key) {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening) return;
    if (key === 'custom') {
      openingCustomFlow = true;
      $('openingQuickBackdrop').classList.add('hidden');
      numberText = Number.isFinite(opening.widthCm) ? metersText(opening.widthCm) : '';
      openSheet('opening-width');
      toast('Inserisci la larghezza; dopo scegli l’angolo di riferimento');
      return;
    }

    var spec = openingPresetSpec(opening.type, key, settings, {
      doorKind: opening.type === 'door' ? opening.doorKind : null,
      windowKind: opening.type === 'window' ? opening.windowKind : null
    });
    if (!spec) return;
    var wall = openingWall(opening);
    var next = Object.assign({}, opening, {
      widthCm: spec.widthCm,
      heightCm: spec.heightCm,
      presetKey: key
    });
    if (opening.type === 'door') next = applyDoorKind(next, spec.doorKind || opening.doorKind);
    if (opening.type === 'window') {
      next = applyWindowKind(next, spec.windowKind || opening.windowKind, settings);
      next.widthCm = spec.widthCm;
      next.heightCm = spec.heightCm;
      next.sillHeightCm = spec.sillHeightCm;
      next.presetKey = spec.windowKind || opening.windowKind;
    }
    var fit = fitOpeningToWall(next, wall && wall.lengthCm);
    if (!fit.fits) return toast('Questa apertura è più larga del muro');

    if (!openingQuickIsNew) checkpoint();
    Object.assign(opening, fit.opening);
    startOpeningPositionFromCorner(opening);
  }

  function toggleOpeningAdvancedReference() {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening) return;
    var wall = openingWall(opening);
    var changed = offsetForReference(opening, wall && wall.lengthCm, opening.referenceEnd === 'a' ? 'b' : 'a');
    Object.assign(opening, changed);
    renderOpeningQuick();
    render();
  }

  function saveOpeningAdvanced() {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening) return;
    var width = parseCmInput('openingAdvancedWidth', false);
    var height = parseCmInput('openingAdvancedHeight', false);
    var sill = opening.type === 'window' ? parseCmInput('openingAdvancedSill', true) : null;
    var offset = parseCmInput('openingAdvancedOffset', true);
    if (!Number.isFinite(width) || !Number.isFinite(height) || (opening.type === 'window' && !Number.isFinite(sill))) {
      return toast('Controlla larghezza, altezza e davanzale');
    }
    var wall = openingWall(opening);
    if (wall && Number.isFinite(wall.lengthCm) && width > wall.lengthCm) return toast('L’apertura è più larga del muro');

    if (!openingQuickIsNew) checkpoint();
    opening.widthCm = width;
    opening.heightCm = height;
    if (opening.type === 'window') opening.sillHeightCm = sill;

    if (Number.isFinite(offset)) {
      if (wall && Number.isFinite(wall.lengthCm) && offset + width > wall.lengthCm) return toast('Distanza + apertura supera il muro');
      opening.offsetCm = offset;
      recalcOpeningPosition(opening);
    } else {
      var fit = fitOpeningToWall(opening, wall && wall.lengthCm);
      if (fit.fits) Object.assign(opening, fit.opening);
    }

    var key = detectOpeningPreset(opening, settings);
    opening.presetKey = key || 'custom';
    if (opening.type === 'door') {
      var doorKind = normalizeDoorKind(opening.doorKind || 'internal');
      var doorMeta = doorKindSpec(doorKind);
      settings.lastDoorKind = doorKind;
      settings.lastDoorPreset = doorPresetKeys(doorKind).includes(String(key)) ? String(key) : 'custom';
      if (doorMeta.armored) settings.armoredDoorHeightCm = height;
      else settings.doorHeightCm = height;
    } else {
      settings.lastWindowKind = normalizeWindowKind(opening.windowKind || 'single');
      settings.lastWindowPreset = key === settings.lastWindowKind ? key : 'custom';
    }
    persistSettings();
    surfaceCache = null;
    persistActive();
    openingQuickIsNew = false;
    openingQuickOriginal = null;
    currentOpeningId = null;
    $('openingQuickBackdrop').classList.add('hidden');
    updateUI();
    render();
    toast('Apertura aggiornata ✓');
  }

  function cancelOpeningCustomFlow() {
    if (!openingCustomFlow) return false;
    var id = currentOpeningId;
    if (openingQuickIsNew) {
      openings = openings.filter(function (o) { return o.id !== id; });
    } else if (openingQuickOriginal) {
      var current = openings.find(function (o) { return o.id === id; });
      if (current) Object.assign(current, clone(openingQuickOriginal));
    }
    openingCustomFlow = false;
    openingQuickIsNew = false;
    openingQuickOriginal = null;
    currentOpeningId = null;
    surfaceCache = null;
    persistActive();
    closeSheet();
    render();
    toast('Modifica annullata');
    return true;
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

  function updateCornerChoiceState(opening) {
    var wrap = $('cornerChoiceWrap');
    if (!wrap) return;
    if (!opening || sheetType !== 'opening-offset') {
      wrap.classList.add('hidden');
      return;
    }
    var wall = openingWall(opening);
    if (!wall) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    var leftEnd = wallEndForVisualSide(wall, 'left');
    var rightEnd = wallEndForVisualSide(wall, 'right');
    $('cornerLeftBtn').classList.toggle('active', opening.referenceEnd === leftEnd);
    $('cornerRightBtn').classList.toggle('active', opening.referenceEnd === rightEnd);
  }

  function setOpeningReferenceVisual(side) {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening) return;
    var wall = openingWall(opening);
    if (!wall) return;
    var nextEnd = wallEndForVisualSide(wall, side === 'right' ? 'right' : 'left');
    if (opening.referenceEnd === nextEnd) {
      updateCornerChoiceState(opening);
      return;
    }
    var changed = offsetForReference(opening, wall.lengthCm, nextEnd);
    Object.assign(opening, changed);
    persistActive();
    numberText = Number.isFinite(opening.offsetCm) ? metersText(opening.offsetCm) : '';
    updateSheetValue();
    updateCornerChoiceState(opening);
    render();
    vibrate(12);
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
    numberText = target.lengthCm ? metersText(target.lengthCm) : '';
    openSheet('wall');
    render();
  }

  function openSheet(type) {
    sheetType = type;
    $('sheetBackdrop').classList.remove('hidden');
    $('deleteOpeningBtn').classList.toggle('hidden', type === 'wall' || (type === 'diagonal' && !currentDiagonalId));
    $('deleteOpeningBtn').textContent = type === 'diagonal' ? '🗑 ELIMINA QUOTA' : '🗑 ELIMINA APERTURA';
    if (type === 'diagonal') {
      $('sheetKicker').textContent = 'QUOTA TRA I DUE PUNTI';
      $('cornerToggleBtn').classList.add('hidden');
    } else if (type === 'wall') {
      var idx = walls.findIndex(function (w) { return w.id === selectedWallId; });
      $('sheetKicker').textContent = 'MISURA MURO ' + (idx + 1) + ' DI ' + walls.length;
    } else {
      var o = openings.find(function (x) { return x.id === currentOpeningId; });
      if (type === 'opening-width') {
        $('sheetKicker').textContent = o && o.type === 'door' ? 'LARGHEZZA PORTA' : 'LARGHEZZA FINESTRA';
        $('cornerToggleBtn').classList.add('hidden');
      } else if (type === 'opening-height') {
        $('sheetKicker').textContent = o && o.type === 'door' ? 'ALTEZZA PORTA' : 'ALTEZZA FINESTRA';
        $('cornerToggleBtn').classList.add('hidden');
      } else if (type === 'opening-sill') {
        $('sheetKicker').textContent = 'ALTEZZA DAVANZALE DAL PAVIMENTO';
        $('cornerToggleBtn').classList.add('hidden');
      } else if (type === 'opening-offset') {
        var side = openingReferenceLabel(o);
        $('sheetKicker').textContent = 'DA ANGOLO ' + side + ' → PRIMO BORDO ' + (o && o.type === 'door' ? 'PORTA' : 'FINESTRA');
        $('cornerToggleBtn').classList.add('hidden');
        updateCornerChoiceState(o);
      }
    }
    if (type !== 'opening-offset') $('cornerChoiceWrap').classList.add('hidden');
    if (type === 'wall') $('cornerToggleBtn').classList.add('hidden');
    updateSheetValue();
  }

  function closeSheet() {
    sheetType = null;
    $('sheetBackdrop').classList.add('hidden');
    $('cornerToggleBtn').classList.add('hidden');
    $('cornerChoiceWrap').classList.add('hidden');
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
    } else if (numberText.length < 7) numberText += key;
    updateSheetValue();
  }

  function confirmSheet() {
    var meters = Number(numberText.replace(',', '.'));
    var zeroOk = sheetType === 'opening-offset' || sheetType === 'opening-sill';
    if (!numberText.trim() || !Number.isFinite(meters) || (zeroOk ? meters < 0 : meters <= 0)) return toast('Inserisci una misura');

    if (sheetType === 'wall') {
      checkpoint();
      var wall = walls.find(function (w) { return w.id === selectedWallId; });
      if (wall) {
        wall.lengthCm = metersToCm(meters);
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
      var op = openings.find(function (o) { return o.id === currentOpeningId; });
      var newWidth = metersToCm(meters);
      var opWall = openingWall(op);
      if (opWall && Number.isFinite(opWall.lengthCm) && newWidth > opWall.lengthCm) return toast('L’apertura è più larga del muro');
      if (!openingQuickIsNew) checkpoint();
      if (op) {
        op.widthCm = newWidth;
        op.presetKey = 'custom';
        if (!Number.isFinite(op.heightCm)) op.heightCm = op.type === 'door' ? (Number(settings.doorHeightCm) || 210) : 120;
        if (op.type === 'window' && !Number.isFinite(op.sillHeightCm)) op.sillHeightCm = 90;
        var quickFit = fitOpeningToWall(op, opWall && opWall.lengthCm);
        if (quickFit.fits) Object.assign(op, quickFit.opening);
      }
      surfaceCache = null;
      if (openingCustomFlow) {
        persistActive();
        openingCustomFlow = false;
        startOpeningPositionFromCorner(op);
        return;
      }
      persistActive();
      numberText = op && Number.isFinite(op.offsetCm) ? metersText(op.offsetCm) : '';
      openSheet('opening-offset');
      render();
      toast('Ora misura dall’angolo al bordo');
      return;
    } else if (sheetType === 'opening-offset') {
      checkpoint();
      var op2 = openings.find(function (o) { return o.id === currentOpeningId; });
      if (op2) {
        var ow = walls.find(function (w) { return w.id === op2.wallId; });
        var offsetCm = metersToCm(meters);
        if (ow && ow.lengthCm && offsetCm + op2.widthCm > ow.lengthCm) {
          toast('Non entra nel muro: riduci la distanza');
          vibrate(80);
          return;
        }
        op2.offsetCm = offsetCm;
        recalcOpeningPosition(op2);
        surfaceCache = null;
      }
      persistActive();
      if (op2 && openingPositionFlow) {
        finalizeOpeningPositionFlow(op2);
        return;
      }
      if (op2) {
        numberText = metersText(Number.isFinite(op2.heightCm) ? op2.heightCm : (op2.type === 'door' ? 210 : 120));
        openSheet('opening-height');
        render();
        return;
      }
      currentOpeningId = null;
      closeSheet();
    } else if (sheetType === 'opening-height') {
      checkpoint();
      var op3 = openings.find(function (o) { return o.id === currentOpeningId; });
      if (op3) op3.heightCm = metersToCm(meters);
      persistActive();
      if (op3 && op3.type === 'window') {
        numberText = metersText(Number.isFinite(op3.sillHeightCm) ? op3.sillHeightCm : 90);
        openSheet('opening-sill');
        return;
      }
      currentOpeningId = null;
      closeSheet();
    } else if (sheetType === 'opening-sill') {
      checkpoint();
      var op4 = openings.find(function (o) { return o.id === currentOpeningId; });
      if (op4) op4.sillHeightCm = metersToCm(meters);
      currentOpeningId = null;
      persistActive();
      closeSheet();
    } else if (sheetType === 'diagonal') {
      saveDiagonalLength(metersToCm(meters));
      return;
    }
    updateUI();
    render();
  }

  function later() {
    if (openingPositionFlow && sheetType === 'opening-offset') return cancelOpeningPositionFlow();
    if (openingCustomFlow && sheetType === 'opening-width') return cancelOpeningCustomFlow();
    if (sheetType === 'diagonal') {
      pendingQuote = null;
      currentDiagonalId = null;
      closeSheet();
      render();
      return;
    }
    if (sheetType === 'wall') {
      selectedWallId = null;
      closeSheet();
    } else {
      currentOpeningId = null;
      closeSheet();
    }
  }

  function planPayload(plan) {
    // il contratto v4 resta invariato; notes: plan.notes || [] e i campi v2 li aggiunge plan-payload.js
    return buildPlanPayload(Object.assign({}, plan, { notes: plan.notes || [] }), { summary: summary(plan) });
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
      toast('Mancano ' + missing.length + ' misure: completa o usa CALCOLO PROFESSIONALE');
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
    viewPanX = 0;
    viewPanY = 0;
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

  function parseRoomMeters(value) {
    var n = Number(String(value || '').trim().replace(',', '.'));
    return Number.isFinite(n) && n >= 0.40 && n <= 30 ? n : null;
  }

  function openRectRoomModal() {
    closeTools();
    cancelPickModes();
    clearSelection(false);
    $('rectRoomBackdrop').classList.remove('hidden');
    setTimeout(function () { $('rectRoomWidth').focus(); }, 60);
  }

  function closeRectRoomModal() {
    $('rectRoomBackdrop').classList.add('hidden');
  }

  function setRectRoomPreset(widthM, heightM) {
    $('rectRoomWidth').value = Number(widthM).toFixed(2).replace('.', ',');
    $('rectRoomHeight').value = Number(heightM).toFixed(2).replace('.', ',');
  }

  function swapRectRoomSides() {
    var a = $('rectRoomWidth').value;
    $('rectRoomWidth').value = $('rectRoomHeight').value;
    $('rectRoomHeight').value = a;
  }

  function updateRoomPlacementBar() {
    var bar = $('roomPlacementBar');
    if (!roomPlacementMode || !roomDraft) {
      bar.classList.add('hidden');
      return;
    }
    $('roomPlacementLabel').textContent =
      String(roomDraft.name || 'Ambiente').toUpperCase() + ' · ' +
      roomDraft.widthM.toFixed(2).replace('.', ',') + ' × ' +
      roomDraft.heightM.toFixed(2).replace('.', ',') + ' m';
    bar.classList.remove('hidden');
  }

  function startRectRoomPlacement() {
    var widthM = parseRoomMeters($('rectRoomWidth').value);
    var heightM = parseRoomMeters($('rectRoomHeight').value);
    if (!widthM || !heightM) return toast('Inserisci misure tra 0,40 e 30 m');
    var name = ($('rectRoomName').value.trim() || 'Ambiente').slice(0, 40);

    closeRectRoomModal();
    cancelPickModes();
    roomPlacementMode = true;
    roomDraft = {
      name: name,
      widthM: widthM,
      heightM: heightM,
      center: screenToWorld(viewCenter()),
      dragging: false
    };
    updateRoomPlacementBar();
    render();
    toast('Trascina la stanza e rilasciala dove vuoi');
    vibrate(18);
  }

  function rotateRectRoomPlacement() {
    if (!roomDraft) return;
    var temp = roomDraft.widthM;
    roomDraft.widthM = roomDraft.heightM;
    roomDraft.heightM = temp;
    updateRoomPlacementBar();
    render();
    vibrate(12);
  }

  function cancelRectRoomPlacement(announce) {
    if (!roomPlacementMode && !roomDraft) return;
    roomPlacementMode = false;
    roomDraft = null;
    activePointerId = null;
    $('roomPlacementBar').classList.add('hidden');
    render();
    if (announce !== false) toast('Posizionamento annullato');
  }

  function drawRectRoomPreview() {
    if (!roomPlacementMode || !roomDraft || !roomDraft.center) return;
    var snapped = snapRectRoomCenter(
      roomDraft.center,
      roomDraft.widthM,
      roomDraft.heightM,
      walls,
      30 / viewZoom
    );
    var geom = rectRoomGeometry(snapped.center, roomDraft.widthM, roomDraft.heightM);
    var pts = geom.corners.map(worldToScreen);

    ctx.save();
    ctx.fillStyle = 'rgba(37,99,235,.10)';
    ctx.strokeStyle = snapped.snapped ? '#16a34a' : '#2563eb';
    ctx.lineWidth = 3;
    ctx.setLineDash([9, 7]);
    ctx.beginPath();
    pts.forEach(function (p, i) {
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    var c = worldToScreen(snapped.center);
    var text = roomDraft.widthM.toFixed(2).replace('.', ',') + ' × ' + roomDraft.heightM.toFixed(2).replace('.', ',') + ' m';
    ctx.font = '1000 13px system-ui';
    var tw = ctx.measureText(text).width + 20;
    ctx.fillStyle = 'rgba(255,255,255,.96)';
    ctx.strokeStyle = '#bfdbfe';
    ctx.lineWidth = 1.5;
    roundRect(c.x - tw / 2, c.y - 19, tw, 38, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1d4ed8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, c.x, c.y);
    if (snapped.snapped) {
      ctx.fillStyle = '#16a34a';
      ctx.beginPath();
      var sp = worldToScreen(snapped.target);
      ctx.arc(sp.x, sp.y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function commitRectRoom(center) {
    if (!roomDraft) return;
    var draft = clone(roomDraft);
    var snapped = snapRectRoomCenter(center, draft.widthM, draft.heightM, walls, 30 / viewZoom);
    var geom = rectRoomGeometry(snapped.center, draft.widthM, draft.heightM);

    checkpoint();
    var strokeId = uid('room-stroke');
    var roomId = uid('room');
    var wallIds = [];
    var stroke = {
      id: strokeId,
      raw: geom.closed.map(function (p) { return { x: p.x, y: p.y }; }),
      simplified: geom.closed.map(function (p) { return { x: p.x, y: p.y }; }),
      wallIds: [],
      source: 'room-template'
    };

    geom.segments.forEach(function (seg, idx) {
      var wallId = uid('w');
      wallIds.push(wallId);
      stroke.wallIds.push(wallId);
      walls.push({
        id: wallId,
        strokeId: strokeId,
        a: { x: seg.a.x, y: seg.a.y },
        b: { x: seg.b.x, y: seg.b.y },
        lengthCm: seg.lengthCm,
        source: 'room-template',
        templateRoomId: roomId,
        templateSide: idx
      });
    });
    rawStrokes.push(stroke);

    var sortedWallIds = wallIds.slice().sort();
    rooms.push({
      id: roomId,
      name: draft.name,
      wallIds: sortedWallIds,
      faceKey: sortedWallIds.join('|'),
      custom: true,
      source: 'room-template',
      widthCm: Math.round(draft.widthM * 100),
      heightCm: Math.round(draft.heightM * 100)
    });

    roomPlacementMode = false;
    roomDraft = null;
    activePointerId = null;
    $('roomPlacementBar').classList.add('hidden');
    surfaceCache = null;
    refreshSurfaceCache();
    persistActive();
    updateUI();
    render();
    vibrate(30);
    toast(draft.name + ' ' + draft.widthM.toFixed(2).replace('.', ',') + ' × ' + draft.heightM.toFixed(2).replace('.', ',') + ' m creata ✓');
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
    $('roomHeightInput').value = existing && existing.heightCm ? metersText(existing.heightCm) : '';
    $('roomTilingInput').value = existing && existing.tilingHeightCm ? metersText(existing.tilingHeightCm) : '';
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
    $('roomHeightInput').value = '';
    $('roomTilingInput').value = '';
    document.querySelectorAll('[data-room-name]').forEach(function (b) { b.classList.remove('selected'); });
  }

  function parseMetersInput(value) {
    var n = Number(String(value || '').trim().replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
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
    room.type = roomTypeFromName(name);
    var roomH = parseMetersInput($('roomHeightInput').value);
    var roomT = parseMetersInput($('roomTilingInput').value);
    if (roomH) room.heightCm = metersToCm(roomH); else delete room.heightCm;
    if (roomT) room.tilingHeightCm = metersToCm(roomT); else delete room.tilingHeightCm;
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
    var serverResult = authoritativeResult(currentPlan());
    if (serverResult) {
      toast('Mostro il calcolo autorevole del server');
      return openResult(activePlanId);
    }
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

  function drawSelectionOverlay() {
    if (mode !== 'select' || !selectedEntity || selectedEntity.type !== 'room') return;
    var face = faceForWallIds(selectedEntity.wallIds);
    if (!face || !face.polygon || face.polygon.length < 3) return;
    ctx.save();
    ctx.fillStyle = 'rgba(37,99,235,.14)';
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 4;
    ctx.setLineDash([10, 6]);
    ctx.beginPath();
    face.polygon.forEach(function (p, i) {
      var sp = worldToScreen(p);
      if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
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
    var serverResult = authoritativeResult(currentPlan());
    if (serverResult) {
      toast('Presentazione dal risultato autorevole del server');
      return openResult(activePlanId);
    }
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

  function nativePlugin(name) {
    try {
      return window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins[name] : null;
    } catch (_) { return null; }
  }

  function persistSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 6000) : null;
    var opts = Object.assign({}, options || {});
    if (controller) opts.signal = controller.signal;
    try {
      return await fetch(url, opts);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function probeServer(url, key) {
    var api = normalizeBackendApiUrl(url);
    if (!api) throw new Error('Indirizzo backend mancante');
    var hasKey = !!String(key || '').trim();
    var endpoint = hasKey ? api + '/health' : backendRootFromApi(api) + '/healthz';
    var headers = hasKey ? { 'X-GE360-API-Key': String(key).trim() } : {};
    var started = Date.now();
    var res = await fetchWithTimeout(endpoint, { headers: headers }, 6000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return {
      reachable: true,
      authenticated: hasKey,
      latencyMs: Math.max(0, Date.now() - started),
      status: res.status
    };
  }

  function diagnosticSetRow(name, state, value, detail) {
    var row = $('diag' + name);
    var valueEl = $('diag' + name + 'Value');
    var textEl = $('diag' + name + 'Text');
    if (!row || !valueEl || !textEl) return;
    row.className = 'diag-row ' + (state || 'checking');
    valueEl.textContent = value || '…';
    textEl.textContent = detail || '';
  }

  function diagnosticOverall(state, icon, title, text) {
    $('diagOverall').className = 'diag-overall ' + state;
    $('diagOverallIcon').textContent = icon;
    $('diagOverallTitle').textContent = title;
    $('diagOverallText').textContent = text;
  }

  function latestDiagnosticPlan() {
    return library
      .filter(function (plan) { return plan && plan.backend && (plan.backend.planId || plan.id) && plan.backend.result; })
      .sort(function (a, b) {
        return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
      })[0] || null;
  }

  async function looksLikePdf(blob) {
    if (!blob || blob.size < 5) return false;
    try {
      var head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
      return String.fromCharCode.apply(null, Array.from(head)) === '%PDF-';
    } catch (_) {
      return blob.type === 'application/pdf';
    }
  }

  function openConnectionDiagnostics() {
    closeSettings();
    $('connectionDiagBackdrop').classList.remove('hidden');
    $('diagServerUrl').textContent = settings.serverUrl || '—';
    $('diagBridgeAddress').textContent = settings.bridgeAddress || '—';
    $('diagBridgeEndpoint').textContent = settings.bridgeEndpoint || '—';
    runConnectionDiagnostics();
  }

  function closeConnectionDiagnostics() {
    $('connectionDiagBackdrop').classList.add('hidden');
  }

  async function refreshConnectionIndicator() {
    if (!settings.serverUrl || connectionState.checking) {
      updateServerBadge();
      return;
    }
    connectionState.checking = true;
    updateServerBadge();
    try {
      var probe = await probeServer(settings.serverUrl, settings.apiKey);
      connectionState.checked = true;
      connectionState.reachable = true;
      connectionState.authenticated = probe.authenticated;
      connectionState.apiOk = probe.authenticated;
      connectionState.latencyMs = probe.latencyMs;
      connectionState.checkedAt = new Date().toISOString();
      connectionState.error = null;
    } catch (e) {
      connectionState.checked = true;
      connectionState.reachable = false;
      connectionState.authenticated = false;
      connectionState.apiOk = false;
      connectionState.latencyMs = null;
      connectionState.checkedAt = new Date().toISOString();
      connectionState.error = e && e.message ? e.message : String(e);
    } finally {
      connectionState.checking = false;
      updateServerBadge();
    }
  }

  async function runConnectionDiagnostics() {
    if (connectionState.checking && !$('connectionDiagBackdrop').classList.contains('hidden')) return;
    connectionState.checking = true;
    connectionState.pdfOk = null;
    updateServerBadge();
    $('runConnectionDiagBtn').disabled = true;
    $('diagAdvice').classList.add('hidden');
    diagnosticOverall('checking', '…', 'Controllo connessione…', 'Verifico tunnel, backend, API e canale PDF.');
    ['Bridge','Backend','Auth','Api','Pdf'].forEach(function (name) {
      diagnosticSetRow(name, 'checking', '…', 'Controllo in corso…');
    });
    $('diagServerUrl').textContent = settings.serverUrl || '—';
    $('diagBridgeAddress').textContent = settings.bridgeAddress || '—';
    $('diagBridgeEndpoint').textContent = settings.bridgeEndpoint || '—';
    $('diagLatency').textContent = '—';

    var bridgeOk = false;
    var backendOk = false;
    var authOk = false;
    var apiOk = false;
    var pdfOk = null;
    var advice = '';

    try {
      var tunnel = nativePlugin('GE360Tunnel');
      if (tunnel) {
        try {
          var bridgeState = await tunnel.restore();
          settings.bridgeConfigured = !!bridgeState.configured || !!settings.bridgeConfigured;
          settings.bridgeConnected = !!bridgeState.connected;
          bridgeOk = !!bridgeState.connected;
          persistSettings();
          diagnosticSetRow(
            'Bridge',
            bridgeOk ? 'ok' : settings.bridgeConfigured ? 'warn' : 'fail',
            bridgeOk ? 'ATTIVO' : settings.bridgeConfigured ? 'FERMO' : 'ASSENTE',
            bridgeOk ? 'Tunnel WireGuard GE360 attivo sul telefono.' :
              settings.bridgeConfigured ? 'Profilo presente, ma il tunnel non risulta connesso.' :
              'Nessun profilo Direct Bridge configurato.'
          );
        } catch (bridgeError) {
          diagnosticSetRow('Bridge', 'fail', 'ERRORE', bridgeError && bridgeError.message ? bridgeError.message : 'Impossibile leggere lo stato del tunnel.');
        }
      } else {
        diagnosticSetRow('Bridge', settings.serverUrl ? 'warn' : 'fail', 'N/D',
          settings.serverUrl ? 'Plugin tunnel non disponibile qui; provo comunque il backend configurato.' : 'Plugin Direct Bridge non disponibile.');
      }

      var api = normalizeBackendApiUrl(settings.serverUrl);
      if (!api) {
        diagnosticSetRow('Backend', 'fail', 'NO URL', 'Backend non configurato.');
        diagnosticSetRow('Auth', 'fail', 'NO URL', 'Prima configura il server.');
        diagnosticSetRow('Api', 'fail', 'NO URL', 'Prima configura il server.');
        diagnosticSetRow('Pdf', 'warn', 'NON TESTATO', 'Serve prima una connessione al backend.');
        advice = 'Configura il backend o scansiona il QR GE360. Finché manca l’indirizzo del server, la dashboard non può verificare una connessione reale.';
        throw new Error('Backend non configurato');
      }

      var root = backendRootFromApi(api);
      var started = Date.now();
      try {
        var healthz = await fetchWithTimeout(root + '/healthz', {}, 8000);
        if (!healthz.ok) throw new Error('HTTP ' + healthz.status);
        var latency = Math.max(0, Date.now() - started);
        backendOk = true;
        connectionState.latencyMs = latency;
        $('diagLatency').textContent = latency + ' ms';
        diagnosticSetRow('Backend', 'ok', 'ONLINE', 'Il server Debian risponde a /healthz in ' + latency + ' ms.');
      } catch (backendError) {
        diagnosticSetRow('Backend', 'fail', 'OFFLINE',
          backendError && backendError.name === 'AbortError' ? 'Timeout: il server non risponde.' :
          'Nessuna risposta dal backend: ' + (backendError && backendError.message ? backendError.message : backendError));
        advice = bridgeOk
          ? 'Il tunnel risulta attivo, ma il backend non risponde sulla porta 9888. Controlla il servizio ge360-rilievi-backend e il firewall del server.'
          : 'Il telefono non raggiunge il backend. Riconnetti il Direct Bridge e riprova.';
      }

      if (!backendOk) {
        diagnosticSetRow('Auth', 'fail', 'NON TESTATA', 'Il backend deve essere raggiungibile prima del controllo API Key.');
        diagnosticSetRow('Api', 'fail', 'NON TESTATA', 'Il backend deve essere raggiungibile prima del test API.');
        diagnosticSetRow('Pdf', 'warn', 'NON TESTATO', 'Il backend deve essere raggiungibile prima del test PDF.');
      } else if (!String(settings.apiKey || '').trim()) {
        diagnosticSetRow('Auth', 'warn', 'MANCANTE', 'Il server risponde, ma non è configurata una API Key.');
        diagnosticSetRow('Api', 'warn', 'BLOCCATA', 'Le API protette richiedono la chiave.');
        diagnosticSetRow('Pdf', 'warn', 'BLOCCATO', 'Il PDF richiede accesso autenticato.');
        advice = 'Il server è raggiungibile, ma manca la API Key. Scansiona di nuovo il QR o inserisci la chiave nelle impostazioni.';
      } else {
        try {
          var authStart = Date.now();
          var authRes = await fetchWithTimeout(api + '/health', {
            headers: { 'X-GE360-API-Key': String(settings.apiKey).trim() }
          }, 8000);
          if (!authRes.ok) {
            if (authRes.status === 401) throw new Error('API Key rifiutata (HTTP 401)');
            throw new Error('HTTP ' + authRes.status);
          }
          authOk = true;
          diagnosticSetRow('Auth', 'ok', 'VALIDA', 'Autenticazione accettata in ' + Math.max(0, Date.now() - authStart) + ' ms.');
        } catch (authError) {
          diagnosticSetRow('Auth', 'fail', 'RIFIUTATA', authError && authError.message ? authError.message : String(authError));
          advice = 'Il server risponde, ma la API Key non viene accettata. Rigenera o riscansiona il profilo GE360.';
        }

        if (authOk) {
          try {
            var catalog = await backendClient().fetchWorkCatalog();
            if (!catalog) throw new Error('Risposta vuota');
            apiOk = true;
            diagnosticSetRow('Api', 'ok', 'OK', 'Scambio dati JSON con le API GE360 riuscito.');
          } catch (apiError) {
            diagnosticSetRow('Api', 'fail', 'ERRORE', apiError && apiError.message ? apiError.message : String(apiError));
            advice = 'Health e autenticazione funzionano, ma una API operativa fallisce. Controlla la versione del backend o i log del servizio.';
          }

          var plan = latestDiagnosticPlan();
          if (!plan) {
            diagnosticSetRow('Pdf', 'warn', 'NESSUN TEST', 'Non c’è ancora un rilievo con PDF da usare come prova.');
          } else {
            var remotePlanId = plan.backend.planId || plan.id;
            try {
              var status = await backendClient().request('/plans/' + encodeURIComponent(remotePlanId), { timeout: 10000 });
              if (!status || !status.files || !status.files.pdf) {
                diagnosticSetRow('Pdf', 'warn', 'NON CREATO', 'Il rilievo più recente non espone ancora plan.pdf.');
              } else {
                var pdfBlob = await backendClient().request('/plans/' + encodeURIComponent(remotePlanId) + '/pdf', {
                  as: 'blob',
                  timeout: 20000
                });
                pdfOk = await looksLikePdf(pdfBlob);
                if (!pdfOk) throw new Error('La risposta ricevuta non è un PDF valido');
                diagnosticSetRow('Pdf', 'ok', 'OK', 'Download PDF riuscito · ' + Math.max(1, Math.round(pdfBlob.size / 1024)) + ' KB.');
              }
            } catch (pdfError) {
              pdfOk = false;
              diagnosticSetRow('Pdf', 'fail', 'ERRORE', pdfError && pdfError.message ? pdfError.message : String(pdfError));
              if (apiOk) advice = 'Il backend e le API comunicano correttamente, ma il canale PDF fallisce. Il problema è isolato al download di plan.pdf, non alla connessione generale.';
            }
          }
        } else {
          diagnosticSetRow('Api', 'warn', 'BLOCCATA', 'Prima deve riuscire l’autenticazione.');
          diagnosticSetRow('Pdf', 'warn', 'BLOCCATO', 'Prima deve riuscire l’autenticazione.');
        }
      }

      connectionState.checked = true;
      connectionState.reachable = backendOk;
      connectionState.authenticated = authOk;
      connectionState.apiOk = apiOk;
      connectionState.pdfOk = pdfOk;
      connectionState.checkedAt = new Date().toISOString();
      connectionState.error = backendOk ? null : 'Backend non raggiungibile';

      if (backendOk && authOk && apiOk && pdfOk !== false) {
        diagnosticOverall('ok', '✓', 'GE360 è connesso', pdfOk === true
          ? 'Bridge/backend/API/PDF comunicano correttamente.'
          : 'Backend e API comunicano correttamente. Non c’è un PDF disponibile per il test.');
      } else if (backendOk && (authOk || !settings.apiKey)) {
        diagnosticOverall('warn', '!', 'Connessione parziale', pdfOk === false
          ? 'Il server comunica, ma il PDF ha un problema separato.'
          : 'Il server risponde, ma non tutti i controlli sono riusciti.');
      } else {
        diagnosticOverall('fail', '×', 'GE360 non è connesso completamente', 'Segui il controllo rosso qui sotto per capire dove si interrompe.');
      }
    } catch (_) {
      connectionState.checked = true;
      connectionState.reachable = backendOk;
      connectionState.authenticated = authOk;
      connectionState.apiOk = apiOk;
      connectionState.pdfOk = pdfOk;
      connectionState.checkedAt = new Date().toISOString();
      if (!backendOk) diagnosticOverall('fail', '×', 'Backend non raggiungibile', 'La configurazione esiste, ma il telefono non riceve risposta dal server.');
    } finally {
      connectionState.checking = false;
      $('runConnectionDiagBtn').disabled = false;
      $('diagLastTest').textContent = new Date().toLocaleString('it-IT');
      $('diagServerUrl').textContent = settings.serverUrl || '—';
      $('diagBridgeAddress').textContent = settings.bridgeAddress || '—';
      $('diagBridgeEndpoint').textContent = settings.bridgeEndpoint || '—';
      if (advice) {
        $('diagAdvice').textContent = advice;
        $('diagAdvice').classList.remove('hidden');
      }
      updateServerBadge();
      renderBridgeSettings();
    }
  }

  function renderBridgeSettings() {
    var badge = $('bridgeStatus');
    var meta = $('bridgeMeta');
    var reconnect = $('reconnectBridgeBtn');
    var disconnect = $('disconnectBridgeBtn');
    if (!badge || !meta) return;

    badge.className = 'bridge-status ' + (settings.bridgeConnected ? 'connected' : settings.bridgeConfigured ? 'configured' : '');
    badge.textContent = settings.bridgeConnected ? 'COLLEGATO' : settings.bridgeConfigured ? 'CONFIGURATO' : 'NON COLLEGATO';

    var details = [];
    if (settings.bridgeAddress) details.push('VPN ' + settings.bridgeAddress);
    if (settings.bridgeEndpoint) details.push('Endpoint ' + settings.bridgeEndpoint);
    if (settings.serverUrl) details.push('Backend ' + settings.serverUrl);
    if (settings.bridgeConfigured && !settings.apiKey) details.push('API key da inserire');
    meta.textContent = details.join(' · ');
    meta.classList.toggle('hidden', !details.length);
    reconnect.classList.toggle('hidden', !settings.bridgeConfigured || settings.bridgeConnected);
    disconnect.classList.toggle('hidden', !settings.bridgeConnected);
  }


  function renderLaserState(state) {
    var badge = $('laserStatus');
    var disconnect = $('disconnectLaserBtn');
    if (!badge) return;
    var configured = !!(state && state.configured);
    laserConnected = !!(state && state.connected);
    badge.className = 'bridge-status ' + (laserConnected ? 'connected' : configured ? 'configured' : '');
    badge.textContent = laserConnected ? 'COLLEGATO' : configured ? 'CONFIGURATO' : 'NON COLLEGATO';
    disconnect.classList.toggle('hidden', !laserConnected);
    if (state && state.name) {
      settings.laserName = state.name;
      settings.laserVendor = state.vendor || '';
      settings.laserAddress = state.address || '';
      persistSettings();
    }
  }

  async function initLaser() {
    if (!laserAvailable() || laserListenerReady) return;
    laserListenerReady = true;
    try {
      await listenLaser(function (reading) {
        var mm = Number(reading && reading.distanceMm);
        if (!Number.isFinite(mm) || mm <= 0) return;
        var text = (mm / 1000).toFixed(3).replace('.', ',') + ' m';
        $('laserLastMeasurement').textContent = 'Ultima misura: ' + text + (reading.name ? ' · ' + reading.name : '');
        $('laserLastMeasurement').classList.remove('hidden');
        var accepts = ['wall','opening-width','opening-offset','opening-height','opening-sill','diagonal'];
        if (sheetType && accepts.indexOf(sheetType) !== -1 && !$('sheetBackdrop').classList.contains('hidden')) {
          numberText = metersText(mm / 10);
          updateSheetValue();
          vibrate(35);
          toast('Laser: ' + text + ' inserito ✓');
        } else {
          toast('Laser: ' + text + ' · apri una misura per inserirla');
        }
      }, renderLaserState, function (e) {
        if (e && e.message) toast(e.message);
      });
      var state = await restoreLaserDevice();
      if (state) renderLaserState(state);
    } catch (_) {}
  }

  async function scanLaser() {
    if (!laserAvailable()) return toast('Metro laser disponibile nell APK Android GE360');
    var btn = $('scanLaserBtn');
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'RICERCA 5 SEC…';
    try {
      laserDevices = await scanLaserDevices();
      var select = $('laserDeviceSelect');
      select.innerHTML = '';
      laserDevices.forEach(function (device, idx) {
        var option = document.createElement('option');
        option.value = String(idx);
        option.textContent = (device.vendor === 'leica' ? 'Leica · ' : device.vendor === 'bosch' ? 'Bosch · ' : '') + device.name + ' · ' + device.rssi + ' dBm';
        select.appendChild(option);
      });
      select.classList.toggle('hidden', !laserDevices.length);
      $('connectLaserBtn').classList.toggle('hidden', !laserDevices.length);
      toast(laserDevices.length ? laserDevices.length + ' metro laser trovati' : 'Nessun metro laser compatibile trovato');
    } catch (e) {
      toast('Laser: ' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  async function connectSelectedLaser() {
    var idx = Number($('laserDeviceSelect').value);
    var device = laserDevices[idx];
    if (!device) return toast('Seleziona un metro laser');
    try {
      var state = await connectLaserDevice(device);
      renderLaserState(Object.assign({}, state, device));
      toast('Connessione laser avviata');
    } catch (e) { toast('Laser: ' + (e.message || e)); }
  }

  async function disconnectLaser() {
    try {
      var state = await disconnectLaserDevice();
      renderLaserState(state || {});
      toast('Metro laser disconnesso');
    } catch (_) {}
  }

  function openSettings() {
    $('serverUrl').value = settings.serverUrl || '';
    $('apiKey').value = settings.apiKey || '';
    renderBridgeSettings();
    renderLaserState({ configured: !!settings.laserAddress, connected: laserConnected, address: settings.laserAddress, name: settings.laserName, vendor: settings.laserVendor });
    $('settingsBackdrop').classList.remove('hidden');
  }

  function closeSettings() {
    $('settingsBackdrop').classList.add('hidden');
  }

  function saveSettings() {
    settings.serverUrl = normalizeBackendApiUrl($('serverUrl').value);
    settings.apiKey = $('apiKey').value.trim();
    persistSettings();
    updateServerBadge();
    renderBridgeSettings();
    closeSettings();
    toast('Collegamento salvato ✓');
  }

  function updateServerBadge() {
    var badge = $('serverBadge');
    var configured = !!settings.serverUrl;
    var queued = offlineQueue.count();
    if (connectionState.checking) {
      badge.className = 'server-badge checking';
      badge.textContent = '● Verifico server…';
    } else if (connectionState.checked && connectionState.reachable && connectionState.authenticated) {
      badge.className = 'server-badge online';
      badge.textContent = '● Backend collegato' +
        (Number.isFinite(connectionState.latencyMs) ? ' · ' + connectionState.latencyMs + ' ms' : '') +
        (queued ? ' · ' + queued + ' da inviare' : '');
    } else if (connectionState.checked && connectionState.reachable) {
      badge.className = 'server-badge configured';
      badge.textContent = '● Server raggiungibile · API da verificare';
    } else if (connectionState.checked && !connectionState.reachable) {
      badge.className = 'server-badge offline';
      badge.textContent = '● Server non raggiungibile' + (queued ? ' · ' + queued + ' da inviare' : '');
    } else if (settings.bridgeConnected) {
      badge.className = 'server-badge configured';
      badge.textContent = '● Bridge attivo · server non verificato';
    } else if (configured || settings.bridgeConfigured) {
      badge.className = 'server-badge configured';
      badge.textContent = '● Configurato · tocca per verificare';
    } else {
      badge.className = 'server-badge offline';
      badge.textContent = '● Debian non collegato';
    }
  }

  async function scanBackendQr() {
    var scanner = nativePlugin('CapacitorBarcodeScanner');
    var tunnel = nativePlugin('GE360Tunnel');
    if (!scanner || !tunnel) return toast('Scanner QR disponibile nell\'APK Android GE360');

    var button = $('scanQrBtn');
    var original = button.textContent;
    button.disabled = true;
    button.textContent = 'APRO FOTOCAMERA…';
    try {
      var result = await scanner.scanBarcode({
        hint: 0,
        scanInstructions: 'Inquadra il QR GE360 mostrato dal server',
        scanButton: false,
        scanText: 'Scansiona',
        cameraDirection: 1,
        scanOrientation: 3,
        cancelButtonAccessibilityLabel: 'Annulla scansione',
        android: { scanningLibrary: 'mlkit' }
      });
      var profile = parseBridgeQr(result && result.ScanResult);
      $('bridgeStatus').className = 'bridge-status connecting';
      $('bridgeStatus').textContent = 'COLLEGAMENTO…';

      var state = await tunnel.connect({ config: profile.wireguardConfig });
      settings.serverUrl = normalizeBackendApiUrl(profile.backendUrl);
      if (profile.apiKey) settings.apiKey = profile.apiKey;
      settings.bridgeConfigured = true;
      settings.bridgeConnected = !!state.connected;
      settings.bridgeAddress = profile.bridgeAddress || '';
      settings.bridgeEndpoint = profile.endpoint || '';
      settings.bridgePairedAt = new Date().toISOString();
      persistSettings();

      $('serverUrl').value = settings.serverUrl;
      $('apiKey').value = settings.apiKey || '';
      updateServerBadge();
      renderBridgeSettings();

      try {
        var probe = await probeServer(settings.serverUrl, settings.apiKey);
        toast(probe.authenticated ? 'Backend GE360 collegato ✓' : 'Tunnel collegato ✓ · inserisci API Key');
      } catch (probeError) {
        toast('Tunnel attivo · backend non ancora raggiungibile');
      }
      profile.wireguardConfig = '';
      if (settings.bridgeConnected) setTimeout(flushOfflineQueue, 250);
    } catch (e) {
      renderBridgeSettings();
      var message = e && e.message ? e.message : 'scansione annullata';
      toast('QR non collegato: ' + message);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function restoreBridgeTunnel() {
    var tunnel = nativePlugin('GE360Tunnel');
    if (!tunnel) return;
    try {
      var state = await tunnel.restore();
      settings.bridgeConfigured = !!state.configured || !!settings.bridgeConfigured;
      settings.bridgeConnected = !!state.connected;
      persistSettings();
      updateServerBadge();
      renderBridgeSettings();
      setTimeout(refreshConnectionIndicator, 250);
    } catch (_) {
      settings.bridgeConnected = false;
      persistSettings();
      updateServerBadge();
      renderBridgeSettings();
    }
  }

  async function reconnectBridge() {
    var tunnel = nativePlugin('GE360Tunnel');
    if (!tunnel) return toast('GE360 Direct Bridge disponibile nell\'APK Android');
    $('bridgeStatus').className = 'bridge-status connecting';
    $('bridgeStatus').textContent = 'COLLEGAMENTO…';
    try {
      var state = await tunnel.connect({});
      settings.bridgeConfigured = !!state.configured;
      settings.bridgeConnected = !!state.connected;
      persistSettings();
      updateServerBadge();
      renderBridgeSettings();
      if (settings.bridgeConnected) {
        try {
          var probe = await probeServer(settings.serverUrl, settings.apiKey);
          toast(probe.authenticated ? 'Backend GE360 collegato ✓' : 'Tunnel collegato ✓ · inserisci API Key');
        } catch (_) { toast('Tunnel attivo · backend non raggiungibile'); }
        setTimeout(flushOfflineQueue, 250);
      }
    } catch (e) {
      settings.bridgeConnected = false;
      persistSettings();
      updateServerBadge();
      renderBridgeSettings();
      toast('Connessione Bridge fallita');
    }
  }

  async function disconnectBridge() {
    var tunnel = nativePlugin('GE360Tunnel');
    if (!tunnel) return;
    try { await tunnel.disconnect(); } catch (_) {}
    settings.bridgeConnected = false;
    persistSettings();
    updateServerBadge();
    renderBridgeSettings();
    toast('GE360 Bridge disconnesso');
  }

  async function testServer() {
    var url = normalizeBackendApiUrl($('serverUrl').value);
    var key = $('apiKey').value.trim();
    if (!url) return toast('Inserisci o scansiona il backend');
    toast('Test collegamento…');
    connectionState.checking = true;
    updateServerBadge();
    try {
      var probe = await probeServer(url, key);
      $('serverUrl').value = url;
      connectionState.checked = true;
      connectionState.reachable = true;
      connectionState.authenticated = probe.authenticated;
      connectionState.apiOk = probe.authenticated;
      connectionState.latencyMs = probe.latencyMs;
      connectionState.checkedAt = new Date().toISOString();
      connectionState.error = null;
      toast(probe.authenticated ? 'Backend raggiungibile ✓' : 'Backend raggiungibile ✓ · manca API Key');
    } catch (e) {
      connectionState.checked = true;
      connectionState.reachable = false;
      connectionState.authenticated = false;
      connectionState.apiOk = false;
      connectionState.latencyMs = null;
      connectionState.checkedAt = new Date().toISOString();
      connectionState.error = e && e.message ? e.message : String(e);
      toast('Connessione fallita: ' + (e.name === 'AbortError' ? 'timeout' : e.message));
    } finally {
      connectionState.checking = false;
      updateServerBadge();
    }
  }

  // ---------------------------------------------------------------------------
  // QUOTE PUNTO-PUNTO (diagonali, posizione dei tramezzi)
  // Gli estremi sono agganciati agli angoli dei muri ({wallId, end}): se la pianta
  // viene sistemata la quota segue i muri.
  // ---------------------------------------------------------------------------
  var pendingQuote = null;

  function anchorPoint(anchor) {
    if (!anchor) return null;
    var wall = anchor.wallId ? walls.find(function (w) { return w.id === anchor.wallId; }) : null;
    var p = wall ? wall[anchor.end === 'b' ? 'b' : 'a'] : null;
    if (p) return { x: p.x, y: p.y };
    return Number.isFinite(anchor.x) && Number.isFinite(anchor.y) ? { x: anchor.x, y: anchor.y } : null;
  }

  function nearestCorner(p) {
    var best = null;
    var limit = 46 / viewZoom;
    walls.forEach(function (wall) {
      ['a', 'b'].forEach(function (end) {
        var q = wall[end];
        var d = dist(p, q);
        if (d <= limit && (!best || d < best.d)) best = { wallId: wall.id, end: end, x: q.x, y: q.y, d: d };
      });
    });
    return best;
  }

  function nearestDiagonal(p) {
    var best = null;
    diagonals.forEach(function (d) {
      var a = anchorPoint(d.a), b = anchorPoint(d.b);
      if (!a || !b) return;
      var dd = dist(p, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      if (dd <= 34 / viewZoom && (!best || dd < best.d)) best = { diagonal: d, d: dd };
    });
    return best;
  }

  function handleQuotePick(p) {
    if (!quoteFirst) {
      var existing = nearestDiagonal(p);
      if (existing) {
        currentDiagonalId = existing.diagonal.id;
        numberText = metersText(existing.diagonal.lengthCm);
        openSheet('diagonal');
        render();
        return;
      }
    }
    var corner = nearestCorner(p);
    if (!corner) return toast('Tocca un angolo (estremo di un muro)');
    if (!quoteFirst) {
      quoteFirst = { wallId: corner.wallId, end: corner.end, x: corner.x, y: corner.y };
      vibrate(12);
      toast('Ora tocca il secondo angolo');
      render();
      return;
    }
    if (dist(quoteFirst, corner) < 1e-6) return toast('Scegli un angolo diverso');
    pendingQuote = { a: quoteFirst, b: { wallId: corner.wallId, end: corner.end, x: corner.x, y: corner.y } };
    quoteFirst = null;
    currentDiagonalId = null;
    numberText = '';
    openSheet('diagonal');
    render();
  }

  function saveDiagonalLength(cm) {
    checkpoint();
    if (currentDiagonalId) {
      var d = diagonals.find(function (x) { return x.id === currentDiagonalId; });
      if (d) d.lengthCm = cm;
    } else if (pendingQuote) {
      diagonals.push({ id: uid('q'), a: pendingQuote.a, b: pendingQuote.b, lengthCm: cm });
    }
    pendingQuote = null;
    currentDiagonalId = null;
    persistActive();
    closeSheet();
    render();
    toast('Quota salvata ✓');
  }

  function deleteCurrentDiagonal() {
    if (!currentDiagonalId) return;
    if (!confirm('Eliminare questa quota?')) return;
    checkpoint();
    diagonals = diagonals.filter(function (d) { return d.id !== currentDiagonalId; });
    currentDiagonalId = null;
    persistActive();
    closeSheet();
    render();
    toast('Quota eliminata');
  }

  function drawDiagonals() {
    diagonals.forEach(function (d) {
      var a = anchorPoint(d.a), b = anchorPoint(d.b);
      if (!a || !b) return;
      var sa = worldToScreen(a), sb = worldToScreen(b);
      ctx.save();
      ctx.strokeStyle = d.id === currentDiagonalId ? '#2563eb' : '#7c3aed';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([9, 6]);
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
      ctx.setLineDash([]);
      var text = metersText(d.lengthCm) + ' m';
      ctx.font = '900 12px system-ui';
      var w = Math.max(40, ctx.measureText(text).width + 14);
      var mx = (sa.x + sb.x) / 2, my = (sa.y + sb.y) / 2;
      ctx.fillStyle = '#faf5ff';
      roundRect(mx - w / 2, my - 14, w, 28, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#6b21a8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, mx, my + 1);
      ctx.restore();
    });
    if (quoteFirst) {
      var q = worldToScreen(quoteFirst);
      ctx.save();
      ctx.fillStyle = '#7c3aed';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  // CALCOLO PROFESSIONALE: invio → attesa del job → risultato
  // ---------------------------------------------------------------------------
  var PROGRESS_TEXT = {
    SENDING: 'Invio del rilievo…',
    QUEUED: 'In coda sul server…',
    PROCESSING: 'Ricostruzione della pianta…',
    DOWNLOADING: 'Scarico il risultato…'
  };

  function backendClient() {
    return createBackendClient({ baseUrl: settings.serverUrl, apiKey: settings.apiKey });
  }

  function wallsMissingRequiredThickness(sourceWalls) {
    return (sourceWalls || walls).filter(function (wall) {
      var state = wallConstructionState(wall);
      return wallStateNeedsThickness(state) &&
        (!Number.isFinite(Number(wall.constructionThicknessCm)) || Number(wall.constructionThicknessCm) <= 0);
    });
  }

  function openCalc() {
    cancelPickModes();
    if (!walls.length) return toast('Prima disegna la planimetria');
    var missingThickness = wallsMissingRequiredThickness(walls);
    if (missingThickness.length) {
      selectedEntity = { type: 'wall', id: missingThickness[0].id, wallIds: [missingThickness[0].id], name: 'Muro' };
      setMode('select', false);
      updateSelectionBar();
      openWallStateEditor();
      return toast('Completa lo spessore del muro prima del calcolo');
    }
    persistActive();
    var plan = currentPlan();
    var payload = planPayload(plan);
    var total = payload.walls.length;
    var measured = measuredWallCount(payload);
    $('calcHeightInput').value = metersText(Math.round(wallHeightM * 1000) / 10);
    $('calcReferenceSelect').value = wallReference;
    var info = $('calcInfo');
    info.className = 'calc-info';
    if (!settings.serverUrl || !settings.apiKey) {
      info.classList.add('warn');
      info.textContent = 'Server non collegato: apri ⚙ nella schermata iniziale e scansiona il QR.';
    } else if (!measured) {
      info.classList.add('warn');
      info.textContent = 'Serve almeno un muro misurato.';
    } else if (measured < total) {
      info.textContent = (total - measured) + ' muri su ' + total + ' senza misura: l\u2019agente li ricava dalle altre misure o li stima, e ti dice con quale affidabilità.';
    } else {
      info.textContent = 'Tutte le ' + total + ' misure inserite' + (diagonals.length ? ' · ' + diagonals.length + ' quote di controllo' : '') + '.';
    }
    setCalcProgress(null);
    $('calcSendBtn').disabled = !measured || !settings.serverUrl || !settings.apiKey;
    $('calcBackdrop').classList.remove('hidden');
  }

  function closeCalc() {
    $('calcBackdrop').classList.add('hidden');
  }

  function setCalcProgress(text) {
    $('calcProgress').classList.toggle('hidden', !text);
    $('calcProgressText').textContent = text || '';
    if (text) $('calcSendBtn').disabled = true;
  }

  function submitCalc() {
    var h = parseMetersInput($('calcHeightInput').value);
    if (!h || h < 1.5 || h > 10) return toast('Altezza pareti non valida');
    wallHeightM = h;
    // Fase 1: nel rilievo base non chiediamo lo spessore.
    // wallThicknessCm resta solo per compatibilità con il contratto backend esistente;
    // verrà valorizzato esplicitamente nelle future lavorazioni che lo richiedono.
    wallReference = $('calcReferenceSelect').value || 'interior';
    surfaceCache = null;
    persistActive();
    runCalculation(activePlanId, true);
  }

  function sendPlan(id) {
    if (!settings.serverUrl || !settings.apiKey) {
      openSettings();
      return toast('Collega prima il server GE360');
    }
    runCalculation(id, false);
  }


  function queueCalculation(plan, payload, error) {
    offlineQueue.enqueue(payload, payloadFingerprint(payload));
    plan.backend = Object.assign({}, plan.backend || {}, {
      planId: payload.planId,
      status: 'PENDING_SYNC',
      syncStatus: 'PENDING',
      queuedAt: new Date().toISOString(),
      lastError: error && error.message ? error.message : 'Backend non raggiungibile'
    });
    saveLibrary();
    updateServerBadge();
    renderDashboard();
  }

  async function flushOfflineQueue() {
    if (syncBusy || !settings.serverUrl || !settings.apiKey) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    var items = offlineQueue.list();
    if (!items.length) {
      flushPendingPhotos();
      return;
    }
    syncBusy = true;
    try {
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var plan = library.find(function (p) { return p.id === item.planId; });
        if (!plan) { offlineQueue.remove(item.planId); continue; }
        try {
          var out = await backendClient().processPlan(item.payload);
          var compact = compactResult(out.status, out.processed, { fingerprint: item.fingerprint });
          plan.backend = {
            planId: out.submission.planId,
            sentAt: new Date().toISOString(),
            status: compact.status,
            syncStatus: 'SYNCED',
            result: compact,
            lastError: null,
            reportDirty: false,
            localHistory: carryLocalResultHistory(plan, compact)
          };
          offlineQueue.remove(item.planId);
          saveLibrary();
          await syncPlanPhotos(plan, out.submission.planId);
        } catch (e) {
          offlineQueue.markError(item.planId, e.message || e);
          if (isRetryableBackendError(e)) break;
          plan.backend = Object.assign({}, plan.backend || {}, { syncStatus: 'BLOCKED', lastError: e.message || String(e) });
          saveLibrary();
          break;
        }
      }
    } finally {
      syncBusy = false;
      updateServerBadge();
      renderDashboard();
    }
  }

  function carryLocalResultHistory(plan, nextResult) {
    var backend = plan && plan.backend ? plan.backend : {};
    var rows = Array.isArray(backend.localHistory) ? clone(backend.localHistory) : [];
    var previous = backend.result;
    if (previous && previous.version && (!nextResult || previous.version !== nextResult.version)) {
      rows = rows.filter(function (row) { return row && row.version !== previous.version; });
      rows.unshift({
        version: previous.version,
        capturedAt: new Date().toISOString(),
        result: clone(previous)
      });
    }
    return rows.slice(0, 20);
  }

  async function runCalculation(id, fromModal) {
    if (calcBusy) return toast('Calcolo già in corso…');
    var plan = library.find(function (p) { return p.id === id; });
    if (!plan) return;
    if (id === activePlanId) persistActive();
    var missingThickness = wallsMissingRequiredThickness(plan.walls || []);
    if (missingThickness.length) {
      return toast('Manca lo spessore di ' + missingThickness.length + ' muro/i da demolire o costruire');
    }
    var payload = planPayload(plan);
    if (!payload.planId) return toast('Identificativo rilievo non valido');
    if (!measuredWallCount(payload)) return toast('Serve almeno un muro misurato');
    calcBusy = true;
    var progress = function (status) {
      var text = PROGRESS_TEXT[status] || 'Elaborazione…';
      if (fromModal) setCalcProgress(text); else toast(text);
    };
    try {
      var out = await backendClient().processPlan(payload, { onProgress: progress });
      var compact = compactResult(out.status, out.processed, { fingerprint: payloadFingerprint(payload) });
      plan.backend = {
        planId: out.submission.planId,
        sentAt: new Date().toISOString(),
        status: compact.status,
        syncStatus: 'SYNCED',
        result: compact,
        lastError: null,
        reportDirty: false,
        localHistory: carryLocalResultHistory(plan, compact)
      };
      offlineQueue.remove(plan.id);
      saveLibrary();
      await syncPlanPhotos(plan, out.submission.planId);
      if (fromModal) closeCalc();
      openResult(id);
    } catch (e) {
      var message = e && e.message ? e.message : String(e);
      if (isRetryableBackendError(e) && settings.serverUrl && settings.apiKey) {
        queueCalculation(plan, payload, e);
        if (fromModal) closeCalc();
        toast('Rilievo salvato offline · invio automatico quando torna il Bridge');
      } else {
        plan.backend = Object.assign({}, plan.backend || {}, { lastError: message, lastErrorAt: new Date().toISOString() });
        saveLibrary();
        toast('Calcolo non riuscito: ' + message);
        vibrate(80);
        if (e && e.status === 401) { closeCalc(); openSettings(); }
      }
    } finally {
      calcBusy = false;
      if (fromModal) { setCalcProgress(null); $('calcSendBtn').disabled = false; }
      if (!$('dashboard').classList.contains('hidden')) renderDashboard();
    }
  }

  function resultPlan() {
    return resultPlanId ? library.find(function (p) { return p.id === resultPlanId; }) : null;
  }

  function resultCard(label, value, unit, digits) {
    var div = document.createElement('div');
    div.className = 'ps-card';
    var k = document.createElement('div');
    k.className = 'ps-k';
    k.textContent = label;
    var v = document.createElement('div');
    v.className = 'ps-v';
    v.textContent = fmtNum(value, digits == null ? 2 : digits, unit);
    div.appendChild(k);
    div.appendChild(v);
    return div;
  }

  function cell(label, value, unit, digits) {
    var div = document.createElement('div');
    div.textContent = label;
    var b = document.createElement('b');
    b.textContent = fmtNum(value, digits == null ? 2 : digits, unit);
    div.appendChild(b);
    return div;
  }

  function onQuestion(question) {
    var plan = resultPlan();
    if (!plan) return;
    var action = questionAction(question, plan.walls || []);
    if (action.type === 'info') return;
    var id = plan.id;
    closeResult();
    if (activePlanId !== id) openPlan(id);
    if (action.type === 'wall') {
      var wall = walls.find(function (w) { return w.id === action.wallId; });
      if (wall) editWallMeasurement(wall);
    } else if (action.type === 'quote') {
      setMode('quote');
    }
  }

  function openResult(id, options) {
    var plan = library.find(function (p) { return p.id === id; });
    if (!plan || !plan.backend || !plan.backend.result) return toast('Nessun calcolo disponibile');
    if (id === activePlanId) persistActive();
    options = options || {};
    resultOverride = options.result || null;
    resultOverrideVersion = options.version || null;
    var res = resultOverride || plan.backend.result;
    var planWalls = plan.walls || [];
    resultPlanId = id;
    resultHighlightWallId = null;
    resultHighlightWallIds = [];
    var st = statusInfo(res.status);
    $('resultTitle').textContent = plan.name || 'Rilievo';
    $('resultStamp').textContent = st.label + (res.version ? ' · versione ' + res.version : '') + ' · ' + new Date(res.receivedAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    $('resultVersionBadge').textContent = 'VERSIONE ' + (res.version || '—') + (resultOverride ? ' · ARCHIVIO' : ' · CORRENTE');
    $('resultHistoryNotice').classList.toggle('hidden', !resultOverride);
    var geometryStale = resultOverride ? false : isResultStale(res, payloadFingerprint(planPayload(plan)));
    var reportDirty = resultOverride ? false : !!(plan.backend && plan.backend.reportDirty);
    $('resultStale').classList.toggle('hidden', !geometryStale && !reportDirty);
    $('resultStale').firstChild.nodeValue = geometryStale
      ? 'Il rilievo è cambiato dopo questo calcolo. '
      : 'Hai aggiunto o modificato lavorazioni dopo l’ultimo PDF. ';

    var ai = res.totals && res.totals.aiSummary;
    $('resultAi').classList.toggle('hidden', !ai);
    $('resultAi').textContent = ai ? '✨ ' + ai : '';

    var qWrap = $('resultQuestions');
    qWrap.innerHTML = '';
    // Decisioni prese in autonomia dall'agente: si leggono, non serve rispondere.
    var decisions = res.decisions && res.decisions.length ? res.decisions : null;
    var decisionTexts = (res.totals && res.totals.decisions) || [];
    if (decisions || decisionTexts.length) {
      var head = document.createElement('div');
      head.className = 'result-decisions-head';
      head.textContent = 'DECISIONI DELL\u2019AGENTE · ' + (decisions ? decisions.length : decisionTexts.length);
      qWrap.appendChild(head);
    }
    (decisions || decisionTexts.map(function (t) { return { text: t }; })).forEach(function (d) {
      var btn = document.createElement('button');
      var ids = decisionWalls(d, planWalls);
      btn.className = 'result-decision' + (ids.length ? ' actionable' : '');
      var txt = humanizeText(d.text, planWalls);
      if (Number.isFinite(d.probability) && d.probability >= 0 && d.probability <= 1 && txt.indexOf('probabilità') === -1) txt += ' — probabilità ' + Math.round(d.probability * 100) + '%';
      btn.textContent = txt;
      btn.addEventListener('click', function () {
        resultHighlightWallIds = ids;
        renderResultCanvas();
        var rc = $('resultCanvas');
        if (rc && typeof rc.scrollIntoView === 'function') rc.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      qWrap.appendChild(btn);
    });
    ((res.totals && res.totals.questions) || []).forEach(function (q) {
      var action = questionAction(q, planWalls);
      var btn = document.createElement('button');
      btn.className = 'result-question' + (action.type !== 'info' ? ' actionable' : '');
      btn.textContent = humanizeText(q, planWalls);
      btn.addEventListener('click', function () { onQuestion(q); });
      qWrap.appendChild(btn);
    });

    var t = res.totals || {};
    var totals = $('resultTotals');
    totals.innerHTML = '';
    var floorCard = resultCard('PAVIMENTO', t.floorAreaM2, 'm²');
    if (fmtRange(t.floorAreaRangeM2)) {
      var rng = document.createElement('div');
      rng.className = 'ps-range';
      rng.textContent = fmtRange(t.floorAreaRangeM2) + ' m²';
      floorCard.appendChild(rng);
    }
    totals.appendChild(floorCard);
    if (Number.isFinite(t.confidence)) {
      var conf = resultCard('AFFIDABILITÀ', t.confidence * 100, '%', 0);
      conf.querySelector('.ps-v').textContent = Math.round(t.confidence * 100) + '% · ' + confidenceLabel(t.confidence);
      totals.appendChild(conf);
    }
    totals.appendChild(resultCard('SOFFITTO', t.ceilingAreaM2, 'm²'));
    totals.appendChild(resultCard('PARETI NETTE', t.netWallAreaM2, 'm²'));
    totals.appendChild(resultCard('PARETI LORDE', t.grossWallAreaM2, 'm²'));
    totals.appendChild(resultCard('PITTURA', t.paintAreaM2, 'm²'));
    if (t.tilingAreaM2 > 0) totals.appendChild(resultCard('RIVESTIMENTO', t.tilingAreaM2, 'm²'));
    totals.appendChild(resultCard('BATTISCOPA', t.skirtingM, 'm'));
    totals.appendChild(resultCard('VOLUME', t.volumeM3, 'm³', 1));

    var roomsWrap = $('resultRooms');
    roomsWrap.innerHTML = '';
    (res.rooms || []).forEach(function (room) {
      var card = document.createElement('div');
      card.className = 'result-room';
      var h3 = document.createElement('h3');
      h3.textContent = room.name + ' ';
      var badge = document.createElement('span');
      var qcls = room.quality === 'OK' ? 'ok' : room.quality === 'NEEDS_REVIEW' ? 'review' : 'estimated';
      badge.className = 'surface-badge ' + qcls;
      badge.textContent = qualityLabel(room.quality);
      h3.appendChild(badge);
      var sub = document.createElement('div');
      sub.className = 'rr-sub';
      sub.textContent = fmtNum(room.widthM, 2) + ' × ' + fmtNum(room.depthM, 2) + ' m · h ' + fmtNum(room.heightMm / 1000, 2) + ' m' +
        (Number.isFinite(room.confidence) ? ' · affidabilità ' + Math.round(room.confidence * 100) + '% (' + confidenceLabel(room.confidence) + ')' : '');
      var grid = document.createElement('div');
      grid.className = 'result-room-grid';
      var floorCell = cell('Pavimento', room.floorAreaM2, 'm²');
      if (fmtRange(room.floorAreaRangeM2)) {
        var small = document.createElement('small');
        small.textContent = fmtRange(room.floorAreaRangeM2) + ' m²';
        floorCell.appendChild(small);
      }
      grid.appendChild(floorCell);
      grid.appendChild(cell('Soffitto', room.ceilingAreaM2, 'm²'));
      grid.appendChild(cell('Pareti nette', room.netWallAreaM2, 'm²'));
      grid.appendChild(cell('Pareti lorde', room.grossWallAreaM2, 'm²'));
      grid.appendChild(cell('Porte e finestre', room.openingsAreaM2, 'm²'));
      grid.appendChild(cell('Spallette', room.revealsAreaM2, 'm²'));
      if (room.tilingAreaM2 != null) grid.appendChild(cell('Rivestimento h ' + fmtNum(room.tilingHeightMm / 1000, 2), room.tilingAreaM2, 'm²'));
      grid.appendChild(cell('Pittura', room.paintAreaM2, 'm²'));
      grid.appendChild(cell('Battiscopa', room.skirtingM, 'm'));
      grid.appendChild(cell('Perimetro', room.perimeterM, 'm'));
      grid.appendChild(cell('Volume', room.volumeM3, 'm³', 1));
      card.appendChild(h3);
      card.appendChild(sub);
      card.appendChild(grid);
      (room.decisions || []).forEach(function (text) {
        var dq = document.createElement('div');
        dq.className = 'rr-q';
        dq.textContent = '• ' + humanizeText(text, planWalls);
        card.appendChild(dq);
      });
      roomsWrap.appendChild(card);
    });

    var wallInfo = [];
    (res.walls || []).forEach(function (w) {
      var idx = planWalls.findIndex(function (x) { return x.id === w.id; });
      var label = 'Muro ' + (idx + 1);
      if (w.suspect && w.suggestedLengthMm) {
        wallInfo.push((isAgentCorrected(w, res.decisions) ? '✎ ' : '⚠ ') + label + ': misurato ' + fmtNum(w.declaredLengthMm / 1000, 3) + ' m, ' + (isAgentCorrected(w, res.decisions) ? 'usato ' + fmtNum(w.calculatedLengthMm / 1000, 3) + ' m (corretto dall’agente)' : 'suggerito ' + fmtNum(w.suggestedLengthMm / 1000, 3) + ' m (da verificare)'));
      } else if (w.lengthSource === 'CALCULATED') {
        wallInfo.push('✓ ' + label + ': calcolato ' + fmtNum(w.calculatedLengthMm / 1000, 3) + ' m dalle altre misure');
      } else if (w.lengthSource === 'SKETCH') {
        wallInfo.push('≈ ' + label + ': stimato ' + fmtNum(w.calculatedLengthMm / 1000, 2) + ' m dallo schizzo — serve la misura');
      }
    });
    $('resultWalls').textContent = wallInfo.join('\n');
    $('resultWalls').style.whiteSpace = 'pre-line';

    $('resultBackdrop').classList.remove('hidden');
    requestAnimationFrame(renderResultCanvas);
  }

  function renderResultCanvas() {
    var plan = resultPlan();
    if (!plan || !plan.backend || !plan.backend.result) return;
    var res = resultOverride || plan.backend.result;
    drawBackendPlan($('resultCanvas'), res, { dpr: Math.min(3, window.devicePixelRatio || 1), highlightWallId: resultHighlightWallId, highlightWallIds: resultHighlightWallIds });
  }

  function closeResult() {
    $('resultBackdrop').classList.add('hidden');
    $('resultVersionsBackdrop').classList.add('hidden');
    resultPlanId = null;
    resultOverride = null;
    resultOverrideVersion = null;
  }

  function cachedVersionResult(plan, version) {
    if (!plan || !plan.backend) return null;
    if (plan.backend.result && plan.backend.result.version === version) return plan.backend.result;
    var row = (plan.backend.localHistory || []).find(function (item) { return item && item.version === version; });
    return row && row.result ? row.result : null;
  }

  function localVersionIndex(plan) {
    var rows = [];
    if (plan && plan.backend && plan.backend.result && plan.backend.result.version) {
      rows.push({
        version: plan.backend.result.version,
        status: plan.backend.result.status,
        completedAt: plan.backend.result.receivedAt,
        totals: plan.backend.result.totals || null
      });
    }
    (plan && plan.backend && plan.backend.localHistory || []).forEach(function (row) {
      if (!row || !row.version || rows.some(function (x) { return x.version === row.version; })) return;
      rows.push({
        version: row.version,
        status: row.result && row.result.status || 'ARCHIVED',
        completedAt: row.result && row.result.receivedAt || row.capturedAt,
        totals: row.result && row.result.totals || null
      });
    });
    return rows.sort(function (a,b) { return b.version - a.version; });
  }

  function normalizeVersionRows(data) {
    var rows = Array.isArray(data)
      ? data
      : data && Array.isArray(data.versions)
        ? data.versions
        : data && Array.isArray(data.items)
          ? data.items
          : [];
    return rows.filter(function (row) {
      return row && Number.isFinite(Number(row.version));
    }).map(function (row) {
      return Object.assign({}, row, { version: Number(row.version) });
    }).sort(function (a, b) { return b.version - a.version; });
  }

  function pdfVersionRows(plan) {
    var byVersion = new Map();
    localVersionIndex(plan).forEach(function (row) {
      byVersion.set(Number(row.version), Object.assign({}, row));
    });
    normalizeVersionRows(plan && plan.backend && plan.backend.versionIndex || []).forEach(function (row) {
      var v = Number(row.version);
      byVersion.set(v, Object.assign({}, byVersion.get(v) || {}, row, { version: v }));
    });
    return Array.from(byVersion.values()).sort(function (a, b) { return b.version - a.version; });
  }

  function knownPdfVersionCount(plan) {
    var count = pdfVersionRows(plan).length;
    return Math.max(count, plan && plan.backend && plan.backend.result ? 1 : 0);
  }

  function pdfArchivePlan() {
    return pdfArchivePlanId ? library.find(function (p) { return p.id === pdfArchivePlanId; }) : null;
  }

  function pdfVersionHasFile(meta) {
    if (!meta) return true;
    if (meta.files && Object.prototype.hasOwnProperty.call(meta.files, 'pdf')) return !!meta.files.pdf;
    if (meta.artifacts && Object.prototype.hasOwnProperty.call(meta.artifacts, 'pdf')) return !!meta.artifacts.pdf;
    if (Array.isArray(meta.files)) return meta.files.some(function (file) {
      return String(file && (file.type || file.kind || file.name || '')).toLowerCase().indexOf('pdf') !== -1;
    });
    return true;
  }

  function renderPdfArchiveRows(plan, rows) {
    var wrap = $('pdfArchiveList');
    wrap.innerHTML = '';
    var currentVersion = plan && plan.backend && plan.backend.result ? Number(plan.backend.result.version) : null;

    if (!rows.length) {
      wrap.innerHTML = '<div class="work-selected-empty">Nessun PDF ancora disponibile. Esegui CALCOLA per creare il primo report.</div>';
      return;
    }

    rows.forEach(function (meta) {
      var row = document.createElement('div');
      row.className = 'pdf-row' + (Number(meta.version) === currentVersion ? ' current' : '');
      var left = document.createElement('div');
      var title = document.createElement('b');
      title.textContent = 'PDF · VERSIONE ' + meta.version + (Number(meta.version) === currentVersion ? ' · corrente' : '');
      var small = document.createElement('small');
      var when = meta.completedAt || meta.createdAt || meta.capturedAt || (meta.result && meta.result.receivedAt);
      var status = meta.status ? ' · ' + statusInfo(meta.status).label : '';
      small.textContent = (when ? new Date(when).toLocaleString('it-IT', {
        day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit'
      }) : 'Data non disponibile') + status;
      left.appendChild(title);
      left.appendChild(small);

      var open = document.createElement('button');
      open.textContent = pdfVersionHasFile(meta) ? 'LEGGI PDF' : 'PDF NON CREATO';
      open.disabled = !pdfVersionHasFile(meta);
      open.addEventListener('click', function () { openPdfVersion(meta.version); });

      row.appendChild(left);
      row.appendChild(open);
      wrap.appendChild(row);
    });
  }

  async function openPdfArchive(planId) {
    var plan = library.find(function (p) { return p.id === planId; });
    if (!plan || !plan.backend || !plan.backend.result) return toast('Prima esegui CALCOLA');
    pdfArchivePlanId = planId;
    $('pdfArchiveTitle').textContent = 'PDF · ' + (plan.name || 'Rilievo');
    $('pdfArchiveBackdrop').classList.remove('hidden');
    $('pdfArchiveStatus').classList.add('hidden');
    renderPdfArchiveRows(plan, pdfVersionRows(plan));

    if (!settings.serverUrl || !settings.apiKey) {
      $('pdfArchiveStatus').textContent = 'Archivio locale visibile · collega il backend per aprire i PDF non già disponibili.';
      $('pdfArchiveStatus').classList.remove('hidden');
      return;
    }

    $('pdfArchiveStatus').textContent = 'Aggiorno l’archivio dal backend…';
    $('pdfArchiveStatus').classList.remove('hidden');
    try {
      var remote = normalizeVersionRows(await backendClient().listVersions(plan.backend.planId || plan.id));
      if (remote.length) {
        plan.backend.versionIndex = remote;
        saveLibrary();
        renderPdfArchiveRows(plan, pdfVersionRows(plan));
      }
      $('pdfArchiveStatus').classList.add('hidden');
      renderDashboard();
    } catch (e) {
      $('pdfArchiveStatus').textContent = 'Non riesco ad aggiornare il server adesso. Mostro le versioni già note.';
    }
  }

  function closePdfArchive() {
    $('pdfArchiveBackdrop').classList.add('hidden');
  }

  function pdfFilename(plan, version) {
    var safe = String(plan && plan.name || 'rilievo').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'rilievo';
    return safe + (version ? ' - v' + version : '') + '.pdf';
  }

  function updatePdfReaderState(state) {
    $('pdfReaderLoading').classList.toggle('hidden', !state.loading && !state.rendering);
    $('pdfReaderError').classList.toggle('hidden', !state.error);
    $('pdfReaderError').textContent = state.error ? 'Impossibile visualizzare il PDF: ' + state.error : '';
    $('pdfPageLabel').textContent = state.pages ? state.page + ' / ' + state.pages : '—';
    $('pdfZoomLabel').textContent = state.ready ? Math.round(state.zoom * 100) + '%' : '—';
    $('pdfPrevBtn').disabled = !state.ready || state.page <= 1;
    $('pdfNextBtn').disabled = !state.ready || state.page >= state.pages;
    $('pdfZoomOutBtn').disabled = !state.ready;
    $('pdfZoomInBtn').disabled = !state.ready;
  }

  function ensurePdfReader() {
    if (pdfReader) return pdfReader;
    pdfReader = createPdfReader({
      canvas: $('pdfReaderCanvas'),
      container: $('pdfReaderViewport'),
      fallbackFrame: $('pdfReaderFallback'),
      onState: updatePdfReaderState
    });
    return pdfReader;
  }

  async function openPdfVersion(version, planOverride) {
    var plan = planOverride || pdfArchivePlan();
    if (!plan || !plan.backend) return;
    if (!settings.serverUrl || !settings.apiKey) return toast('Collega il backend per aprire questo PDF');

    pdfArchivePlanId = plan.id;
    pdfReaderVersion = Number(version) || null;
    pdfReaderFilename = pdfFilename(plan, pdfReaderVersion);
    pdfReaderBlob = null;
    $('pdfReaderTitle').textContent = plan.name || 'Rilievo';
    $('pdfReaderMeta').textContent = 'PDF · versione ' + (pdfReaderVersion || 'corrente');
    $('pdfArchiveBackdrop').classList.add('hidden');
    $('pdfReaderBackdrop').classList.remove('hidden');
    updatePdfReaderState({ loading: true, rendering: false, error: null, ready: false, page: 1, pages: 0, zoom: 1 });

    try {
      var currentVersion = plan.backend.result ? Number(plan.backend.result.version) : null;
      var artifactVersion = currentVersion && currentVersion === pdfReaderVersion ? null : pdfReaderVersion;
      var blob = await backendClient().downloadArtifact(plan.backend.planId || plan.id, 'pdf', artifactVersion);
      pdfReaderBlob = blob;
      await ensurePdfReader().open(blob);
    } catch (e) {
      updatePdfReaderState({
        loading: false,
        rendering: false,
        error: e && e.message ? e.message : String(e),
        ready: false,
        page: 1,
        pages: 0,
        zoom: 1
      });
    }
  }

  async function closePdfReader(returnToArchive) {
    if (pdfReader) await pdfReader.close();
    pdfReaderBlob = null;
    pdfReaderVersion = null;
    pdfReaderFilename = '';
    $('pdfReaderBackdrop').classList.add('hidden');
    if (returnToArchive && pdfArchivePlanId) {
      var plan = pdfArchivePlan();
      if (plan) {
        $('pdfArchiveBackdrop').classList.remove('hidden');
        renderPdfArchiveRows(plan, pdfVersionRows(plan));
      }
    }
  }

  async function saveCurrentPdf() {
    if (!pdfReaderBlob || !pdfReaderFilename) return toast('PDF non ancora caricato');
    try {
      await saveBlob(pdfReaderBlob, pdfReaderFilename);
    } catch (e) {
      toast('Salvataggio non riuscito: ' + (e && e.message ? e.message : e));
    }
  }

  async function openResultPdfInReader() {
    var plan = resultPlan();
    if (!plan || !plan.backend || !plan.backend.result) return;
    var version = resultOverrideVersion || plan.backend.result.version || null;
    pdfArchivePlanId = plan.id;
    closeResult();
    await openPdfVersion(version, plan);
  }

  function renderVersionHistory(rows) {
    var plan = resultPlan();
    var currentVersion = plan && plan.backend && plan.backend.result ? plan.backend.result.version : null;
    var wrap = $('resultVersionsList');
    wrap.innerHTML = '';
    if (!rows.length) {
      wrap.innerHTML = '<div class="work-selected-empty">Nessuna versione disponibile</div>';
      return;
    }
    rows.forEach(function (meta) {
      var b = document.createElement('button');
      b.className = 'version-row' + (meta.version === currentVersion ? ' current' : '');
      var left = document.createElement('span');
      var title = document.createElement('b');
      title.textContent = 'Versione ' + meta.version + (meta.version === currentVersion ? ' · corrente' : '');
      var small = document.createElement('small');
      var when = meta.completedAt || meta.createdAt;
      var workCount = meta.totals && Number.isFinite(meta.totals.works) ? ' · ' + meta.totals.works + ' lavori' : '';
      small.textContent = (when ? new Date(when).toLocaleString('it-IT', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' }) : 'Data non disponibile') + workCount;
      left.appendChild(title); left.appendChild(small);
      var open = document.createElement('span');
      open.className = 'version-open';
      open.textContent = meta.version === currentVersion ? 'APRI' : 'VEDI';
      b.appendChild(left); b.appendChild(open);
      b.addEventListener('click', function () { viewResultVersion(meta.version); });
      wrap.appendChild(b);
    });
  }

  async function openResultVersions() {
    var plan = resultPlan();
    if (!plan || !plan.backend) return;
    $('resultVersionsBackdrop').classList.remove('hidden');
    var rows = localVersionIndex(plan);
    renderVersionHistory(rows);
    if (!settings.serverUrl || !settings.apiKey) return;
    try {
      var remote = normalizeVersionRows(await backendClient().listVersions(plan.backend.planId || plan.id));
      if (remote.length) {
        plan.backend.versionIndex = remote;
        saveLibrary();
        renderVersionHistory(remote);
      }
    } catch (_) {}
  }

  function closeResultVersions() {
    $('resultVersionsBackdrop').classList.add('hidden');
  }

  async function viewResultVersion(version) {
    var plan = resultPlan();
    if (!plan || !plan.backend) return;
    var id = plan.id;
    var currentVersion = plan.backend.result && plan.backend.result.version;
    closeResultVersions();
    if (version === currentVersion) {
      return openResult(id);
    }
    var cached = cachedVersionResult(plan, version);
    if (cached) {
      return openResult(id, { result: clone(cached), version: version });
    }
    if (!settings.serverUrl || !settings.apiKey) return toast('Questa versione è disponibile sul Debian');
    toast('Carico versione ' + version + '…');
    try {
      var data = await backendClient().fetchVersion(plan.backend.planId || plan.id, version);
      var meta = data.metadata || {};
      var status = {
        status: meta.status || 'UNKNOWN',
        currentVersion: meta.version || version,
        quality: meta.quality || null,
        totals: meta.totals || null,
        lastError: null
      };
      var compact = compactResult(status, data.processed, {
        receivedAt: meta.completedAt || meta.createdAt || new Date().toISOString(),
        fingerprint: null
      });
      var history = Array.isArray(plan.backend.localHistory) ? plan.backend.localHistory : [];
      history = history.filter(function (row) { return row && row.version !== version; });
      history.unshift({ version: version, capturedAt: new Date().toISOString(), result: clone(compact) });
      plan.backend.localHistory = history.slice(0,20);
      saveLibrary();
      openResult(id, { result: compact, version: version });
    } catch (e) {
      toast('Versione non disponibile: ' + (e && e.message ? e.message : e));
    }
  }

  function showLatestResultVersion() {
    var plan = resultPlan();
    if (!plan) return;
    openResult(plan.id);
  }

  function recalcFromResult() {
    var id = resultPlanId;
    closeResult();
    if (id) runCalculation(id, false);
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('lettura file fallita')); };
      reader.readAsDataURL(blob);
    });
  }

  async function saveBlob(blob, filename) {
    var fs = nativePlugin('Filesystem');
    var share = nativePlugin('Share');
    if (fs && share) {
      var data = await blobToBase64(blob);
      var written = await fs.writeFile({ path: filename, data: data, directory: 'CACHE' });
      await share.share({ title: filename, url: written.uri, dialogTitle: 'Salva o condividi ' + filename });
      return;
    }
    if (typeof File === 'function' && navigator.canShare) {
      var file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  async function downloadResult(kind) {
    var plan = resultPlan();
    if (!plan || !plan.backend) return;
    if (kind === 'pdf' && !resultOverrideVersion && plan.backend.reportDirty) {
      toast('PDF da aggiornare: premi RICALCOLA per includere gli ultimi lavori');
      return;
    }
    if (!settings.serverUrl || !settings.apiKey) return toast('Server non collegato');
    toast('Scarico ' + kind.toUpperCase() + '…');
    try {
      var blob = await backendClient().downloadArtifact(plan.backend.planId || plan.id, kind, resultOverrideVersion);
      var safeName = String(plan.name || 'rilievo').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'rilievo';
      var versionSuffix = resultOverrideVersion ? ' - v' + resultOverrideVersion : '';
      var name = (kind === 'pdf' ? safeName : 'GE360-' + safeName) + versionSuffix + '.' + kind;
      await saveBlob(blob, name);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('Download non riuscito: ' + (e && e.message ? e.message : e));
    }
  }


  function exportJson() {
    persistActive();
    var plan = currentPlan();
    if (!plan || !plan.walls || !plan.walls.length) return toast('Prima fai uno schizzo');
    var missing = plan.walls.filter(function (w) { return !w.lengthCm; }).length;
    if (missing) toast(missing + ' muri senza misura: verranno calcolati dal server');
    var blob = new Blob([JSON.stringify(planPayload(plan), null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'GE360-' + (plan.name || 'rilievo').replace(/[^a-z0-9_-]+/gi, '-') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }


  function workTargetLabel() {
    return workTarget.type === 'plan' ? 'Tutta la casa' : workTarget.name;
  }

  function roomAreaForWork(roomId) {
    var plan = currentPlan();
    var result = plan && plan.backend && plan.backend.result;
    var serverRoom = result && (result.rooms || []).find(function (r) { return r.roomId === roomId; });
    if (serverRoom && Number.isFinite(serverRoom.floorAreaM2)) return serverRoom.floorAreaM2;
    var cache = surfaceCache || refreshSurfaceCache();
    var metric = cache && (cache.roomMetrics || []).find(function (m) { return m.room && m.room.id === roomId; });
    return metric && Number.isFinite(metric.floorM2) ? metric.floorM2 : null;
  }

  async function refreshWorkCatalogFromServer() {
    if (!settings.serverUrl || !settings.apiKey) return;
    try {
      var data = await backendClient().fetchWorkCatalog();
      if (data && Array.isArray(data.works) && data.works.length >= 20) {
        workCatalogState = data;
        workCatalog = data.works;
        saveCachedWorkCatalog(data, localStorage);
        renderWorkSuggestions();
      }
    } catch (_) {}
  }

  function workTargetFromSelection() {
    if (!selectedEntity) return null;
    if (selectedEntity.type === 'wall') {
      var wall = walls.find(function (w) { return w.id === selectedEntity.id; });
      if (!wall) return null;
      var room = roomForWall(wall.id);
      var idx = walls.findIndex(function (w) { return w.id === wall.id; });
      var name = 'Muro ' + (idx + 1) + (room ? ' · ' + room.name : '');
      return {
        type: 'wall',
        id: wall.id,
        name: name,
        roomType: room ? (room.type || roomTypeFromName(room.name)) : 'altro'
      };
    }
    var selectedRoom = selectedEntity.id ? rooms.find(function (r) { return r.id === selectedEntity.id; }) : null;
    if (!selectedRoom) return null;
    return {
      type: 'room',
      id: selectedRoom.id,
      name: selectedRoom.name || 'Ambiente',
      roomType: selectedRoom.type || roomTypeFromName(selectedRoom.name)
    };
  }

  function openWorksForSelection() {
    var target = workTargetFromSelection();
    if (!target) {
      toast('Per aggiungere lavori salva prima la stanza oppure seleziona un muro');
      return;
    }
    openWorks(target);
  }

  function openWorks(initialTarget) {
    closeTools();
    persistActive();
    var plan = currentPlan();
    if (!plan) return;
    $('worksPlanName').textContent = plan.name || 'Rilievo';
    var currentVersion = plan.backend && plan.backend.result && plan.backend.result.version;
    $('worksProcessBtn').textContent = currentVersion ? 'RIELABORA → V' + (currentVersion + 1) : 'ELABORA';
    workTarget = initialTarget || { type: 'plan', id: null, name: 'Tutta la casa', roomType: 'altro' };
    $('workSearchInput').value = '';
    $('worksScreen').classList.remove('hidden');
    renderWorkRooms();
    renderWorkSuggestions();
    renderSelectedWorks();
    setTimeout(function () { $('workSearchInput').focus(); }, 80);
    refreshWorkCatalogFromServer();
  }

  function closeWorks() {
    persistActive();
    $('worksScreen').classList.add('hidden');
  }

  function fmtConstructionQty(value, unit) {
    if (!Number.isFinite(Number(value))) return '—';
    var digits = unit === 'm³' ? 3 : 2;
    return Number(value).toFixed(digits).replace('.', ',') + ' ' + unit;
  }

  function appendConstructionRow(wrap, label, value, unit) {
    var row = document.createElement('div');
    row.className = 'construction-auto-row';
    var left = document.createElement('span');
    left.textContent = label;
    var right = document.createElement('strong');
    right.textContent = fmtConstructionQty(value, unit);
    row.appendChild(left);
    row.appendChild(right);
    wrap.appendChild(row);
  }

  function renderConstructionAutoCard() {
    var card = $('constructionAutoCard');
    var body = $('constructionAutoBody');
    if (!card || !body || !workTarget) return;
    body.innerHTML = '';

    if (workTarget.type === 'wall') {
      var wall = walls.find(function (w) { return w.id === workTarget.id; });
      var metrics = wallConstructionMetrics(wall, wallHeightM);
      if (!metrics) {
        card.classList.add('hidden');
        return;
      }

      card.classList.remove('hidden');
      if (!metrics.complete) {
        var note = document.createElement('div');
        note.className = 'construction-auto-note';
        note.textContent = 'Completa misura e spessore del muro per ottenere le quantità automatiche.';
        body.appendChild(note);
        return;
      }

      constructionWorkLines(metrics).forEach(function (line) {
        appendConstructionRow(body, line.label, line.quantity, line.unit);
      });
      var note2 = document.createElement('div');
      note2.className = 'construction-auto-note';
      note2.textContent = 'Volume geometrico puro: nessun coefficiente di macerie, sfrido o maggiorazione applicato.';
      body.appendChild(note2);
      return;
    }

    if (workTarget.type === 'plan') {
      var summary = summarizeConstruction(walls, wallHeightM);
      if (!summary.hasConstruction) {
        card.classList.add('hidden');
        return;
      }
      card.classList.remove('hidden');
      if (summary.totals.demolitionAreaM2 > 0) {
        appendConstructionRow(body, 'Pareti da demolire', summary.totals.demolitionAreaM2, 'm²');
        appendConstructionRow(body, 'Volume geometrico demolizioni', summary.totals.demolitionVolumeM3, 'm³');
      }
      if (summary.totals.newWallAreaM2 > 0) {
        appendConstructionRow(body, 'Nuove murature', summary.totals.newWallAreaM2, 'm²');
        appendConstructionRow(body, 'Volume geometrico nuove murature', summary.totals.newWallVolumeM3, 'm³');
        appendConstructionRow(body, 'Due facce nuove da finire', summary.totals.newWallFinishFacesM2, 'm²');
      }
      return;
    }

    card.classList.add('hidden');
  }

  function renderWorkRooms() {
    renderConstructionAutoCard();
    var wrap = $('worksRoomStrip');
    wrap.innerHTML = '';
    function chip(label, sub, target) {
      var b = document.createElement('button');
      b.className = 'work-room-chip' + (workTarget.type === target.type && workTarget.id === target.id ? ' active' : '');
      b.textContent = label;
      if (sub) {
        var sm = document.createElement('small');
        sm.textContent = sub;
        b.appendChild(sm);
      }
      b.addEventListener('click', function () {
        workTarget = target;
        $('workSearchInput').value = '';
        renderWorkRooms();
        renderWorkSuggestions();
        renderSelectedWorks();
        $('workSearchInput').focus();
      });
      wrap.appendChild(b);
    }
    chip('TUTTA LA CASA', works.filter(function (w) { return w.targetType === 'plan'; }).length + ' lavori',
      { type:'plan', id:null, name:'Tutta la casa', roomType:'altro' });
    if (workTarget.type === 'wall') {
      var selectedWall = walls.find(function (wall) { return wall.id === workTarget.id; });
      var selectedWallCount = works.filter(function (w) { return w.targetType === 'wall' && w.targetId === workTarget.id; }).length;
      var selectedWallArea = selectedWall && Number.isFinite(selectedWall.lengthCm)
        ? (selectedWall.lengthCm / 100) * wallHeightM
        : null;
      chip(String(workTarget.name || 'Muro').toUpperCase(),
        (Number.isFinite(selectedWallArea) ? selectedWallArea.toFixed(2).replace('.', ',') + ' m² · ' : '') + selectedWallCount + ' lavori',
        workTarget);
    }
    rooms.forEach(function (room) {
      var count = works.filter(function (w) { return w.targetType === 'room' && w.targetId === room.id; }).length;
      var area = roomAreaForWork(room.id);
      chip(String(room.name || 'Ambiente').toUpperCase(),
        (Number.isFinite(area) ? area.toFixed(1).replace('.', ',') + ' m² · ' : '') + count + ' lavori',
        { type:'room', id:room.id, name:room.name || 'Ambiente', roomType:room.type || roomTypeFromName(room.name) });
    });
  }

  function renderWorkSuggestions() {
    if ($('worksScreen').classList.contains('hidden')) return;
    renderConstructionAutoCard();
    $('worksTargetTitle').textContent = workTargetLabel();
    var query = $('workSearchInput').value || '';
    var usage = loadWorkUsage(localStorage);
    var suggestionLimit = workTarget.type === 'wall' ? 30 : (query.trim() ? 10 : 8);
    var suggestions = searchWorkCatalog(workCatalog, query, {
      usage: usage,
      roomType: workTarget.roomType || 'altro',
      limit: suggestionLimit
    });
    if (workTarget.type === 'wall') {
      suggestions = suggestions.filter(function (item) {
        var rule = String(item.quantityRule || '');
        return rule.indexOf('WALL_') === 0 ||
          ['ROOM_NET_WALLS', 'ROOM_GROSS_WALLS', 'ROOM_TILING', 'ROOM_TILING_OR_NET_WALLS'].indexOf(rule) !== -1 ||
          String(item.id || '').indexOf('wall.') === 0 ||
          ['drywall.wall', 'drywall.partition'].indexOf(String(item.id || '')) !== -1;
      }).slice(0, query.trim() ? 10 : 8);
    }
    var wrap = $('workSuggestions');
    wrap.innerHTML = '';
    suggestions.forEach(function (item) {
      var b = document.createElement('button');
      b.className = 'work-suggestion';
      var left = document.createElement('span');
      var title = document.createElement('b');
      title.textContent = item.label;
      var meta = document.createElement('small');
      meta.textContent = item.category + (item.unit ? ' · ' + item.unit : '');
      left.appendChild(title); left.appendChild(meta);
      var plus = document.createElement('span');
      plus.className = 'plus'; plus.textContent = '+';
      b.appendChild(left); b.appendChild(plus);
      b.addEventListener('click', function () { addWorkItem(item); });
      wrap.appendChild(b);
    });
  }

  function addWorkItem(item) {
    var duplicate = works.find(function (w) {
      return w.catalogId === item.id && w.targetType === workTarget.type && w.targetId === workTarget.id;
    });
    if (duplicate) {
      toast('Già aggiunto qui');
      $('workSearchInput').value = '';
      renderWorkSuggestions();
      $('workSearchInput').focus();
      return;
    }
    checkpoint();
    works.push({
      id: uid('work'),
      catalogId: item.id,
      label: item.label,
      targetType: workTarget.type,
      targetId: workTarget.id,
      targetName: workTarget.name,
      quantityRule: item.quantityRule,
      unit: item.unit || '',
      createdAt: new Date().toISOString()
    });
    recordWorkUse(item.id, localStorage);
    var plan = currentPlan();
    if (plan && plan.backend) plan.backend.reportDirty = true;
    persistActive();
    $('workSearchInput').value = '';
    renderWorkRooms();
    renderWorkSuggestions();
    renderSelectedWorks();
    $('workSearchInput').focus();
    vibrate(15);
  }

  function removeWorkItem(id) {
    checkpoint();
    works = works.filter(function (w) { return w.id !== id; });
    var plan = currentPlan();
    if (plan && plan.backend) plan.backend.reportDirty = true;
    persistActive();
    renderWorkRooms();
    renderSelectedWorks();
  }

  function renderSelectedWorks() {
    var list = works.filter(function (w) {
      return w.targetType === workTarget.type && w.targetId === workTarget.id;
    });
    $('worksSelectedCount').textContent = String(list.length);
    var wrap = $('worksSelectedList');
    wrap.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'work-selected-empty';
      empty.textContent = 'Nessuna lavorazione aggiunta';
      wrap.appendChild(empty);
      return;
    }
    list.forEach(function (work) {
      var row = document.createElement('div');
      row.className = 'work-selected';
      var left = document.createElement('span');
      var b = document.createElement('b'); b.textContent = work.label;
      var sm = document.createElement('small');
      var plan = currentPlan();
      var resolved = plan && plan.backend && plan.backend.result && Array.isArray(plan.backend.result.works)
        ? plan.backend.result.works.find(function (row) { return row.id === work.id; })
        : null;
      if (resolved && Number.isFinite(resolved.quantity)) {
        sm.className = 'resolved';
        sm.textContent = '✓ BACKEND · ' + resolved.quantity.toFixed(2).replace('.', ',') + (resolved.unit ? ' ' + resolved.unit : '');
      } else {
        sm.textContent = plan && plan.backend && plan.backend.result ? 'Da rielaborare' : (work.unit ? 'Quantità dal backend · ' + work.unit : 'Da verificare nel report');
      }
      left.appendChild(b); left.appendChild(sm);
      var del = document.createElement('button'); del.textContent = '×';
      del.addEventListener('click', function () { removeWorkItem(work.id); });
      row.appendChild(left); row.appendChild(del);
      wrap.appendChild(row);
    });
  }

  function processFromWorks() {
    closeWorks();
    if (settings.serverUrl && settings.apiKey) openCalc();
    else exportJson();
  }

  function openTools() {
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
    works = [];
    diagonals = [];
    quoteFirst = null;
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
    $('toolsBtn').classList.remove('hidden');
    $('roomRectBtn').classList.remove('hidden');
    $('clearBtn').classList.toggle('hidden', !has);
    $('solvePlanBtn').classList.toggle('hidden', !has);
    $('roomBtn').classList.toggle('hidden', !has);
    $('surfacesBtn').classList.toggle('hidden', !has);
    $('presentBtn').classList.toggle('hidden', !has);
    $('notesBtn').classList.toggle('hidden', !has);
    $('worksBtn').classList.toggle('hidden', !has);
    $('calcBtn').classList.toggle('hidden', !has);
    $('quoteBtn').classList.toggle('hidden', !has);
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
    var text = wall.lengthCm ? metersText(wall.lengthCm) + ' m' : '?';
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

  function openingSegmentOnWall(opening, wall) {
    if (!opening || !wall) return null;
    var centerT = Number.isFinite(opening.position) ? opening.position : 0.5;
    if (Number.isFinite(opening.offsetCm) && Number.isFinite(opening.widthCm) &&
        Number.isFinite(wall.lengthCm) && wall.lengthCm > 0) {
      var centerCm = opening.referenceEnd === 'b'
        ? wall.lengthCm - opening.offsetCm - opening.widthCm / 2
        : opening.offsetCm + opening.widthCm / 2;
      centerT = centerCm / wall.lengthCm;
    }

    var widthT;
    if (Number.isFinite(opening.widthCm) && Number.isFinite(wall.lengthCm) && wall.lengthCm > 0) {
      widthT = opening.widthCm / wall.lengthCm;
    } else {
      widthT = opening.type === 'door' ? 0.16 : 0.20;
    }
    widthT = Math.max(0.025, Math.min(0.85, widthT));

    var t1 = Math.max(0, Math.min(1, centerT - widthT / 2));
    var t2 = Math.max(0, Math.min(1, centerT + widthT / 2));
    if (t2 < t1) { var swap = t1; t1 = t2; t2 = swap; }

    function at(t) {
      return {
        x: wall.a.x + (wall.b.x - wall.a.x) * t,
        y: wall.a.y + (wall.b.y - wall.a.y) * t
      };
    }

    return {
      t1: t1,
      t2: t2,
      a: at(t1),
      b: at(t2),
      center: at((t1 + t2) / 2)
    };
  }

  function wallEndForVisualSide(wall, side) {
    if (!wall) return side === 'right' ? 'b' : 'a';
    var a = worldToScreen(wall.a);
    var b = worldToScreen(wall.b);
    if (Math.abs(a.x - b.x) < 1) {
      var topEnd = a.y <= b.y ? 'a' : 'b';
      return side === 'right' ? (topEnd === 'a' ? 'b' : 'a') : topEnd;
    }
    var leftEnd = a.x <= b.x ? 'a' : 'b';
    return side === 'right' ? (leftEnd === 'a' ? 'b' : 'a') : leftEnd;
  }

  function doorHingeLabel(opening) {
    var wall = openingWall(opening);
    if (!wall) return opening && opening.hingeEnd === 'b' ? 'DESTRA' : 'SINISTRA';
    return opening.hingeEnd === wallEndForVisualSide(wall, 'right') ? 'DESTRA' : 'SINISTRA';
  }

  function roomSideForWall(wall) {
    if (!wall) return null;
    var face = buildFaces(walls).find(function (candidate) {
      return candidate && Array.isArray(candidate.wallIds) && candidate.wallIds.indexOf(wall.id) !== -1;
    });
    if (!face || !face.centroid) return null;
    var dx = wall.b.x - wall.a.x;
    var dy = wall.b.y - wall.a.y;
    var px = face.centroid.x - wall.a.x;
    var py = face.centroid.y - wall.a.y;
    var cross = dx * py - dy * px;
    if (Math.abs(cross) < 1e-6) return null;
    return cross > 0 ? 1 : -1;
  }

  function syncDoorMotion(opening) {
    if (!opening || opening.type !== 'door') return opening;
    var wall = openingWall(opening);
    var kind = normalizeDoorKind(opening.doorKind || 'internal');
    var meta = doorKindSpec(kind);
    opening.doorKind = kind;

    if (meta.sliding) {
      if (opening.slideTo !== 'a' && opening.slideTo !== 'b') {
        opening.slideTo = wall ? wallEndForVisualSide(wall, 'right') : 'b';
      }
      opening.swingDirection = null;
      opening.swingSide = null;
      opening.hingeEnd = null;
      return opening;
    }

    if (opening.hingeEnd !== 'a' && opening.hingeEnd !== 'b') {
      opening.hingeEnd = wall ? wallEndForVisualSide(wall, 'left') : 'a';
    }
    if (opening.swingDirection !== 'outward') opening.swingDirection = 'inward';

    var inside = roomSideForWall(wall);
    if (inside == null) {
      if (opening.swingSide !== -1 && opening.swingSide !== 1) opening.swingSide = 1;
    } else {
      opening.swingSide = opening.swingDirection === 'outward' ? -inside : inside;
    }
    return opening;
  }

  function renderDoorMotionControls(opening) {
    var wrap = $('doorSwingControls');
    if (!wrap) return;
    var isDoor = opening && opening.type === 'door';
    wrap.classList.toggle('hidden', !isDoor);
    if (!isDoor) return;

    syncDoorMotion(opening);
    var meta = doorKindSpec(opening.doorKind);

    if (meta.sliding) {
      $('doorHingeBtn').disabled = false;
      $('doorHingeBtn').querySelector('span').textContent = 'SCORRIMENTO';
      $('doorHingeValue').textContent = opening.slideTo === wallEndForVisualSide(openingWall(opening), 'right') ? 'DESTRA' : 'SINISTRA';
      $('doorSwingBtn').disabled = true;
      $('doorSwingBtn').querySelector('span').textContent = 'APERTURA';
      $('doorSwingValue').textContent = 'SCORREVOLE';
      $('doorInvertBtn').querySelector('small').textContent = 'scorrimento';
      return;
    }

    $('doorHingeBtn').querySelector('span').textContent = meta.leaves === 2 ? 'CERNIERE' : 'CERNIERA';
    $('doorHingeValue').textContent = meta.leaves === 2 ? 'DUE LATI' : doorHingeLabel(opening);
    $('doorHingeBtn').disabled = meta.leaves === 2;
    $('doorSwingBtn').disabled = false;
    $('doorSwingBtn').querySelector('span').textContent = 'APERTURA';
    $('doorSwingValue').textContent = opening.swingDirection === 'outward' ? 'ESTERNA' : 'INTERNA';
    $('doorInvertBtn').querySelector('small').textContent = 'porta';
  }

  function toggleDoorHinge() {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening || opening.type !== 'door') return;
    var meta = doorKindSpec(opening.doorKind);
    var wall = openingWall(opening);

    checkpoint();
    if (meta.sliding) {
      opening.slideTo = opening.slideTo === 'a' ? 'b' : 'a';
    } else if (meta.leaves === 1) {
      opening.hingeEnd = opening.hingeEnd === 'a' ? 'b' : 'a';
    }
    syncDoorMotion(opening);
    persistActive();
    renderOpeningQuick();
    render();
    vibrate(12);
  }

  function toggleDoorSwing() {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening || opening.type !== 'door') return;
    var meta = doorKindSpec(opening.doorKind);
    if (meta.sliding) return;

    checkpoint();
    opening.swingDirection = opening.swingDirection === 'outward' ? 'inward' : 'outward';
    syncDoorMotion(opening);
    persistActive();
    renderOpeningQuick();
    render();
    vibrate(12);
  }

  function invertDoorMotion() {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening || opening.type !== 'door') return;
    var meta = doorKindSpec(opening.doorKind);

    checkpoint();
    if (meta.sliding) {
      opening.slideTo = opening.slideTo === 'a' ? 'b' : 'a';
    } else {
      if (meta.leaves === 1) opening.hingeEnd = opening.hingeEnd === 'a' ? 'b' : 'a';
      opening.swingDirection = opening.swingDirection === 'outward' ? 'inward' : 'outward';
    }
    syncDoorMotion(opening);
    persistActive();
    renderOpeningQuick();
    render();
    vibrate(16);
  }

  function drawOpening(opening) {
    var wall = walls.find(function (w) { return w.id === opening.wallId; });
    if (!wall) return;
    var segment = openingSegmentOnWall(opening, wall);
    if (!segment) return;

    var a = worldToScreen(segment.a);
    var b = worldToScreen(segment.b);
    var center = worldToScreen(segment.center);
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var len = Math.max(1, Math.hypot(dx, dy));
    var ux = dx / len;
    var uy = dy / len;
    var nx = -uy;
    var ny = ux;
    var active = opening.id === currentOpeningId ||
      (mode === 'select' && selectedEntity && selectedEntity.type === 'opening' && selectedEntity.id === opening.id);

    ctx.save();

    // Vera apertura: cancella il tratto di muro tra i due stipiti.
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = active ? 14 : 12;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(a.x - ux * 2, a.y - uy * 2);
    ctx.lineTo(b.x + ux * 2, b.y + uy * 2);
    ctx.stroke();

    // Stipiti / bordi apertura.
    ctx.strokeStyle = active ? '#2563eb' : '#0f172a';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(a.x + nx * 5, a.y + ny * 5);
    ctx.lineTo(a.x - nx * 5, a.y - ny * 5);
    ctx.moveTo(b.x + nx * 5, b.y + ny * 5);
    ctx.lineTo(b.x - nx * 5, b.y - ny * 5);
    ctx.stroke();

    if (opening.type === 'door') {
      syncDoorMotion(opening);
      var doorMeta = doorKindSpec(opening.doorKind);
      var doorStroke = opening.armored ? 3.3 : 2;

      if (doorMeta.sliding) {
        // Porta scorrevole: pannello parallelo al muro + freccia del verso.
        var slideSign = opening.slideTo === 'a' ? -1 : 1;
        var panelOffset = 8;
        ctx.strokeStyle = active ? '#2563eb' : '#334155';
        ctx.lineWidth = doorStroke;
        ctx.beginPath();
        ctx.moveTo(a.x + nx * panelOffset, a.y + ny * panelOffset);
        ctx.lineTo(b.x + nx * panelOffset, b.y + ny * panelOffset);
        ctx.stroke();

        var arrowBase = slideSign < 0 ? b : a;
        var arrowTip = slideSign < 0 ? a : b;
        var ax = arrowTip.x - arrowBase.x;
        var ay = arrowTip.y - arrowBase.y;
        var al = Math.max(1, Math.hypot(ax, ay));
        var auX = ax / al, auY = ay / al;
        var tipX = center.x + auX * Math.min(18, len * .25);
        var tipY = center.y + auY * Math.min(18, len * .25);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(center.x - auX * 12, center.y - auY * 12);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(tipX - auX * 6 + auY * 4, tipY - auY * 6 - auX * 4);
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - auX * 6 - auY * 4, tipY - auY * 6 + auX * 4);
        ctx.stroke();
      } else if (doorMeta.leaves === 2) {
        // Doppia anta: due cerniere ai lati e apertura verso lo stesso ambiente.
        var half = len / 2;
        var side2 = opening.swingSide === -1 ? -1 : 1;
        var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        [
          { hinge: a, closed: mid, sign: 1 },
          { hinge: b, closed: mid, sign: -1 }
        ].forEach(function (leaf) {
          var ldx = leaf.closed.x - leaf.hinge.x;
          var ldy = leaf.closed.y - leaf.hinge.y;
          var lr = Math.max(8, Math.hypot(ldx, ldy));
          var openTip = {
            x: leaf.hinge.x + (-ldy / lr) * lr * side2,
            y: leaf.hinge.y + (ldx / lr) * lr * side2
          };
          ctx.strokeStyle = active ? '#2563eb' : '#334155';
          ctx.lineWidth = doorStroke;
          ctx.beginPath();
          ctx.moveTo(leaf.hinge.x, leaf.hinge.y);
          ctx.lineTo(openTip.x, openTip.y);
          ctx.stroke();

          ctx.strokeStyle = active ? '#60a5fa' : '#94a3b8';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          var sa2 = Math.atan2(leaf.closed.y - leaf.hinge.y, leaf.closed.x - leaf.hinge.x);
          var ea2 = Math.atan2(openTip.y - leaf.hinge.y, openTip.x - leaf.hinge.x);
          ctx.arc(leaf.hinge.x, leaf.hinge.y, Math.min(lr, half), sa2, ea2, side2 < 0);
          ctx.stroke();
        });
      } else {
        // Porta singola: anta + arco di rotazione.
        var hingeAtA = opening.hingeEnd === 'a';
        var hinge = hingeAtA ? a : b;
        var closedTip = hingeAtA ? b : a;
        var leafDx = closedTip.x - hinge.x;
        var leafDy = closedTip.y - hinge.y;
        var radius = Math.max(10, Math.hypot(leafDx, leafDy));
        var side = opening.swingSide === -1 ? -1 : 1;
        var openTip = {
          x: hinge.x + (-leafDy / radius) * radius * side,
          y: hinge.y + (leafDx / radius) * radius * side
        };

        ctx.strokeStyle = active ? '#2563eb' : '#334155';
        ctx.lineWidth = doorStroke;
        ctx.beginPath();
        ctx.moveTo(hinge.x, hinge.y);
        ctx.lineTo(openTip.x, openTip.y);
        ctx.stroke();

        var startAngle = Math.atan2(closedTip.y - hinge.y, closedTip.x - hinge.x);
        var endAngle = Math.atan2(openTip.y - hinge.y, openTip.x - hinge.x);
        ctx.strokeStyle = active ? '#60a5fa' : '#94a3b8';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(hinge.x, hinge.y, radius, startAngle, endAngle, side < 0);
        ctx.stroke();
      }

      if (opening.armored) {
        // Piccolo marcatore B = blindata, senza appesantire la pianta.
        ctx.fillStyle = active ? '#2563eb' : '#9a3412';
        ctx.font = '1000 9px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('B', center.x - nx * 11, center.y - ny * 11);
      }
    } else {
      // Finestra / portafinestra tecnica.
      var windowMeta = windowKindSpec(opening.windowKind || 'single', settings);
      ctx.strokeStyle = active ? '#2563eb' : (windowMeta.balconyDoor ? '#15803d' : '#0891b2');
      ctx.lineWidth = 2;

      if (windowMeta.sliding) {
        // Due pannelli sovrapposti e frecce contrapposte.
        [-3.4, 3.4].forEach(function (off, idx) {
          var shrink = len * .18;
          ctx.beginPath();
          ctx.moveTo(a.x + ux * (idx ? shrink : 0) + nx * off, a.y + uy * (idx ? shrink : 0) + ny * off);
          ctx.lineTo(b.x - ux * (idx ? 0 : shrink) + nx * off, b.y - uy * (idx ? 0 : shrink) + ny * off);
          ctx.stroke();
        });
        ctx.lineWidth = 1.2;
        [-1, 1].forEach(function (dir) {
          var tx = center.x + ux * dir * 13;
          var ty = center.y + uy * dir * 13;
          ctx.beginPath();
          ctx.moveTo(center.x, center.y);
          ctx.lineTo(tx, ty);
          ctx.lineTo(tx - ux * dir * 5 + uy * 3, ty - uy * dir * 5 - ux * 3);
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - ux * dir * 5 - uy * 3, ty - uy * dir * 5 + ux * 3);
          ctx.stroke();
        });
      } else {
        [-2.8, 2.8].forEach(function (off) {
          ctx.beginPath();
          ctx.moveTo(a.x + nx * off, a.y + ny * off);
          ctx.lineTo(b.x + nx * off, b.y + ny * off);
          ctx.stroke();
        });

        // Divisioni delle ante: 2 o 3 campi leggibili in pianta.
        var leaves = Math.max(1, Number(windowMeta.leaves) || 1);
        for (var wi = 1; wi < leaves; wi++) {
          var ratio = wi / leaves;
          var mx = a.x + (b.x - a.x) * ratio;
          var my = a.y + (b.y - a.y) * ratio;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(mx + nx * 5, my + ny * 5);
          ctx.lineTo(mx - nx * 5, my - ny * 5);
          ctx.stroke();
        }
      }

      if (windowMeta.balconyDoor) {
        ctx.fillStyle = active ? '#2563eb' : '#166534';
        ctx.font = '1000 8px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('PF', center.x - nx * 11, center.y - ny * 11);
      }
    }


    // Durante il posizionamento mostra davvero la quota dall'angolo al bordo.
    if (sheetType === 'opening-offset' && opening.id === currentOpeningId) {
      var cornerWorld = opening.referenceEnd === 'b' ? wall.b : wall.a;
      var edgeWorld = opening.referenceEnd === 'b' ? segment.b : segment.a;
      var corner = worldToScreen(cornerWorld);
      var edge = worldToScreen(edgeWorld);
      var qdx = edge.x - corner.x;
      var qdy = edge.y - corner.y;
      var qlen = Math.max(1, Math.hypot(qdx, qdy));
      var qnx = -qdy / qlen;
      var qny = qdx / qlen;
      var off = 22;
      var c1 = { x: corner.x + qnx * off, y: corner.y + qny * off };
      var c2 = { x: edge.x + qnx * off, y: edge.y + qny * off };
      ctx.strokeStyle = '#f59e0b';
      ctx.fillStyle = '#f59e0b';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(c1.x, c1.y);
      ctx.lineTo(c2.x, c2.y);
      ctx.stroke();
      [c1, c2].forEach(function (p) {
        ctx.beginPath();
        ctx.moveTo(p.x - qnx * 5, p.y - qny * 5);
        ctx.lineTo(p.x + qnx * 5, p.y + qny * 5);
        ctx.stroke();
      });
      var qlabel = Number.isFinite(opening.offsetCm)
        ? openingCmText(opening.offsetCm) + ' cm'
        : 'distanza';
      ctx.font = '900 10px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var qmx = (c1.x + c2.x) / 2 + qnx * 10;
      var qmy = (c1.y + c2.y) / 2 + qny * 10;
      var qw = ctx.measureText(qlabel).width + 10;
      ctx.fillStyle = '#fffbeb';
      ctx.strokeStyle = '#f59e0b';
      roundRect(qmx - qw / 2, qmy - 9, qw, 18, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#92400e';
      ctx.fillText(qlabel, qmx, qmy + .5);
    }

    ctx.restore();
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
    drawSelectionOverlay();
    rawStrokes.forEach(function (s) { if (!s.manualEdited) drawPolyline(s.raw, '#cbd5e1', 3); });
    walls.forEach(function (wall) {
      ctx.save();
      var selectionWall = mode === 'select' && selectedEntity && selectedEntity.type === 'wall' && selectedEntity.id === wall.id;
      var wallHighlighted = wall.id === selectedWallId || selectionWall;
      ctx.strokeStyle = wallHighlighted ? '#2563eb' : '#0f172a';
      ctx.lineWidth = wallHighlighted ? 10 : 8;
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
    drawDiagonals();
    openings.forEach(drawOpening);
    drawRoomLabels();
    drawNoteMarkers();
    drawRectRoomPreview();
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

  function pointerScreenPoint(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function touchCentroid() {
    var points = Array.from(touchPointers.values());
    if (points.length < 2) return null;
    return {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2
    };
  }

  function beginTwoFingerPan() {
    var center = touchCentroid();
    if (!center) return false;

    // The second finger changes the gesture from editing to navigation.
    // Drop only transient edits: nothing is added to history or the plan.
    cancelSelectionDragForNavigation();
    currentStroke = null;
    activePointerId = null;
    if (roomPlacementMode && roomDraft && roomDraft.dragging) {
      roomDraft.dragging = false;
      if (firstTouchRoomCenter) roomDraft.center = clone(firstTouchRoomCenter);
    }

    twoFingerPan = { last: center };
    render();
    return true;
  }

  function updateTwoFingerPan() {
    if (!twoFingerPan) return false;
    var center = touchCentroid();
    if (!center) return false;
    viewPanX += center.x - twoFingerPan.last.x;
    viewPanY += center.y - twoFingerPan.last.y;
    twoFingerPan.last = center;
    render();
    return true;
  }

  function finishTouchNavigation(pointerId) {
    touchPointers.delete(pointerId);
    currentStroke = null;
    activePointerId = null;
    if (roomPlacementMode && roomDraft) roomDraft.dragging = false;

    if (twoFingerPan) {
      twoFingerPan = null;
      blockTouchUntilRelease = touchPointers.size > 0;
      persistActive();
    }

    if (!touchPointers.size) {
      blockTouchUntilRelease = false;
      firstTouchRoomCenter = null;
    }
    render();
  }

  function handleCanvasTap(p) {
    if (roomPickMode) return handleRoomPick(p);
    if (notePickMode) return handleNotePick(p);
    if (mode === 'quote') return handleQuotePick(p);
    if (mode === 'measure') {
      var hitWall = nearestWall(p);
      if (!hitWall) return toast('Tocca più vicino a un muro');
      return editWallMeasurement(hitWall.wall);
    }
    if (mode !== 'draw' && mode !== 'select') return placeOpening(p);
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch') {
      e.preventDefault();
      touchPointers.set(e.pointerId, pointerScreenPoint(e));
      if (canvas.setPointerCapture) {
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      }

      if (touchPointers.size === 1) {
        firstTouchRoomCenter = roomPlacementMode && roomDraft && roomDraft.center ? clone(roomDraft.center) : null;
      }
      if (touchPointers.size >= 2) {
        beginTwoFingerPan();
        return;
      }
      if (blockTouchUntilRelease) return;

      var touchPoint = point(e);
      activePointerId = e.pointerId;
      if (roomPlacementMode && roomDraft) {
        roomDraft.dragging = true;
        return;
      }
      if (mode === 'select') {
        beginSelectionPointer(touchPoint, e.pointerId);
        return;
      }
      if (mode === 'draw' && !roomPickMode && !notePickMode) {
        currentStroke = [touchPoint];
        $('emptyHint').classList.add('hidden');
        render();
      }
      return;
    }

    if (e.isPrimary === false) return;
    e.preventDefault();
    var p = point(e);
    if (roomPlacementMode && roomDraft) {
      activePointerId = e.pointerId;
      roomDraft.dragging = true;
      roomDraft.center = p;
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      render();
      return;
    }
    if (mode === 'select') {
      activePointerId = e.pointerId;
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      beginSelectionPointer(p, e.pointerId);
      return;
    }
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
    } else {
      handleCanvasTap(p);
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') {
      if (!touchPointers.has(e.pointerId)) return;
      e.preventDefault();
      touchPointers.set(e.pointerId, pointerScreenPoint(e));
      if (twoFingerPan) {
        updateTwoFingerPan();
        return;
      }
      if (blockTouchUntilRelease) return;
      if (mode === 'select' && selectionDrag && e.pointerId === selectionDrag.pointerId) {
        updateSelectionDrag(point(e), e.pointerId);
        return;
      }
      if (roomPlacementMode && roomDraft && roomDraft.dragging && e.pointerId === activePointerId) {
        roomDraft.center = point(e);
        render();
        return;
      }
      if (mode !== 'draw' || currentStroke === null || e.pointerId !== activePointerId) return;
      var touchPoint = point(e);
      var touchLast = currentStroke[currentStroke.length - 1];
      if (dist(touchLast, touchPoint) >= 3 / viewZoom) currentStroke.push(touchPoint);
      render();
      return;
    }

    if (e.isPrimary === false) return;
    if (mode === 'select' && selectionDrag && e.pointerId === selectionDrag.pointerId) {
      e.preventDefault();
      updateSelectionDrag(point(e), e.pointerId);
      return;
    }
    if (roomPlacementMode && roomDraft && roomDraft.dragging && e.pointerId === activePointerId) {
      e.preventDefault();
      roomDraft.center = point(e);
      render();
      return;
    }
    if (mode !== 'draw' || currentStroke === null || e.pointerId !== activePointerId) return;
    e.preventDefault();
    var p = point(e);
    var last = currentStroke[currentStroke.length - 1];
    if (dist(last, p) >= 3 / viewZoom) currentStroke.push(p);
    render();
  });

  canvas.addEventListener('pointerup', function (e) {
    if (e.pointerType === 'touch') {
      e.preventDefault();

      if (twoFingerPan || blockTouchUntilRelease) {
        finishTouchNavigation(e.pointerId);
        return;
      }

      var touchPoint = point(e);
      touchPointers.delete(e.pointerId);
      firstTouchRoomCenter = null;

      if (mode === 'select' && selectionDrag && e.pointerId === selectionDrag.pointerId) {
        finishSelectionDrag(e.pointerId);
        return;
      }

      if (roomPlacementMode && roomDraft && roomDraft.dragging && e.pointerId === activePointerId) {
        roomDraft.center = touchPoint;
        roomDraft.dragging = false;
        commitRectRoom(touchPoint);
        return;
      }
      if (mode === 'draw' && currentStroke !== null && e.pointerId === activePointerId) {
        if (dist(currentStroke[currentStroke.length - 1], touchPoint) > 2 / viewZoom) currentStroke.push(touchPoint);
        commitStroke();
        return;
      }

      activePointerId = null;
      handleCanvasTap(touchPoint);
      return;
    }

    if (e.isPrimary === false) return;
    if (mode === 'select' && selectionDrag && e.pointerId === selectionDrag.pointerId) {
      e.preventDefault();
      finishSelectionDrag(e.pointerId);
      return;
    }
    if (roomPlacementMode && roomDraft && roomDraft.dragging && e.pointerId === activePointerId) {
      e.preventDefault();
      var roomPoint = point(e);
      roomDraft.center = roomPoint;
      roomDraft.dragging = false;
      commitRectRoom(roomPoint);
      return;
    }
    if (mode !== 'draw' || currentStroke === null || e.pointerId !== activePointerId) return;
    e.preventDefault();
    var p = point(e);
    if (dist(currentStroke[currentStroke.length - 1], p) > 2 / viewZoom) currentStroke.push(p);
    commitStroke();
  });

  canvas.addEventListener('pointercancel', function (e) {
    if (e.pointerType === 'touch') {
      if (selectionDrag && e.pointerId === selectionDrag.pointerId) cancelSelectionDragForNavigation();
      finishTouchNavigation(e.pointerId);
      return;
    }
    if (selectionDrag && e.pointerId === selectionDrag.pointerId) {
      cancelSelectionDragForNavigation();
      render();
      return;
    }
    if (e.pointerId !== activePointerId) return;
    if (roomPlacementMode && roomDraft) {
      roomDraft.dragging = false;
      activePointerId = null;
      render();
      return;
    }
    currentStroke = null;
    activePointerId = null;
    updateUI();
    render();
  });

  $('newPlanBtn').addEventListener('click', newPlan);
  $('serverBadge').addEventListener('click', openConnectionDiagnostics);
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettingsBtn').addEventListener('click', closeSettings);
  $('openConnectionDiagBtn').addEventListener('click', openConnectionDiagnostics);
  $('closeConnectionDiagBtn').addEventListener('click', closeConnectionDiagnostics);
  $('runConnectionDiagBtn').addEventListener('click', runConnectionDiagnostics);
  $('connectionDiagBackdrop').addEventListener('click', function (e) { if (e.target === $('connectionDiagBackdrop')) closeConnectionDiagnostics(); });
  $('diagSettingsBtn').addEventListener('click', function () { closeConnectionDiagnostics(); openSettings(); });
  $('diagReconnectBtn').addEventListener('click', async function () {
    await reconnectBridge();
    await runConnectionDiagnostics();
  });
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('testServerBtn').addEventListener('click', testServer);
  $('scanQrBtn').addEventListener('click', scanBackendQr);
  $('reconnectBridgeBtn').addEventListener('click', reconnectBridge);
  $('disconnectBridgeBtn').addEventListener('click', disconnectBridge);
  $('scanLaserBtn').addEventListener('click', scanLaser);
  $('connectLaserBtn').addEventListener('click', connectSelectedLaser);
  $('disconnectLaserBtn').addEventListener('click', disconnectLaser);
  $('backBtn').addEventListener('click', function () { persistActive(); showDashboard(); });
  $('drawBtn').addEventListener('click', function () { setMode('draw'); });
  $('selectBtn').addEventListener('click', function () { setMode('select'); });
  $('createRoomBtn').addEventListener('click', openRectRoomModal);
  $('editSelectedBtn').addEventListener('click', editSelectedEntity);
  $('wallStateBtn').addEventListener('click', openWallStateEditor);
  $('closeWallStateBtn').addEventListener('click', closeWallStateEditor);
  $('saveWallStateBtn').addEventListener('click', saveWallConstructionState);
  $('wallStateBackdrop').addEventListener('click', function (e) {
    if (e.target === $('wallStateBackdrop')) closeWallStateEditor();
  });
  document.querySelectorAll('#wallStateBackdrop [data-wall-state]').forEach(function (button) {
    button.addEventListener('click', function () { setWallConstructionState(button.dataset.wallState); });
  });
  document.querySelectorAll('#wallThicknessPanel [data-wall-thickness]').forEach(function (button) {
    button.addEventListener('click', function () { chooseWallThickness(button.dataset.wallThickness); });
  });
  $('wallThicknessCustom').addEventListener('input', function () {
    var value = parseWallThicknessInput();
    wallThicknessDraft = Number.isFinite(value) ? value : null;
    document.querySelectorAll('#wallThicknessPanel [data-wall-thickness]').forEach(function (button) {
      button.classList.toggle('active', Number(button.dataset.wallThickness) === Number(wallThicknessDraft));
    });
    var summary = 'Stato: ' + wallStateLabel(wallStateDraft) +
      (Number.isFinite(wallThicknessDraft)
        ? ' · spessore ' + String(wallThicknessDraft).replace('.', ',') + ' cm'
        : ' · scegli lo spessore');
    $('wallStateSummary').textContent = summary;
  });
  $('workSelectedBtn').addEventListener('click', openWorksForSelection);
  $('deleteSelectedBtn').addEventListener('click', deleteSelectedEntity);
  $('closeSelectionBtn').addEventListener('click', function () { clearSelection(true); });
  $('doorBtn').addEventListener('click', function () { setMode('door'); });
  $('windowBtn').addEventListener('click', function () { setMode('window'); });
  $('measureBtn').addEventListener('click', startMeasureMode);
  $('doneBtn').addEventListener('click', openWorks);
  $('undoBtn').addEventListener('click', undo);
  $('saveBtn').addEventListener('click', function () { persistActive(true); });
  $('toolsBtn').addEventListener('click', openTools);
  $('closeToolsBtn').addEventListener('click', closeTools);
  $('toolsBackdrop').addEventListener('click', function (e) { if (e.target === $('toolsBackdrop')) closeTools(); });
  $('roomRectBtn').addEventListener('click', openRectRoomModal);
  $('closeRectRoomBtn').addEventListener('click', closeRectRoomModal);
  $('rectRoomBackdrop').addEventListener('click', function (e) { if (e.target === $('rectRoomBackdrop')) closeRectRoomModal(); });
  $('swapRectRoomBtn').addEventListener('click', swapRectRoomSides);
  $('startRectRoomBtn').addEventListener('click', startRectRoomPlacement);
  $('rotateRoomPlacementBtn').addEventListener('click', rotateRectRoomPlacement);
  $('cancelRoomPlacementBtn').addEventListener('click', function () { cancelRectRoomPlacement(true); });
  document.querySelectorAll('[data-rect-size]').forEach(function (b) {
    b.addEventListener('click', function () {
      var parts = String(b.dataset.rectSize || '').split('x').map(Number);
      if (parts.length === 2 && parts.every(Number.isFinite)) setRectRoomPreset(parts[0], parts[1]);
    });
  });
  $('closeWorksBtn').addEventListener('click', closeWorks);
  $('worksProcessBtn').addEventListener('click', processFromWorks);
  $('workSearchInput').addEventListener('input', renderWorkSuggestions);
  $('closeOpeningQuickBtn').addEventListener('click', function () { closeOpeningQuick(true); });
  $('openingQuickBackdrop').addEventListener('click', function (e) {
    if (e.target === $('openingQuickBackdrop')) return closeOpeningQuick(true);
    var kindButton = e.target.closest && e.target.closest('[data-door-kind]');
    if (kindButton && $('doorTypeWrap').contains(kindButton)) {
      setDoorKind(kindButton.dataset.doorKind);
      return;
    }
    var windowKindButton = e.target.closest && e.target.closest('[data-window-kind]');
    if (windowKindButton && $('windowTypeWrap').contains(windowKindButton)) {
      setWindowKind(windowKindButton.dataset.windowKind);
      return;
    }
    var presetButton = e.target.closest && e.target.closest('[data-opening-preset]');
    if (presetButton && $('openingQuickBackdrop').contains(presetButton)) {
      applyOpeningPreset(presetButton.dataset.openingPreset);
    }
  });
  $('doorHingeBtn').addEventListener('click', toggleDoorHinge);
  $('doorSwingBtn').addEventListener('click', toggleDoorSwing);
  $('doorInvertBtn').addEventListener('click', invertDoorMotion);
  $('openingReferenceBtn').addEventListener('click', toggleOpeningAdvancedReference);
  $('saveOpeningAdvancedBtn').addEventListener('click', saveOpeningAdvanced);
  $('deleteOpeningQuickBtn').addEventListener('click', deleteCurrentOpening);
  $('clearBtn').addEventListener('click', function () { runTool(clearAll); });
  $('confirmBtn').addEventListener('click', confirmSheet);
  $('laterBtn').addEventListener('click', later);
  $('cornerLeftBtn').addEventListener('click', function () { setOpeningReferenceVisual('left'); });
  $('cornerRightBtn').addEventListener('click', function () { setOpeningReferenceVisual('right'); });
  $('cornerToggleBtn').addEventListener('click', toggleOpeningCorner);
  $('deleteOpeningBtn').addEventListener('click', deleteCurrentOpening);
  $('zoomOutBtn').addEventListener('click', function () { setZoom(viewZoom / 1.25); });
  $('zoomInBtn').addEventListener('click', function () { setZoom(viewZoom * 1.25); });
  $('zoomResetBtn').addEventListener('click', resetView);
  $('rotateBtn').addEventListener('click', rotateView);
  $('worksBtn').addEventListener('click', openWorks);
  $('notesBtn').addEventListener('click', function () { runTool(openNoteTargetChooser); });
  $('roomBtn').addEventListener('click', function () { runTool(openRoomPicker); });
  $('surfacesBtn').addEventListener('click', function () { runTool(openSurfaces); });
  $('presentBtn').addEventListener('click', function () { runTool(openPresentation); });
  $('closePresentationBtn').addEventListener('click', closePresentation);
  $('presentationBackdrop').addEventListener('click', function (e) { if (e.target === $('presentationBackdrop')) closePresentation(); });
  $('solvePlanBtn').addEventListener('click', function () { runTool(openSolver); });
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
  $('addPhotoBtn').addEventListener('click', capturePhotoForCurrentTarget);
  $('photoInput').addEventListener('change', onPhotoSelected);
  $('saveRawNoteBtn').addEventListener('click', function () { saveCurrentNote(false); });
  $('rewriteNoteBtn').addEventListener('click', rewriteCurrentNote);
  $('deleteNoteBtn').addEventListener('click', deleteCurrentNote);
  $('wallHeightInput').addEventListener('change', changeWallHeight);
  $('calcBtn').addEventListener('click', function () { runTool(openCalc); });
  $('quoteBtn').addEventListener('click', function () { runTool(function () { setMode('quote'); }); });
  $('closeCalcBtn').addEventListener('click', closeCalc);
  $('calcBackdrop').addEventListener('click', function (e) { if (e.target === $('calcBackdrop') && !calcBusy) closeCalc(); });
  $('calcSendBtn').addEventListener('click', submitCalc);
  $('calcExportBtn').addEventListener('click', function () { closeCalc(); exportJson(); });
  $('closeResultBtn').addEventListener('click', closeResult);
  $('resultRecalcBtn').addEventListener('click', recalcFromResult);
  $('resultHistoryBtn').addEventListener('click', openResultVersions);
  $('closeResultVersionsBtn').addEventListener('click', closeResultVersions);
  $('resultVersionsBackdrop').addEventListener('click', function (e) { if (e.target === $('resultVersionsBackdrop')) closeResultVersions(); });
  $('resultLatestBtn').addEventListener('click', showLatestResultVersion);
  $('resultStaleBtn').addEventListener('click', recalcFromResult);
  $('resultEditBtn').addEventListener('click', function () { var id = resultPlanId; closeResult(); if (id && id !== activePlanId) openPlan(id); });
  $('resultPdfBtn').addEventListener('click', openResultPdfInReader);
  $('resultDxfBtn').addEventListener('click', function () { downloadResult('dxf'); });
  $('resultPngBtn').addEventListener('click', function () { downloadResult('png'); });
  $('planName').addEventListener('change', function () { persistActive(); });
  document.querySelectorAll('[data-key]').forEach(function (b) { b.addEventListener('click', function () { keypad(b.dataset.key); }); });
  $('sheetBackdrop').addEventListener('click', function (e) { if (e.target === $('sheetBackdrop')) later(); });
  $('settingsBackdrop').addEventListener('click', function (e) { if (e.target === $('settingsBackdrop')) closeSettings(); });
  $('closePdfArchiveBtn').addEventListener('click', closePdfArchive);
  $('pdfArchiveBackdrop').addEventListener('click', function (e) { if (e.target === $('pdfArchiveBackdrop')) closePdfArchive(); });
  $('closePdfReaderBtn').addEventListener('click', function () { closePdfReader(true); });
  $('pdfBackArchiveBtn').addEventListener('click', function () { closePdfReader(true); });
  $('pdfSaveBtn').addEventListener('click', saveCurrentPdf);
  $('pdfPrevBtn').addEventListener('click', function () { if (pdfReader) pdfReader.previous(); });
  $('pdfNextBtn').addEventListener('click', function () { if (pdfReader) pdfReader.next(); });
  $('pdfZoomOutBtn').addEventListener('click', function () { if (pdfReader) pdfReader.zoomOut(); });
  $('pdfZoomInBtn').addEventListener('click', function () { if (pdfReader) pdfReader.zoomIn(); });

  window.addEventListener('online', function () { flushOfflineQueue(); flushPendingPhotos(); });
  setInterval(function () { flushOfflineQueue(); }, 30000);
  window.addEventListener('resize', function () {
    resize();
    if (presentationModel) requestAnimationFrame(renderPresentation);
    if (resultPlanId) requestAnimationFrame(renderResultCanvas);
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden && activePlanId) persistActive(); });

  loadAll();
  showDashboard();
})();
