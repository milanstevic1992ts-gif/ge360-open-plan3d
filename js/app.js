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
import {
  presetsForTarget,
  normalizeWorkItems,
  workItemsLabel,
  noteDisplayStyle,
  migrateIntervention,
  openingInterval,
  mergeOpeningIntervals
} from './site-annotations.js';
import {
  estimateScaleCmPerUnit,
  applyMeasuredWallProportion,
  findTJunctionCandidates
} from './editor-geometry.js';
import { syncDetectedRooms } from './auto-rooms.js';
import { savePhoto, getPhoto, updatePhotoMetadata, deletePhoto, listPlanPhotos, compressPhoto } from './photo-store.js';
import { buildProgressiveTakeoff } from './takeoff.js';
import {
  createPlanBackup,
  listPlanBackups,
  getPlanBackup,
  deletePlanBackups
} from './backup-store.js';
import {
  SITE_STATUSES,
  createSite,
  normalizeSite,
  siteLabel,
  statusLabel,
  siteStats,
  plansForSite
} from './sites.js';

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('stage');
  var ctx = canvas.getContext('2d');
  var wrap = $('stageWrap');

  var LIBRARY_KEY = 'ge360-rilievo-library-v3';
  var SETTINGS_KEY = 'ge360-rilievo-settings-v1';
  var SITES_KEY = 'ge360-cantieri-v1';

  var library = [];
  var sites = [];
  var activeSiteFilter = 'all';
  var editingSiteId = null;
  var siteModalAttachPlanId = null;
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
  var wallMoveMode = null;
  var openingMoveMode = null;
  var sheetType = null;
  var numberText = '';
  var history = [];
  var future = [];
  var liveScaleCmPerUnit = null;
  var editorLayer = 'survey';
  var selectedObject = null;
  var longPressState = null;
  var annotationHitBoxes = [];
  var annotationDrag = null;
  var photoRefs = [];
  var pendingPhotoTarget = null;
  var pendingPhotoPlacement = null;
  var photoObjectUrls = [];
  var backupTimer = null;
  var backupInFlight = false;
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
  var selectedNoteWorks = [];
  var selectedNoteStyle = 'callout';
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

  function saveSites() {
    localStorage.setItem(SITES_KEY, JSON.stringify(sites));
  }

  function scheduleAutoBackup(plan) {
    if (!plan || !plan.id) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(async function () {
      if (backupInFlight) return;
      backupInFlight = true;
      try { await createPlanBackup(plan, 'auto'); } catch (_) {}
      backupInFlight = false;
    }, 1200);
  }

  function loadAll() {
    library = parse(localStorage.getItem(LIBRARY_KEY), []);
    sites = parse(localStorage.getItem(SITES_KEY), []).map(function (site) { return normalizeSite(site); });
    settings = Object.assign(settings, parse(localStorage.getItem(SETTINGS_KEY), {}));
    var migrated = false;
    library.forEach(function (plan) {
      var hadBackend = !!(plan && plan.backend);
      var hadRevision = !!(plan && plan.sourceRevision);
      ensureBackendMetadata(plan);
      if (!Array.isArray(plan.notes)) plan.notes = [];
      plan.notes.forEach(function (note) {
        var before = JSON.stringify(note);
        migrateIntervention(note);
        if (JSON.stringify(note) !== before) migrated = true;
      });
      if (!hadBackend || !hadRevision) migrated = true;
    });
    if (migrated) saveLibrary();
    saveSites();
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
      photos: plan ? (plan.photos || []).length : photoRefs.length,
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
    plan.photos = clone(photoRefs);
    plan.wallHeightM = wallHeightM;
    plan.liveScaleCmPerUnit = Number.isFinite(liveScaleCmPerUnit) ? liveScaleCmPerUnit : null;
    plan.editorLayer = editorLayer;
    plan.view = { zoom: viewZoom, rotation: viewRotation };
    plan.surfaceSummary = surfaceCache && surfaceCache.totals ? clone(surfaceCache.totals) : null;
    plan.takeoff = buildProgressiveTakeoff({
      notes:notes,
      walls:walls,
      openings:openings,
      rooms:rooms,
      surfaceCache:surfaceCache,
      wallHeightM:wallHeightM
    });
    plan.summary = summary();
    ensureBackendMetadata(plan);
    refreshSourceRevision(plan);
    saveLibrary();
    scheduleAutoBackup(plan);
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
      photos: [],
      siteId: activeSiteFilter !== 'all' && activeSiteFilter !== 'none' ? activeSiteFilter : null,
      wallHeightM: 2.70,
      liveScaleCmPerUnit: null,
      editorLayer: 'survey',
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
    notes = clone(plan.notes || []).map(function (note) { return migrateIntervention(note); });
    photoRefs = clone(plan.photos || []);
    pendingPhotoTarget = null;
    notePickMode = null;
    pendingNoteTarget = null;
    currentNoteId = null;
    wallHeightM = Number.isFinite(plan.wallHeightM) && plan.wallHeightM > 0 ? plan.wallHeightM : 2.70;
    liveScaleCmPerUnit = Number.isFinite(plan.liveScaleCmPerUnit) && plan.liveScaleCmPerUnit > 0
      ? plan.liveScaleCmPerUnit
      : estimateScaleCmPerUnit(walls);
    editorLayer = plan.editorLayer === 'works' ? 'works' : 'survey';
    surfaceCache = null;
    roomPickMode = false;
    viewZoom = plan.view && Number.isFinite(plan.view.zoom) ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, plan.view.zoom)) : 1;
    viewRotation = plan.view && Number.isFinite(plan.view.rotation) ? ((plan.view.rotation % 360) + 360) % 360 : 0;
    history = [];
    future = [];
    currentStroke = null;
    selectedWallId = null;
    currentOpeningId = null;
    selectedObject = null;
    openingMoveMode = null;
    annotationDrag = null;
    $('planName').value = plan.name || 'Rilievo';
    setMode('draw', false);
    showEditor();
    updateViewControls();
    syncAutomaticRooms(false);
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
    listPlanPhotos(id).then(function (records) {
      return Promise.all((records || []).map(function (record) { return deletePhoto(record.id); }));
    }).catch(function () {});
    renderDashboard();
  }

  function makeButton(label, cls, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.className = cls;
    b.addEventListener('click', fn);
    return b;
  }

  function currentSite() {
    var plan=currentPlan();
    if (!plan || !plan.siteId) return null;
    return sites.find(function (site) { return String(site.id)===String(plan.siteId); }) || null;
  }

  function fillSiteStatusSelect() {
    var select=$('siteStatusInput');
    select.innerHTML='';
    SITE_STATUSES.forEach(function (status) {
      var option=document.createElement('option');
      option.value=status.code;
      option.textContent=status.label;
      select.appendChild(option);
    });
  }

  function fillExistingSiteSelect(excludeId) {
    var select=$('siteExistingSelect');
    select.innerHTML='';
    var empty=document.createElement('option');
    empty.value='';
    empty.textContent='Scegli un cantiere…';
    select.appendChild(empty);
    sites
      .filter(function (site) { return !excludeId || String(site.id)!==String(excludeId); })
      .sort(function (a,b) { return siteLabel(a).localeCompare(siteLabel(b),'it'); })
      .forEach(function (site) {
        var option=document.createElement('option');
        option.value=site.id;
        option.textContent=siteLabel(site)+' · '+statusLabel(site.status);
        select.appendChild(option);
      });
  }

  function openSiteModal(siteId, attachPlanId) {
    editingSiteId=siteId || null;
    siteModalAttachPlanId=attachPlanId || null;
    fillSiteStatusSelect();
    fillExistingSiteSelect(siteId);

    var site=siteId ? sites.find(function (item) { return String(item.id)===String(siteId); }) : null;
    var attachPlan=attachPlanId ? library.find(function (plan) { return String(plan.id)===String(attachPlanId); }) : null;
    var showExisting=!!(attachPlan && !attachPlan.siteId && sites.length);
    $('siteExistingWrap').classList.toggle('hidden',!showExisting);
    $('siteModalTitle').textContent=site ? 'Modifica cantiere' : (attachPlan ? 'Collega il rilievo' : 'Nuovo cantiere');
    $('siteTitleInput').value=site ? site.title || '' : '';
    $('siteClientInput').value=site ? site.clientName || '' : '';
    $('siteAddressInput').value=site ? site.address || '' : '';
    $('sitePhoneInput').value=site ? site.phone || '' : '';
    $('siteEmailInput').value=site ? site.email || '' : '';
    $('siteStatusInput').value=site ? site.status : 'survey';
    $('siteNotesInput').value=site ? site.notes || '' : '';
    $('deleteSiteBtn').classList.toggle('hidden',!site);
    $('detachPlanSiteBtn').classList.toggle('hidden',!(attachPlan && attachPlan.siteId));
    $('siteBackdrop').classList.remove('hidden');
  }

  function closeSiteModal() {
    $('siteBackdrop').classList.add('hidden');
    editingSiteId=null;
    siteModalAttachPlanId=null;
  }

  function saveSiteFromModal() {
    var input={
      title:$('siteTitleInput').value.trim(),
      clientName:$('siteClientInput').value.trim(),
      address:$('siteAddressInput').value.trim(),
      phone:$('sitePhoneInput').value.trim(),
      email:$('siteEmailInput').value.trim(),
      status:$('siteStatusInput').value,
      notes:$('siteNotesInput').value.trim()
    };
    if (!input.title && !input.clientName && !input.address) return toast('Inserisci almeno cliente, indirizzo o nome cantiere');

    var now=new Date().toISOString();
    var site;
    if (editingSiteId) {
      var idx=sites.findIndex(function (item) { return String(item.id)===String(editingSiteId); });
      if (idx<0) return;
      site=normalizeSite(Object.assign({},sites[idx],input,{updatedAt:now}));
      sites[idx]=site;
    } else {
      site=createSite(Object.assign({},input,{updatedAt:now}),function () { return uid('site'); });
      sites.unshift(site);
      editingSiteId=site.id;
    }

    if (siteModalAttachPlanId) {
      var plan=library.find(function (p) { return String(p.id)===String(siteModalAttachPlanId); });
      if (plan) {
        plan.siteId=site.id;
        plan.updatedAt=now;
        scheduleAutoBackup(plan);
      }
    }

    saveSites();
    saveLibrary();
    closeSiteModal();
    renderDashboard();
    updateUI();
    toast('Cantiere salvato ✓');
  }

  function linkExistingSite() {
    if (!siteModalAttachPlanId) return;
    var siteId=$('siteExistingSelect').value;
    if (!siteId) return toast('Scegli un cantiere');
    var plan=library.find(function (p) { return String(p.id)===String(siteModalAttachPlanId); });
    var site=sites.find(function (x) { return String(x.id)===String(siteId); });
    if (!plan || !site) return;
    plan.siteId=site.id;
    plan.updatedAt=new Date().toISOString();
    site.updatedAt=plan.updatedAt;
    saveLibrary();
    saveSites();
    scheduleAutoBackup(plan);
    closeSiteModal();
    renderDashboard();
    updateUI();
    toast('Rilievo collegato a '+siteLabel(site)+' ✓');
  }

  function detachCurrentPlanSite() {
    if (!siteModalAttachPlanId) return;
    var plan=library.find(function (p) { return String(p.id)===String(siteModalAttachPlanId); });
    if (!plan) return;
    plan.siteId=null;
    plan.updatedAt=new Date().toISOString();
    saveLibrary();
    scheduleAutoBackup(plan);
    closeSiteModal();
    renderDashboard();
    updateUI();
    toast('Rilievo scollegato dal cantiere');
  }

  function deleteEditingSite() {
    if (!editingSiteId) return;
    var site=sites.find(function (x) { return String(x.id)===String(editingSiteId); });
    if (!site) return;
    var linked=library.filter(function (p) { return String(p.siteId || '')===String(site.id); });
    var question='Eliminare il cantiere “'+siteLabel(site)+'”?';
    if (linked.length) question+='\nI '+linked.length+' rilievi resteranno salvati ma senza cantiere.';
    if (!confirm(question)) return;
    linked.forEach(function (plan) { plan.siteId=null; scheduleAutoBackup(plan); });
    sites=sites.filter(function (x) { return String(x.id)!==String(site.id); });
    if (String(activeSiteFilter)===String(site.id)) activeSiteFilter='all';
    saveSites();
    saveLibrary();
    closeSiteModal();
    renderDashboard();
    updateUI();
    toast('Cantiere eliminato');
  }

  function openCurrentPlanSite() {
    closeTools();
    var site=currentSite();
    openSiteModal(site ? site.id : null,activePlanId);
  }

  function renderSiteArchive() {
    var grid = $('siteGrid');
    grid.innerHTML = '';
    $('showAllSitesBtn').classList.toggle('active', activeSiteFilter === 'all');
    $('showNoSiteBtn').classList.toggle('active', activeSiteFilter === 'none');

    sites
      .slice()
      .sort(function (a,b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); })
      .forEach(function (site) {
        var stats = siteStats(site, library);
        var card = document.createElement('article');
        card.className = 'site-card' + (String(activeSiteFilter) === String(site.id) ? ' active' : '');
        var head = document.createElement('div');
        head.className = 'site-card-head';
        var title = document.createElement('b');
        title.textContent = siteLabel(site);
        var badge = document.createElement('span');
        badge.className = 'site-status ' + site.status;
        badge.textContent = statusLabel(site.status);
        head.appendChild(title);
        head.appendChild(badge);

        var meta = document.createElement('div');
        meta.className = 'site-card-meta';
        var bits = [];
        if (site.clientName) bits.push(site.clientName);
        if (site.address) bits.push(site.address);
        bits.push(stats.plans + (stats.plans === 1 ? ' rilievo' : ' rilievi'));
        if (stats.photos) bits.push(stats.photos + ' foto');
        meta.textContent = bits.join(' · ');

        var actions=document.createElement('div');
        actions.className='site-card-actions';
        var filterBtn=document.createElement('button');
        filterBtn.type='button';
        filterBtn.textContent=String(activeSiteFilter)===String(site.id) ? 'MOSTRA TUTTI' : 'APR I RILIEVI';
        filterBtn.addEventListener('click',function () {
          activeSiteFilter=String(activeSiteFilter)===String(site.id) ? 'all' : site.id;
          renderDashboard();
        });
        var editBtn=document.createElement('button');
        editBtn.type='button';
        editBtn.textContent='MODIFICA';
        editBtn.addEventListener('click',function () { openSiteModal(site.id,null); });
        actions.appendChild(filterBtn);
        actions.appendChild(editBtn);
        card.appendChild(head);
        card.appendChild(meta);
        card.appendChild(actions);
        grid.appendChild(card);
      });
  }

  function renderDashboard() {
    renderSiteArchive();
    var grid = $('planGrid');
    grid.innerHTML = '';
    var visiblePlans = plansForSite(library, activeSiteFilter)
      .sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    $('emptyLibrary').classList.toggle('hidden', visiblePlans.length > 0);

    visiblePlans.forEach(function (plan) {
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
      var linkedSite = sites.find(function (site) { return String(site.id) === String(plan.siteId || ''); }) || null;
      if (linkedSite) {
        var siteLine = document.createElement('div');
        siteLine.className = 'plan-site-line';
        siteLine.textContent = '🏗️ ' + siteLabel(linkedSite);
        info.appendChild(siteLine);
      }
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

  function editorSnapshot() {
    return JSON.stringify({
      rawStrokes:rawStrokes,
      walls:walls,
      openings:openings,
      rooms:rooms,
      notes:notes,
      wallHeightM:wallHeightM,
      liveScaleCmPerUnit:liveScaleCmPerUnit,
      editorLayer:editorLayer
    });
  }

  function restoreEditorSnapshot(raw) {
    var data = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    rawStrokes = data.rawStrokes || [];
    walls = data.walls || [];
    openings = data.openings || [];
    rooms = data.rooms || [];
    notes = (data.notes || []).map(function (note) { return migrateIntervention(note); });
    wallHeightM = Number.isFinite(data.wallHeightM) ? data.wallHeightM : wallHeightM;
    liveScaleCmPerUnit = Number.isFinite(data.liveScaleCmPerUnit) ? data.liveScaleCmPerUnit : estimateScaleCmPerUnit(walls);
    editorLayer = data.editorLayer === 'works' ? 'works' : 'survey';
    surfaceCache = null;
    selectedObject = null;
    openingMoveMode = null;
    wallMoveMode = null;
    annotationDrag = null;
    closeSheet();
    hideObjectActionBar();
    refreshSurfaceCache();
    persistActive();
    updateUI();
    render();
  }

  function checkpoint() {
    history.push(editorSnapshot());
    if (history.length > 40) history.shift();
    future = [];
    updateHistoryButtons();
  }

  function undo() {
    if (!history.length) return toast('Niente da annullare');
    future.push(editorSnapshot());
    if (future.length > 40) future.shift();
    restoreEditorSnapshot(history.pop());
    updateHistoryButtons();
    vibrate(20);
  }

  function redo() {
    if (!future.length) return toast('Niente da ripristinare');
    history.push(editorSnapshot());
    if (history.length > 40) history.shift();
    restoreEditorSnapshot(future.pop());
    updateHistoryButtons();
    vibrate(20);
  }

  function updateHistoryButtons() {
    if ($('undoBtn')) $('undoBtn').disabled = history.length === 0;
    if ($('redoBtn')) $('redoBtn').disabled = future.length === 0;
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

  function screenPoint(e) {
    var r = canvas.getBoundingClientRect();
    return { x:e.clientX-r.left, y:e.clientY-r.top };
  }

  function point(e) {
    return screenToWorld(screenPoint(e));
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

    autoRepairTJunctions();
    syncAutomaticRooms(false);
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

  function hideObjectActionBar() {
    selectedObject = null;
    $('objectActionBar').classList.add('hidden');
    $('objectSwingBtn').classList.add('hidden');
  }

  function showObjectActionBar(type, object, hitT) {
    if (!object) return;
    selectedObject = { type:type, id:object.id, t:Number.isFinite(hitT) ? hitT : .5 };
    if (type === 'wall') {
      selectedWallId = object.id;
      var wi = walls.findIndex(function (w) { return w.id === object.id; });
      $('objectActionLabel').textContent = 'MURO ' + wallReference(wi) +
        (Number.isFinite(object.lengthCm) ? ' · ' + (object.lengthCm / 100).toFixed(2).replace('.', ',') + ' m' : '');
      $('objectMeasureBtn').textContent = '📏 MISURA';
      $('objectSwingBtn').classList.add('hidden');
    } else {
      currentOpeningId = object.id;
      $('objectActionLabel').textContent = (object.type === 'door' ? 'PORTA' : 'FINESTRA') +
        (Number.isFinite(object.widthCm) ? ' · ' + (object.widthCm / 100).toFixed(2).replace('.', ',') + ' m' : '');
      $('objectMeasureBtn').textContent = '📏 LARGHEZZA';
      $('objectSwingBtn').classList.toggle('hidden', object.type !== 'door');
    }
    $('objectActionBar').classList.remove('hidden');
    render();
  }

  function selectedObjectData() {
    if (!selectedObject) return null;
    if (selectedObject.type === 'wall') return walls.find(function (w) { return w.id === selectedObject.id; }) || null;
    return openings.find(function (o) { return o.id === selectedObject.id; }) || null;
  }

  function measureSelectedObject() {
    var obj = selectedObjectData();
    if (!obj) return hideObjectActionBar();
    var type = selectedObject.type;
    hideObjectActionBar();
    if (type === 'wall') editWallMeasurement(obj);
    else editOpening(obj);
  }

  function moveSelectedObject() {
    var obj = selectedObjectData();
    if (!obj) return hideObjectActionBar();
    var selection = selectedObject;
    hideObjectActionBar();
    if (selection.type === 'wall') {
      selectedWallId = obj.id;
      startWallEndpointMove(selection.t <= .5 ? 'a' : 'b');
      return;
    }
    openingMoveMode = { openingId:obj.id };
    currentOpeningId = obj.id;
    toast('Tocca la nuova posizione sullo stesso muro');
    vibrate(14);
  }

  function photoTargetFromSelection() {
    var obj = selectedObjectData();
    if (!obj || !selectedObject) return null;
    if (selectedObject.type === 'wall') {
      var wi = walls.findIndex(function (w) { return w.id === obj.id; });
      var room = roomForWall(obj.id);
      return {
        type:'wall',
        id:obj.id,
        label:'Muro ' + wallReference(wi) + (room ? ' · ' + room.name : ''),
        roomName:room ? room.name : null,
        targetPoint:{x:(obj.a.x+obj.b.x)/2,y:(obj.a.y+obj.b.y)/2}
      };
    }
    var oroom = roomForWall(obj.wallId);
    var ow = walls.find(function (w) { return w.id === obj.wallId; });
    return {
      type:'opening',
      id:obj.id,
      label:(obj.type === 'door' ? 'Porta' : 'Finestra') + (oroom ? ' · ' + oroom.name : ''),
      roomName:oroom ? oroom.name : null,
      targetPoint:ow ? openingWorldPoint(obj,ow) : null
    };
  }

  function capturePhotoForTarget(target) {
    if (!target || !activePlanId) return;
    pendingPhotoTarget = {
      type:String(target.type || 'plan'),
      id:String(target.id || activePlanId),
      label:String(target.label || 'Rilievo'),
      roomName:target.roomName || null,
      targetPoint:target.targetPoint && Number.isFinite(target.targetPoint.x) && Number.isFinite(target.targetPoint.y)
        ? {x:target.targetPoint.x,y:target.targetPoint.y} : null
    };
    $('photoInput').value = '';
    $('photoInput').click();
  }

  async function handlePhotoInput() {
    var file = $('photoInput').files && $('photoInput').files[0];
    if (!file || !pendingPhotoTarget || !activePlanId) return;
    var target = pendingPhotoTarget;
    pendingPhotoTarget = null;

    try {
      toast('Salvataggio foto…');
      var blob = await compressPhoto(file, 1920, .82);
      var id = uid('photo');
      var meta = await savePhoto({
        id:id,
        planId:activePlanId,
        targetType:target.type,
        targetId:target.id,
        targetLabel:target.label,
        roomName:target.roomName,
        targetPoint:target.targetPoint || null,
        name:file.name || 'foto.jpg',
        mime:blob.type || file.type || 'image/jpeg',
        blob:blob,
        createdAt:new Date().toISOString()
      });
      photoRefs.push(meta);
      pendingPhotoPlacement = {
        photoId:meta.id,
        targetPoint:target.targetPoint || null
      };
      closeRoomModal();
      closePhotosGallery();
      $('photoPlacementBanner').classList.remove('hidden');
      persistActive();
      updateUI();
      if (!$('roomBackdrop').classList.contains('hidden') && pendingRoomId) {
        var count = photoCountForTarget('room', pendingRoomId);
        $('roomPhotoCount').textContent = count + ' foto';
      }
      vibrate(24);
      toast(target.targetPoint ? 'Foto salvata · indica da dove hai scattato' : 'Foto collegata ✓');
    } catch (e) {
      toast('Foto non salvata · ' + (e.message || 'errore archivio'));
    }
  }

  function closePhotosGallery() {
    $('photosBackdrop').classList.add('hidden');
    photoObjectUrls.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    });
    photoObjectUrls = [];
    $('photoGallery').innerHTML = '';
  }

  async function renderPhotoGallery() {
    var gallery = $('photoGallery');
    gallery.innerHTML = '';
    photoObjectUrls.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    });
    photoObjectUrls = [];

    var refs = photoRefs.slice().sort(function (a,b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    $('photoGallerySummary').textContent = refs.length
      ? refs.length + (refs.length === 1 ? ' foto collegata al rilievo' : ' foto collegate al rilievo')
      : 'Nessuna foto ancora';

    if (!refs.length) {
      var empty = document.createElement('div');
      empty.className = 'photo-empty';
      empty.textContent = 'Scatta una foto da un muro, da una porta/finestra o da un ambiente.';
      gallery.appendChild(empty);
      return;
    }

    for (const ref of refs) {
      var card = document.createElement('article');
      card.className = 'photo-card';

      var media = document.createElement('div');
      media.className = 'photo-thumb-wrap';
      var img = document.createElement('img');
      img.className = 'photo-thumb';
      img.alt = ref.targetLabel || 'Foto rilievo';
      media.appendChild(img);
      card.appendChild(media);

      try {
        var record = await getPhoto(ref.id);
        if (record && record.blob) {
          var url = URL.createObjectURL(record.blob);
          photoObjectUrls.push(url);
          img.src = url;
        } else {
          media.classList.add('missing');
          media.textContent = 'FOTO NON DISPONIBILE';
        }
      } catch (_) {
        media.classList.add('missing');
        media.textContent = 'FOTO NON DISPONIBILE';
      }

      var info = document.createElement('div');
      info.className = 'photo-card-info';
      var title = document.createElement('b');
      title.textContent = ref.targetLabel || 'Rilievo';
      var meta = document.createElement('span');
      var d = ref.createdAt ? new Date(ref.createdAt).toLocaleString('it-IT',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
      var directionText = Number.isFinite(ref.directionDeg) ? ' · ↗ ' + Math.round(ref.directionDeg) + '°' : '';
      meta.textContent = (ref.roomName ? ref.roomName + ' · ' : '') + d + directionText + (ref.orphaned ? ' · SCOLLEGATA' : '');
      info.appendChild(title);
      info.appendChild(meta);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'photo-delete';
      del.textContent = '🗑';
      del.addEventListener('click', async function () {
        if (!confirm('Eliminare questa foto dal rilievo e dal dispositivo?')) return;
        try { await deletePhoto(ref.id); } catch (_) {}
        photoRefs = photoRefs.filter(function (p) { return p.id !== ref.id; });
        persistActive();
        await renderPhotoGallery();
        updateUI();
        toast('Foto eliminata');
      });

      info.appendChild(del);
      card.appendChild(info);
      gallery.appendChild(card);
    }
  }

  async function openPhotosGallery() {
    closeTools();
    $('photosBackdrop').classList.remove('hidden');
    try {
      var stored = await listPlanPhotos(activePlanId);
      var known = new Set(photoRefs.map(function (p) { return p.id; }));
      stored.forEach(function (record) {
        if (known.has(record.id)) return;
        photoRefs.push({
          id:record.id,
          targetType:record.targetType || 'plan',
          targetId:record.targetId || '',
          targetLabel:record.targetLabel || 'Rilievo',
          roomName:record.roomName || null,
          caption:record.caption || '',
          name:record.name || 'foto.jpg',
          mime:record.mime || 'image/jpeg',
          size:record.size || 0,
          createdAt:record.createdAt || null,
          cameraPoint:record.cameraPoint || null,
          targetPoint:record.targetPoint || null,
          directionDeg:Number.isFinite(record.directionDeg) ? record.directionDeg : null,
          localOnly:true
        });
      });
      persistActive();
    } catch (_) {}
    await renderPhotoGallery();
  }

  function captureSelectedObjectPhoto() {
    var target = photoTargetFromSelection();
    if (!target) return hideObjectActionBar();
    hideObjectActionBar();
    capturePhotoForTarget(target);
  }

  function captureCurrentRoomPhoto() {
    if (!pendingRoomId) return toast('Prima salva o seleziona l’ambiente');
    var room = rooms.find(function (r) { return r.id === pendingRoomId; });
    if (!room) return toast('Ambiente non disponibile');
    var faces = buildFaces(walls);
    var face = matchRoomFace(room, faces);
    capturePhotoForTarget({
      type:'room',
      id:room.id,
      label:room.name || 'Ambiente',
      roomName:room.name || null,
      targetPoint:face && face.centroid ? {x:face.centroid.x,y:face.centroid.y} : null
    });
  }

  function directInterventionSelected() {
    var obj = selectedObjectData();
    if (!obj) return hideObjectActionBar();
    var selection = selectedObject;
    hideObjectActionBar();

    if (selection.type === 'wall') {
      var wi = walls.findIndex(function (w) { return w.id === obj.id; });
      var room = roomForWall(obj.id);
      openNoteEditor({
        type:'wall',
        id:obj.id,
        label:'Muro ' + wallReference(wi) + (room ? ' · ' + room.name : ''),
        roomName:room ? room.name : null,
        context:{
          lengthM:Number.isFinite(obj.lengthCm) ? obj.lengthCm / 100 : null,
          wallHeightM:wallHeightM,
          grossAreaM2:Number.isFinite(obj.lengthCm) ? Number(((obj.lengthCm / 100) * wallHeightM).toFixed(2)) : null
        }
      });
      return;
    }

    var oroom = roomForWall(obj.wallId);
    openNoteEditor({
      type:'opening',
      id:obj.id,
      label:(obj.type === 'door' ? 'Porta' : 'Finestra') + (oroom ? ' · ' + oroom.name : ''),
      roomName:oroom ? oroom.name : null,
      context:{
        openingType:obj.type,
        widthM:Number.isFinite(obj.widthCm) ? obj.widthCm / 100 : null,
        offsetM:Number.isFinite(obj.offsetCm) ? obj.offsetCm / 100 : null,
        referenceEnd:obj.referenceEnd || null
      }
    });
  }

  function deleteSelectedObject() {
    var obj = selectedObjectData();
    if (!obj) return hideObjectActionBar();
    var type = selectedObject.type;
    hideObjectActionBar();
    if (type === 'wall') {
      selectedWallId = obj.id;
      deleteSelectedWall();
    } else {
      currentOpeningId = obj.id;
      deleteCurrentOpening();
    }
  }

  function swingSelectedDoor() {
    var obj = selectedObjectData();
    if (!obj || selectedObject.type !== 'opening' || obj.type !== 'door') return;
    currentOpeningId = obj.id;
    toggleDoorSwing();
    showObjectActionBar('opening', obj, obj.position);
  }

  function updateOpeningMoveAt(p) {
    if (!openingMoveMode) return false;
    var opening = openings.find(function (o) { return o.id === openingMoveMode.openingId; });
    if (!opening) return false;
    var wall = walls.find(function (w) { return w.id === opening.wallId; });
    if (!wall) return false;
    var hit = distToSegment(p, wall.a, wall.b);
    if (hit.distance > 55 / viewZoom) return false;

    opening.position = Math.max(.01, Math.min(.99, hit.t));
    syncOpeningMetricFromPosition(opening, wall);
    currentOpeningId = opening.id;
    surfaceCache = null;
    render();
    return true;
  }

  function startOpeningMoveDrag(e, p) {
    if (!openingMoveMode) return false;
    var opening = openings.find(function (o) { return o.id === openingMoveMode.openingId; });
    var wall = opening ? walls.find(function (w) { return w.id === opening.wallId; }) : null;
    var hit = wall ? distToSegment(p, wall.a, wall.b) : null;
    if (!hit || hit.distance > 55 / viewZoom) {
      toast('Trascina sul muro della ' + (opening && opening.type === 'window' ? 'finestra' : 'porta'));
      return true;
    }
    checkpoint();
    openingMoveMode.dragging = true;
    openingMoveMode.pointerId = e.pointerId;
    updateOpeningMoveAt(p);
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    vibrate(12);
    return true;
  }

  function updateOpeningMoveDrag(e) {
    if (!openingMoveMode || !openingMoveMode.dragging || openingMoveMode.pointerId !== e.pointerId) return false;
    var p = point(e);
    updateOpeningMoveAt(p);
    return true;
  }

  function finishOpeningMoveDrag(e) {
    if (!openingMoveMode || !openingMoveMode.dragging || openingMoveMode.pointerId !== e.pointerId) return false;
    var opening = openings.find(function (o) { return o.id === openingMoveMode.openingId; });
    openingMoveMode = null;
    persistActive();
    updateUI();
    render();
    vibrate(20);
    toast((opening && opening.type === 'window' ? 'Finestra' : 'Porta') + ' spostata ✓');
    return true;
  }

  function armLongPress(pointerId, p) {
    if (mode !== 'draw') return;
    var oh = nearestOpening(p);
    var wh = nearestWall(p);
    var target = null;
    if (oh && oh.distance <= 28 / viewZoom) target = { type:'opening', object:oh.opening, t:oh.opening.position };
    else if (wh && wh.distance <= 28 / viewZoom) target = { type:'wall', object:wh.wall, t:wh.t };
    if (!target) return;

    cancelLongPress();
    longPressState = {
      pointerId:pointerId,
      start:{ x:p.x, y:p.y },
      handled:false,
      timer:setTimeout(function () {
        if (!longPressState || longPressState.pointerId !== pointerId) return;
        longPressState.handled = true;
        currentStroke = null;
        activePointerId = null;
        showObjectActionBar(target.type, target.object, target.t);
        vibrate(35);
      }, 430)
    };
  }

  function cancelLongPress() {
    if (longPressState && longPressState.timer) clearTimeout(longPressState.timer);
    longPressState = null;
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
    orphanPhotosForTarget('opening', opening.id, opening.type === 'door' ? 'Porta eliminata' : 'Finestra eliminata');
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
    wallMoveMode = null;
    $('notesBtn').classList.remove('active');
    $('roomBtn').classList.remove('active');
  }

  function noteTargetKey(type, id) {
    return String(type) + ':' + String(id || '');
  }

  function wallReference(index) {
    var n = Math.max(0, Number(index) || 0);
    var out = '';
    do {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
  }

  function interventionQuantityHint(target) {
    if (!target || !target.context) return null;
    var c = target.context;
    if (target.type === 'floor' && Number.isFinite(c.areaM2)) {
      return { value:c.areaM2, unit:'m2', basis:'floor_area' };
    }
    if (target.type === 'ceiling' && Number.isFinite(c.ceilingM2)) {
      return { value:c.ceilingM2, unit:'m2', basis:'ceiling_area' };
    }
    if (target.type === 'wall' && Number.isFinite(c.grossAreaM2)) {
      return { value:c.grossAreaM2, unit:'m2', basis:'gross_wall_area' };
    }
    if (target.type === 'opening') {
      return { value:1, unit:'cad', basis:'opening_count' };
    }
    if (target.type === 'room' && Number.isFinite(c.areaM2)) {
      return { value:c.areaM2, unit:'m2', basis:'floor_area' };
    }
    return null;
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
        perimeterM: metric && Number.isFinite(metric.perimeterM) ? Number(metric.perimeterM.toFixed(2)) : null,
        wallsM2: metric && Number.isFinite(metric.wallsM2) ? Number(metric.wallsM2.toFixed(2)) : null,
        wallsCeilingM2: metric && Number.isFinite(metric.wallsCeilingM2) ? Number(metric.wallsCeilingM2.toFixed(2)) : null,
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
        label: 'Muro ' + wallReference(idx) + (room ? ' · ' + room.name : ''),
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

  function renderNoteWorkControls(type) {
    var wrap = $('noteWorkPresets');
    wrap.innerHTML = '';
    presetsForTarget(type).forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.workCode = item.code;
      btn.dataset.workCategory = item.category;
      btn.textContent = item.label;
      btn.classList.toggle('selected', selectedNoteWorks.some(function (x) { return x.code === item.code; }));
      btn.addEventListener('click', function () {
        var exists = selectedNoteWorks.some(function (x) { return x.code === item.code; });
        selectedNoteWorks = exists
          ? selectedNoteWorks.filter(function (x) { return x.code !== item.code; })
          : normalizeWorkItems(selectedNoteWorks.concat([item]));
        renderNoteWorkControls(type);
      });
      wrap.appendChild(btn);
    });

    document.querySelectorAll('[data-note-style]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.noteStyle === selectedNoteStyle);
    });
  }

  function setNoteDisplayStyle(style) {
    selectedNoteStyle = noteDisplayStyle(style);
    document.querySelectorAll('[data-note-style]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.noteStyle === selectedNoteStyle);
    });
  }

  function openNoteEditor(target) {
    pendingNoteTarget = target;
    var existing = existingNoteForTarget(target);
    currentNoteId = existing ? existing.id : null;
    $('noteTargetTitle').textContent = target.label;
    $('noteTargetMeta').textContent = target.roomName ? 'Ambiente: ' + target.roomName : '';
    selectedNoteWorks = existing ? normalizeWorkItems(existing.workItems) : [];
    selectedNoteStyle = noteDisplayStyle(existing && existing.displayStyle);
    $('noteRawText').value = existing ? existing.rawText || '' : '';
    $('deleteNoteBtn').classList.toggle('hidden', !existing);
    renderNoteWorkControls(target.type);
    renderNoteAi(existing);
    $('noteEditorBackdrop').classList.remove('hidden');
    requestAnimationFrame(function () {
      if (!selectedNoteWorks.length) $('noteRawText').focus();
    });
  }

  function closeNoteEditor(saveDraft) {
    if (saveDraft !== false && pendingNoteTarget) {
      var raw = $('noteRawText').value.trim();
      if (raw) saveCurrentNote(true);
    }
    $('noteEditorBackdrop').classList.add('hidden');
    pendingNoteTarget = null;
    currentNoteId = null;
    selectedNoteWorks = [];
    selectedNoteStyle = 'callout';
  }

  function saveCurrentNote(silent) {
    if (!pendingNoteTarget) return null;
    var raw = $('noteRawText').value.trim();
    var workItems = normalizeWorkItems(selectedNoteWorks);
    if (!raw && !workItems.length) {
      if (!silent) toast('Scegli una lavorazione o scrivi una nota');
      return null;
    }
    if (!raw) raw = workItemsLabel(workItems);

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
        quantityHint: interventionQuantityHint(pendingNoteTarget),
        kind: 'intervention',
        workItems: workItems,
        displayStyle: selectedNoteStyle,
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
      var workChanged = JSON.stringify(normalizeWorkItems(existing.workItems)) !== JSON.stringify(workItems);
      if (existing.rawText !== raw || workChanged) {
        existing.cleanedText = '';
        existing.tasks = [];
        existing.needsClarification = [];
        existing.model = null;
        existing.rewrittenAt = null;
      }
      existing.kind = 'intervention';
      existing.quantityHint = interventionQuantityHint(pendingNoteTarget);
      existing.workItems = workItems;
      existing.displayStyle = selectedNoteStyle;
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
    if (!silent) toast('Intervento salvato ✓');
    return existing;
  }

  async function rewriteCurrentNote() {
    var note = saveCurrentNote(true);
    if (!note) return toast('Scegli una lavorazione o scrivi una nota');
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
          workItems: note.workItems || [],
          displayStyle: note.displayStyle || 'callout',
          quantityHint: note.quantityHint || null,
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
      toast('Nota intervento sistemata ✓');
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
    if (!confirm('Eliminare questo intervento?')) return;
    checkpoint();
    notes = notes.filter(function (n) { return n.id !== note.id; });
    persistActive();
    updateUI();
    closeNoteEditor(false);
    toast('Intervento eliminato');
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
      offsetCm: null,
      swingSide: mode === 'door' ? 1 : null
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

  function syncOpeningMetricFromPosition(opening, wall) {
    if (!opening || !wall || !Number.isFinite(wall.lengthCm) || wall.lengthCm <= 0) return;
    var t = Math.max(.001, Math.min(.999, Number.isFinite(opening.position) ? opening.position : .5));
    var half = (Number.isFinite(opening.widthCm) ? opening.widthCm : 0) / 2;
    if (opening.referenceEnd === 'b') {
      opening.offsetCm = Math.max(0, Math.round(wall.lengthCm * (1 - t) - half));
    } else {
      opening.offsetCm = Math.max(0, Math.round(wall.lengthCm * t - half));
    }
  }

  function refreshWallInterventionLabels() {
    notes.forEach(function (note) {
      if (note.targetType !== 'wall') return;
      var idx = walls.findIndex(function (w) { return w.id === note.targetId; });
      if (idx < 0) return;
      var room = roomForWall(note.targetId);
      note.targetLabel = 'Muro ' + wallReference(idx) + (room ? ' · ' + room.name : '');
      note.roomName = room ? room.name : null;
    });
  }

  function splitWallAtTJunction(target, branch, branchEnd, point, t) {
    var targetIndex = walls.findIndex(function (w) { return w.id === target.id; });
    if (targetIndex < 0 || !(t > .04 && t < .96)) return false;

    var oldB = { x:target.b.x, y:target.b.y };
    var oldLength = Number.isFinite(target.lengthCm) && target.lengthCm > 0 ? target.lengthCm : null;
    var oldTargetId = target.id;
    var newId = uid('w');
    var firstLength = oldLength ? Math.max(1, Math.round(oldLength * t)) : null;
    var secondLength = oldLength ? Math.max(1, oldLength - firstLength) : null;
    if (oldLength && firstLength + secondLength !== oldLength) secondLength = oldLength - firstLength;

    target.b = { x:point.x, y:point.y };
    if (oldLength) target.lengthCm = firstLength;
    target.derivedSplit = true;
    target.parentWallId = target.parentWallId || oldTargetId;
    target.measurementSource = oldLength ? 'derived_t_split' : (target.measurementSource || 'unmeasured');
    target.parentLengthCm = oldLength || target.parentLengthCm || null;
    target.requiresMeasureVerification = !!oldLength;
    target.splitRatio = t;

    var second = Object.assign({}, target, {
      id:newId,
      a:{ x:point.x, y:point.y },
      b:oldB,
      lengthCm:secondLength,
      parentWallId:target.parentWallId || oldTargetId,
      measurementSource:oldLength ? 'derived_t_split' : 'unmeasured',
      parentLengthCm:oldLength,
      requiresMeasureVerification:!!oldLength,
      splitRatio:1-t,
      derivedSplit:true
    });
    walls.splice(targetIndex + 1, 0, second);
    branch[branchEnd] = { x:point.x, y:point.y };

    rawStrokes.forEach(function (stroke) {
      if (!Array.isArray(stroke.wallIds)) return;
      var pos = stroke.wallIds.indexOf(oldTargetId);
      if (pos >= 0) stroke.wallIds.splice(pos + 1, 0, newId);
    });

    openings.forEach(function (opening) {
      if (opening.wallId !== oldTargetId) return;
      var pos = Number.isFinite(opening.position) ? opening.position : .5;
      if (pos <= t) {
        opening.position = Math.max(.01, Math.min(.99, pos / t));
        syncOpeningMetricFromPosition(opening, target);
      } else {
        opening.wallId = newId;
        opening.position = Math.max(.01, Math.min(.99, (pos - t) / (1 - t)));
        syncOpeningMetricFromPosition(opening, second);
      }
    });

    var duplicates = [];
    notes.forEach(function (note) {
      if (note.targetType !== 'wall' || note.targetId !== oldTargetId) return;
      var copy = clone(note);
      copy.id = uid('note');
      copy.targetId = newId;
      copy.targetKey = noteTargetKey('wall', newId);
      copy.createdAt = new Date().toISOString();
      copy.updatedAt = copy.createdAt;
      duplicates.push(copy);
    });
    notes = notes.concat(duplicates);

    rooms.forEach(function (room) {
      if (!Array.isArray(room.wallIds)) return;
      var pos = room.wallIds.indexOf(oldTargetId);
      if (pos < 0) return;
      if (room.wallIds.indexOf(newId) === -1) room.wallIds.splice(pos + 1, 0, newId);
      room.faceKey = room.wallIds.slice().sort().join('|');
    });

    return true;
  }

  function autoRepairTJunctions() {
    var repaired = 0;
    for (var pass = 0; pass < 8; pass++) {
      var candidates = findTJunctionCandidates(walls, Math.max(8 / viewZoom, 4), .055);
      if (!candidates.length) break;
      var c = candidates[0];
      var branch = walls.find(function (w) { return w.id === c.branchWallId; });
      var target = walls.find(function (w) { return w.id === c.targetWallId; });
      if (!branch || !target) break;

      var h = distToSegment(branch[c.branchEnd], target.a, target.b);
      if (!(h.t > .055 && h.t < .945) || h.distance > Math.max(8 / viewZoom, 4)) break;
      var q = {
        x:target.a.x + (target.b.x - target.a.x) * h.t,
        y:target.a.y + (target.b.y - target.a.y) * h.t
      };
      if (!splitWallAtTJunction(target, branch, c.branchEnd, q, h.t)) break;
      repaired++;
    }

    if (repaired) {
      surfaceCache = null;
      refreshWallInterventionLabels();
      openings.forEach(function (o) { recalcOpeningPosition(o); });
      toast(repaired === 1 ? 'Innesto a T riconosciuto ✓' : repaired + ' innesti a T riconosciuti ✓');
    }
    return repaired;
  }

  function applyClosedGeometryLive() {
    var missing = walls.some(function (w) { return !Number.isFinite(w.lengthCm) || w.lengthCm <= 0; });
    if (missing || !walls.length) return false;
    try {
      var result = solveFloorPlan(solverInput(), { mode:'normal', maxClosureGapCm:10 });
      if (!result.success || !result.closure || !result.closure.closed || (result.errors || []).length) return false;
      var solved = (result.walls || []).filter(function (w) { return w.status === 'solved' && w.a && w.b; });
      if (!solved.length) return false;

      var scale = Number.isFinite(liveScaleCmPerUnit) && liveScaleCmPerUnit > 0 ? liveScaleCmPerUnit : 1;
      var oldBounds = solverPointBounds(walls);
      var solvedUnits = solved.map(function (w) {
        return Object.assign({}, w, {
          a:{ x:w.a.x / scale, y:w.a.y / scale },
          b:{ x:w.b.x / scale, y:w.b.y / scale }
        });
      });
      var newBounds = solverPointBounds(solvedUnits);
      if (!oldBounds || !newBounds) return false;
      var oldCx = (oldBounds.minX + oldBounds.maxX) / 2;
      var oldCy = (oldBounds.minY + oldBounds.maxY) / 2;
      var newCx = (newBounds.minX + newBounds.maxX) / 2;
      var newCy = (newBounds.minY + newBounds.maxY) / 2;
      var byId = new Map(solvedUnits.map(function (w) { return [w.id, w]; }));

      walls = walls.map(function (old) {
        var sw = byId.get(old.id);
        if (!sw) return old;
        return Object.assign({}, old, {
          a:{ x:sw.a.x + oldCx - newCx, y:sw.a.y + oldCy - newCy },
          b:{ x:sw.b.x + oldCx - newCx, y:sw.b.y + oldCy - newCy },
          lengthCm:sw.lengthCm
        });
      });
      rawStrokes = [];
      openings.forEach(function (o) { recalcOpeningPosition(o); });
      return true;
    } catch (_) {
      return false;
    }
  }

  function applyLiveProportion(wallId) {
    var wall = walls.find(function (w) { return w.id === wallId; });
    if (!wall || !Number.isFinite(wall.lengthCm) || wall.lengthCm <= 0) return;

    var tolerance = Math.max(3 / viewZoom, .75);
    var adjusted = applyMeasuredWallProportion(walls, wall.id, liveScaleCmPerUnit, tolerance);
    walls = adjusted.walls;
    liveScaleCmPerUnit = adjusted.scaleCmPerUnit;

    autoRepairTJunctions();
    var globallyClosed = applyClosedGeometryLive();
    surfaceCache = null;
    openings.forEach(function (o) { recalcOpeningPosition(o); });
    refreshSurfaceCache();
    if (adjusted.moved || globallyClosed) vibrate(12);
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

  function toggleDoorSwing() {
    var opening = openings.find(function (o) { return o.id === currentOpeningId; });
    if (!opening || opening.type !== 'door') return;
    opening.swingSide = opening.swingSide === -1 ? 1 : -1;
    persistActive();
    render();
    vibrate(18);
    toast('Apertura porta invertita');
  }

  function orphanPhotosForTarget(type, id, label) {
    photoRefs.forEach(function (photo) {
      if (photo.targetType !== type || String(photo.targetId) !== String(id)) return;
      photo.orphaned = true;
      photo.originalTargetType = type;
      photo.originalTargetId = id;
      photo.targetType = 'plan';
      photo.targetId = activePlanId || '';
      photo.targetLabel = 'SCOLLEGATA · ' + String(label || photo.targetLabel || 'Elemento eliminato');
      photo.roomName = null;
    });
  }

  function deleteSelectedWall() {
    var wall = walls.find(function (w) { return w.id === selectedWallId; });
    if (!wall) return;

    var idx = walls.findIndex(function (w) { return w.id === wall.id; });
    var label = 'Muro ' + wallReference(idx);
    var measure = Number.isFinite(wall.lengthCm) ? ' · ' + (wall.lengthCm / 100).toFixed(2).replace('.', ',') + ' m' : '';
    var linkedOpenings = openings.filter(function (o) { return o.wallId === wall.id; });
    var question = 'Eliminare ' + label + measure + '?';
    if (linkedOpenings.length) question += '\nVerranno eliminate anche ' + linkedOpenings.length + ' aperture collegate.';
    if (!confirm(question)) return;

    checkpoint();

    var openingIds = new Set(linkedOpenings.map(function (o) { return o.id; }));
    orphanPhotosForTarget('wall', wall.id, label);
    linkedOpenings.forEach(function (opening) {
      orphanPhotosForTarget('opening', opening.id, opening.type === 'door' ? 'Porta eliminata' : 'Finestra eliminata');
    });
    openings = openings.filter(function (o) { return o.wallId !== wall.id; });

    notes = notes.filter(function (n) {
      if (n.targetType === 'wall' && n.targetId === wall.id) return false;
      if (n.targetType === 'opening' && openingIds.has(n.targetId)) return false;
      return true;
    });

    rooms = rooms.map(function (room) {
      if (!Array.isArray(room.wallIds) || room.wallIds.indexOf(wall.id) === -1) return room;
      var nextIds = room.wallIds.filter(function (id) { return id !== wall.id; });
      return Object.assign({}, room, {
        wallIds: nextIds,
        faceKey: nextIds.slice().sort().join('|')
      });
    });

    // Il vecchio tratto grezzo non deve rimanere come una linea fantasma.
    rawStrokes = rawStrokes.filter(function (stroke) {
      return !(Array.isArray(stroke.wallIds) && stroke.wallIds.indexOf(wall.id) !== -1);
    });

    walls = walls.filter(function (w) { return w.id !== wall.id; });
    selectedWallId = null;
    surfaceCache = null;
    syncAutomaticRooms(false);
    closeSheet();
    refreshSurfaceCache();
    persistActive();
    updateUI();
    render();
    vibrate(30);
    toast(label + ' eliminato');
  }

  function startWallEndpointMove(end) {
    var wall = walls.find(function (w) { return w.id === selectedWallId; });
    if (!wall || (end !== 'a' && end !== 'b')) return;
    wallMoveMode = {
      wallId: wall.id,
      end: end,
      origin: { x: wall[end].x, y: wall[end].y }
    };
    closeSheet();
    selectedWallId = wall.id;
    toast('Tocca la nuova posizione dell’' + (end === 'a' ? 'inizio' : 'fine') + ' muro');
    vibrate(16);
    render();
  }

  function commitWallEndpointMove(p) {
    if (!wallMoveMode) return false;
    var wall = walls.find(function (w) { return w.id === wallMoveMode.wallId; });
    if (!wall) {
      wallMoveMode = null;
      return false;
    }

    checkpoint();
    var origin = wallMoveMode.origin;
    var tolerance = Math.max(3 / viewZoom, 1e-6);

    // Muove l'intero nodo: tutti i muri che condividono esattamente quell'angolo
    // seguono il punto, così la continuità non viene spezzata.
    walls.forEach(function (candidate) {
      ['a', 'b'].forEach(function (end) {
        if (!candidate[end]) return;
        if (dist(candidate[end], origin) <= tolerance) {
          candidate[end] = { x: p.x, y: p.y };
        }
      });
    });

    // Dopo una modifica manuale la geometria a muri è la fonte visuale.
    // Rimuoviamo gli stroke grezzi per evitare sovrapposizioni fantasma.
    rawStrokes = [];
    surfaceCache = null;
    wallMoveMode = null;
    autoRepairTJunctions();
    syncAutomaticRooms(false);
    openings.forEach(function (o) { recalcOpeningPosition(o); });
    refreshSurfaceCache();
    persistActive();
    updateUI();
    render();
    vibrate(24);
    toast('Angolo spostato ✓');
    return true;
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
    $('deleteWallBtn').classList.toggle('hidden', type !== 'wall');
    $('wallEditActions').classList.toggle('hidden', type !== 'wall');
    $('swingToggleBtn').classList.add('hidden');
    if (type === 'wall') {
      var idx = walls.findIndex(function (w) { return w.id === selectedWallId; });
      $('sheetKicker').textContent = 'MODIFICA MURO ' + wallReference(idx) + ' · ' + (idx + 1) + ' DI ' + walls.length;
    } else {
      var o = openings.find(function (x) { return x.id === currentOpeningId; });
      $('swingToggleBtn').classList.toggle('hidden', !(o && o.type === 'door'));
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
    $('swingToggleBtn').classList.add('hidden');
    $('wallEditActions').classList.add('hidden');
    $('deleteWallBtn').classList.add('hidden');
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
        wall.measurementSource = 'measured';
        wall.requiresMeasureVerification = false;
        applyLiveProportion(wall.id);
        openings.filter(function (o) { return o.wallId === wall.id; }).forEach(function (o) {
          recalcOpeningPosition(o);
        });
      }
      surfaceCache = null;
      var strokeId = wall ? wall.strokeId : null;
      var next = walls.find(function (w) { return w.strokeId === strokeId && !w.lengthCm && w.id !== selectedWallId; });
      if (!next) next = walls.find(function (w) { return !w.lengthCm && w.id !== selectedWallId; });
      syncAutomaticRooms(false);
      persistActive();
      if (next) {
        selectedWallId = next.id;
        numberText = '';
        openSheet('wall');
      } else {
        selectedWallId = null;
        closeSheet();
        refreshSurfaceCache();
        syncAutomaticRooms(true);
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
    syncAutomaticRooms(true);
    persistActive();
    updateUI();
    render();
    closeSolver();
    var repaired = solverResult && solverResult.stats ? (solverResult.stats.repairedJoints || 0) : 0;
    var trulyClosed = !!(solverResult && solverResult.closure && solverResult.closure.closed);
    if (trulyClosed) {
      toast('Pianta chiusa e proporzionata ✓' + (repaired ? ' · ' + repaired + ' giunti ricuciti' : ''));
    } else {
      toast('Pianta sistemata · chiusura da verificare');
    }
  }

  function faceKey(face) {
    return (face && face.wallIds ? face.wallIds.slice().sort().join('|') : '');
  }

  function photoCountForTarget(type, id) {
    return photoRefs.filter(function (p) {
      return p.targetType === type && String(p.targetId) === String(id);
    }).length;
  }

  function openRoomEditorForFace(face, existing, autoPrompt) {
    if (!face) return;
    pendingRoomFace = face;
    var key = faceKey(face);
    if (!existing) {
      existing = rooms.find(function (r) {
        return r.faceKey === key || faceKey({ wallIds:r.wallIds }) === key;
      }) || null;
    }
    pendingRoomId = existing ? existing.id : null;
    selectedRoomName = existing && !existing.needsNaming ? existing.name : '';
    $('roomCustomName').value = existing && existing.custom && !existing.needsNaming ? existing.name : '';
    document.querySelectorAll('[data-room-name]').forEach(function (b) {
      b.classList.toggle('selected', !!(existing && !existing.needsNaming && existing.name === b.dataset.roomName));
    });
    $('roomModalTitle').textContent = autoPrompt ? 'Nuovo ambiente rilevato' : 'Che stanza è?';
    $('roomAutoHint').classList.toggle('hidden', !autoPrompt);
    var count = existing ? photoCountForTarget('room', existing.id) : 0;
    $('roomPhotoCount').textContent = count + (count === 1 ? ' foto' : ' foto');
    $('roomPhotoBtn').disabled = !existing;
    $('roomBackdrop').classList.remove('hidden');
  }

  function syncAutomaticRooms(promptNew) {
    if (!walls.length) return [];
    var faces = buildFaces(walls).filter(function (face) {
      return face && face.quality !== 'verify' && Array.isArray(face.wallIds) && face.wallIds.length >= 3;
    });
    var result = syncDetectedRooms(
      rooms,
      faces,
      function () { return uid('room'); },
      new Date().toISOString()
    );
    rooms = result.rooms;

    if (result.created.length) {
      surfaceCache = null;
      persistActive();
      updateUI();
      render();
    }

    var pendingAuto = rooms.find(function (room) {
      return room && room.needsNaming && !room.geometryMissing;
    }) || null;

    if (promptNew && pendingAuto && $('roomBackdrop').classList.contains('hidden') && $('sheetBackdrop').classList.contains('hidden')) {
      var face = faces.find(function (f) { return faceKey(f) === pendingAuto.faceKey; }) || null;
      if (face) {
        setTimeout(function () {
          openRoomEditorForFace(face, pendingAuto, true);
          vibrate(24);
        }, 0);
      }
    } else if (result.created.length) {
      toast(result.created.length === 1 ? 'Nuovo ambiente riconosciuto ✓' : result.created.length + ' ambienti riconosciuti ✓');
    }
    return result.created;
  }

  function openRoomPicker() {
    if (!walls.length) return toast('Prima disegna la pianta');
    closePresentation();
    closeSurfaces();
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
    var key = faceKey(face);
    var existing = rooms.find(function (r) {
      return r.faceKey === key || faceKey({ wallIds:r.wallIds }) === key;
    }) || null;
    if (!existing) {
      var synced = syncDetectedRooms(
        rooms,
        [face],
        function () { return uid('room'); },
        new Date().toISOString()
      );
      rooms = synced.rooms;
      existing = synced.created[0] || null;
    }
    openRoomEditorForFace(face, existing, false);
  }

  function closeRoomModal() {
    $('roomBackdrop').classList.add('hidden');
    $('roomAutoHint').classList.add('hidden');
    $('roomModalTitle').textContent = 'Che stanza è?';
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
      room = {
        id:uid('room'),
        name:name,
        wallIds:wallIds,
        faceKey:key,
        custom:!!custom,
        autoDetected:false,
        needsNaming:false,
        geometryMissing:false,
        namedAt:new Date().toISOString()
      };
      rooms.push(room);
    } else {
      room.name = name;
      room.wallIds = wallIds;
      room.faceKey = key;
      room.custom = !!custom;
      room.needsNaming = false;
      room.geometryMissing = false;
      room.namedAt = new Date().toISOString();
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
        note.targetLabel = 'Muro ' + wallReference(wi) + ' · ' + room.name;
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
    photoRefs.forEach(function (photo) {
      if (photo.targetType !== 'room') return;
      if (String(photo.targetId) !== String(key) && String(photo.targetId) !== String(room.id)) return;
      photo.targetId = room.id;
      photo.targetLabel = room.name;
      photo.roomName = room.name;
    });
    surfaceCache = null;
    persistActive();
    closeRoomModal();
    refreshSurfaceCache();
    render();
    toast(name + ' salvato ✓');
    setTimeout(function () { syncAutomaticRooms(true); }, 0);
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
      var statusText = room.needsNaming ? 'DA NOMINARE' : state.label;

      ctx.save();
      ctx.font = '1000 12px system-ui';
      var w1 = ctx.measureText(title).width;
      ctx.font = '800 11px system-ui';
      var w2 = area ? ctx.measureText(area).width : 0;
      ctx.font = '900 9px system-ui';
      var w3 = ctx.measureText(statusText).width;
      var boxW = Math.max(w1, w2, w3) + 20;
      var boxH = area ? 58 : 42;
      ctx.fillStyle = room.needsNaming ? 'rgba(255,251,235,.97)' : 'rgba(255,255,255,.94)';
      ctx.strokeStyle = room.needsNaming ? '#f59e0b' : '#cbd5e1';
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
      ctx.fillStyle = room.needsNaming ? '#b45309' : state.cls === 'ok' ? '#15803d' : state.cls === 'estimated' ? '#b45309' : '#b91c1c';
      ctx.font = '900 9px system-ui';
      ctx.fillText(statusText, p.x, p.y + (area ? 19 : 10));
      ctx.restore();
    });
  }

  function presentationCard(label, value) {
    return '<div class="ps-card"><div class="ps-k">' + label + '</div><div class="ps-v">' + formatM2(value) + '</div></div>';
  }

  function openPresentation() {
    if (roomPickMode) return toast('Prima termina la selezione AMBIENTE');
    cancelPickModes();
    if (!walls.length) return toast('Prima disegna la pianta');
    var missing = walls.filter(function (w) { return !Number.isFinite(w.lengthCm) || w.lengthCm <= 0; });
    if (missing.length) {
      toast('Mancano ' + missing.length + ' misure');
      return openNextMissing(missing[0].id);
    }

    var solved = solvedPresentationWalls();
    var solvedClosed = !!(
      solved.result &&
      solved.result.success &&
      solved.result.closure &&
      solved.result.closure.closed &&
      solved.walls &&
      solved.walls.length
    );
    var calculationWalls = solved.walls && solved.walls.length ? solved.walls : clone(walls);
    var displayWalls = solvedClosed ? clone(solved.walls) : clone(walls);
    var cache = calculateSurfaces(calculationWalls, rooms, wallHeightM);
    presentationModel = {
      // Se il motore ha chiuso davvero il rilievo, PRESENTA mostra la versione
      // proporzionata secondo le misure. Se non riesce a chiudere, non mostriamo
      // una geometria parziale o spezzata: restiamo sullo schizzo originale.
      walls: displayWalls,
      calculationWalls: calculationWalls,
      openings: clone(openings),
      rooms: clone(rooms),
      notes: clone(notes),
      surfaces: cache,
      geometrySolved: solvedClosed,
      closure: solved.result && solved.result.closure ? clone(solved.result.closure) : null,
      repairedJoints: solved.result && solved.result.stats ? (solved.result.stats.repairedJoints || 0) : 0
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
    var geometryLabel = presentationModel.geometrySolved
      ? 'PIANTA CHIUSA E PROPORZIONATA'
      : 'RILIEVO DA VERIFICARE';
    $('presentationStamp').textContent = geometryLabel + ' · h ' + wallHeightM.toFixed(2).replace('.', ',') + ' m · ' + state.label;
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

    var displayFaces = buildFaces(pwalls);
    presentationModel.rooms.forEach(function (room, idx) {
      var face = matchRoomFace(room, displayFaces);
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
      drawOpeningSymbol(pctx, opening, wall, tp, {
        wallWidth: 6,
        background: '#ffffff',
        showLabel: true,
        compact: true
      });
    });

    var metricByRoom = new Map();
    (presentationModel.surfaces.roomMetrics || []).forEach(function (m) { metricByRoom.set(m.room.id, m); });

    function roomDisplayAnchor(room) {
      var face = matchRoomFace(room, displayFaces);
      if (face) return face.centroid;
      var ids = Array.isArray(room.wallIds) ? room.wallIds : [];
      var pts = [];
      pwalls.forEach(function (wall) {
        if (ids.indexOf(wall.id) === -1) return;
        pts.push(wall.a, wall.b);
      });
      if (!pts.length) return null;
      return {
        x: pts.reduce(function (sum, q) { return sum + q.x; }, 0) / pts.length,
        y: pts.reduce(function (sum, q) { return sum + q.y; }, 0) / pts.length
      };
    }

    presentationModel.rooms.forEach(function (room) {
      var anchor = roomDisplayAnchor(room);
      if (!anchor) return;
      var p = tp(anchor);
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

    (presentationModel.notes || []).forEach(function (note) {
      var anchor = noteAnchorForGeometry(note, pwalls, presentationModel.openings, presentationModel.rooms, displayFaces);
      if (!anchor) return;
      drawInterventionAnnotation(pctx, note, tp(anchor), { compact:true });
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

  function buildSurveyChecks() {
    var checks = [];
    if (!walls.length) {
      checks.push({level:'error',text:'Nessun muro disegnato'});
      return checks;
    }

    var missing = walls.filter(function (w) { return !Number.isFinite(w.lengthCm) || w.lengthCm <= 0; });
    if (missing.length) checks.push({level:'error',text:missing.length + ' muri senza misura reale'});

    var badOpenings = openings.filter(function (o) {
      return !Number.isFinite(o.widthCm) || o.widthCm <= 0 || !Number.isFinite(o.offsetCm) || o.offsetCm < 0;
    });
    if (badOpenings.length) checks.push({level:'error',text:badOpenings.length + ' porte/finestre con quote incomplete'});

    var openingsOutside = openings.filter(function (o) {
      var wall = walls.find(function (w) { return w.id === o.wallId; });
      if (!wall || !Number.isFinite(wall.lengthCm) || !Number.isFinite(o.widthCm) || !Number.isFinite(o.offsetCm)) return false;
      return o.offsetCm + o.widthCm > wall.lengthCm + .5;
    });
    if (openingsOutside.length) checks.push({level:'error',text:openingsOutside.length + ' aperture non entrano nella lunghezza del muro'});

    var unnamedRooms = rooms.filter(function (room) { return room.needsNaming && !room.geometryMissing; });
    if (unnamedRooms.length) checks.push({level:'warning',text:unnamedRooms.length + ' ambienti riconosciuti automaticamente sono ancora da nominare'});

    var pendingT = findTJunctionCandidates(walls, Math.max(8 / viewZoom, 4), .055);
    if (pendingT.length) checks.push({level:'warning',text:pendingT.length + ' possibili innesti a T da controllare'});

    var derivedMeasures = walls.filter(function (w) { return w.requiresMeasureVerification; });
    if (derivedMeasures.length) {
      checks.push({
        level:'warning',
        text:derivedMeasures.length + ' quote di segmenti T sono stimate dalla posizione dello schizzo: verificarle sul posto'
      });
    }

    var faces = buildFaces(walls);
    rooms.forEach(function (room) {
      if (!matchRoomFace(room, faces)) {
        checks.push({level:'warning',text:'Ambiente “' + (room.name || 'senza nome') + '” non è riconosciuto come superficie chiusa'});
      }
    });

    notes.forEach(function (note) {
      if (!noteAnchor(note)) checks.push({level:'warning',text:'Un intervento non è più collegato a un elemento esistente'});
    });

    if (!missing.length) {
      try {
        var result = solveFloorPlan(solverInput(), {mode:'normal',maxClosureGapCm:10});
        (result.errors || []).slice(0,3).forEach(function (err) {
          checks.push({level:'error',text:err.message || 'Errore geometrico'});
        });
        if (result.stats && result.stats.componentCount > 1) {
          checks.push({level:'warning',text:result.stats.componentCount + ' gruppi di muri risultano scollegati'});
        }
        if (result.stats && result.stats.loopCount > 0 && result.closure && !result.closure.closed) {
          checks.push({level:'error',text:'La planimetria contiene loop che non chiudono con le misure inserite'});
        } else if (result.stats && result.stats.loopCount === 0) {
          checks.push({level:'warning',text:'Nessun ambiente completamente chiuso rilevato'});
        }
      } catch (e) {
        checks.push({level:'warning',text:'Controllo geometrico non completato: ' + (e.message || e)});
      }
    }

    return checks;
  }

  function closeFinishCheck() {
    $('finishCheckBackdrop').classList.add('hidden');
  }

  function openFinishCheck() {
    persistActive();
    autoRepairTJunctions();
    var checks = buildSurveyChecks();
    var errors = checks.filter(function (x) { return x.level === 'error'; }).length;
    var warnings = checks.filter(function (x) { return x.level === 'warning'; }).length;
    var title = $('finishCheckTitle');
    var summaryEl = $('finishCheckSummary');
    var list = $('finishCheckList');
    list.innerHTML = '';

    if (!checks.length) {
      title.textContent = 'Rilievo pronto ✓';
      summaryEl.className = 'finish-check-summary ok';
      summaryEl.textContent = 'Misure complete, geometria coerente e nessun problema importante rilevato.';
    } else {
      title.textContent = errors ? 'Da correggere prima possibile' : 'Rilievo con avvisi';
      summaryEl.className = 'finish-check-summary ' + (errors ? 'error' : 'warn');
      summaryEl.textContent = errors + ' errori · ' + warnings + ' avvisi';
      checks.forEach(function (item) {
        var row = document.createElement('div');
        row.className = 'finish-check-row ' + item.level;
        row.textContent = (item.level === 'error' ? '✕ ' : '⚠ ') + item.text;
        list.appendChild(row);
      });
    }

    $('exportFinishCheckBtn').textContent = checks.length ? 'SALVA BOZZA JSON' : 'RILIEVO PRONTO · ESPORTA';
    $('finishCheckBackdrop').classList.remove('hidden');
  }

  function exportJson(force) {
    persistActive();
    var plan = currentPlan();
    if (!plan || !plan.walls || !plan.walls.length) return toast('Prima fai uno schizzo');
    var missing = plan.walls.filter(function (w) { return !w.lengthCm; }).length;
    if (missing && !force) {
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

  function renderTakeoff() {
    var cache = surfaceCache || refreshSurfaceCache();
    var takeoff = buildProgressiveTakeoff({
      notes:notes,
      walls:walls,
      openings:openings,
      rooms:rooms,
      surfaceCache:cache,
      wallHeightM:wallHeightM
    });

    var summaryEl = $('takeoffSummary');
    summaryEl.innerHTML =
      '<b>' + takeoff.rows.length + ' lavorazioni quantificate</b>' +
      '<span>' + takeoff.totals.interventions + ' interventi strutturati' +
      (takeoff.unresolved.length ? ' · ' + takeoff.unresolved.length + ' da completare' : '') + '</span>';

    var rowsEl = $('takeoffRows');
    rowsEl.innerHTML = '';
    takeoff.rows.forEach(function (row) {
      var item = document.createElement('div');
      item.className = 'takeoff-row ' + row.category;
      var left = document.createElement('div');
      left.className = 'takeoff-row-main';
      var title = document.createElement('b');
      title.textContent = row.label;
      var detail = document.createElement('span');
      var roomsText = row.rooms && row.rooms.length ? row.rooms.join(', ') : row.targets + ' elementi';
      detail.textContent = roomsText;
      left.appendChild(title);
      left.appendChild(detail);
      var value = document.createElement('div');
      value.className = 'takeoff-value';
      value.textContent = (row.estimated ? '≈ ' : '') +
        (row.unit === 'cad' ? String(row.value) : row.value.toFixed(2).replace('.', ',')) +
        ' ' + row.unit;
      item.appendChild(left);
      item.appendChild(value);
      rowsEl.appendChild(item);
    });

    var unresolvedEl = $('takeoffUnresolved');
    unresolvedEl.innerHTML = '';
    unresolvedEl.classList.toggle('hidden', !takeoff.unresolved.length);
    if (takeoff.unresolved.length) {
      var head = document.createElement('b');
      head.textContent = 'DA COMPLETARE';
      unresolvedEl.appendChild(head);
      takeoff.unresolved.slice(0,12).forEach(function (u) {
        var row = document.createElement('div');
        row.textContent = '• ' + u.label + (u.targetLabel ? ' · ' + u.targetLabel : '');
        unresolvedEl.appendChild(row);
      });
    }

    var plan = currentPlan();
    if (plan) plan.takeoff = clone(takeoff);
    return takeoff;
  }

  function openTakeoff() {
    closeTools();
    renderTakeoff();
    $('takeoffBackdrop').classList.remove('hidden');
  }

  function closeTakeoff() {
    $('takeoffBackdrop').classList.add('hidden');
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
    photoRefs.forEach(function (photo) {
      if (photo.targetType === 'plan') return;
      photo.orphaned = true;
      photo.originalTargetType = photo.targetType;
      photo.originalTargetId = photo.targetId;
      photo.targetType = 'plan';
      photo.targetId = activePlanId || '';
      photo.targetLabel = 'SCOLLEGATA · disegno cancellato';
      photo.roomName = null;
    });
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

  function setEditorLayer(layer, announce) {
    editorLayer = layer === 'works' ? 'works' : 'survey';
    $('surveyViewBtn').classList.toggle('active', editorLayer === 'survey');
    $('worksViewBtn').classList.toggle('active', editorLayer === 'works');
    hideObjectActionBar();
    persistActive();
    render();
    if (announce !== false) toast(editorLayer === 'works' ? 'Vista interventi' : 'Vista rilievo');
  }

  function updateUI() {
    var has = walls.length > 0;
    $('emptyHint').classList.toggle('hidden', has || !!currentStroke);
    $('statusPill').classList.toggle('hidden', !has);
    $('stageModeToggle').classList.toggle('hidden', !has);
    $('surveyViewBtn').classList.toggle('active', editorLayer === 'survey');
    $('worksViewBtn').classList.toggle('active', editorLayer === 'works');
    $('toolsBtn').classList.toggle('hidden', !has);
    $('clearBtn').classList.toggle('hidden', !has);
    $('solvePlanBtn').classList.toggle('hidden', !has);
    $('elaborateBtn').classList.toggle('hidden', !has);
    $('roomBtn').classList.toggle('hidden', !has);
    $('surfacesBtn').classList.toggle('hidden', !has);
    $('presentBtn').classList.toggle('hidden', !has);
    $('notesBtn').classList.toggle('hidden', !has);
    $('photosBtn').classList.toggle('hidden', !has);
    $('takeoffBtn').classList.toggle('hidden', !has);
    var notesTitle = $('notesBtn').querySelector('b');
    if (notesTitle) notesTitle.textContent = 'INTERVENTI' + (notes.length ? ' · ' + notes.length : '');
    var photosTitle = $('photosBtn').querySelector('b');
    if (photosTitle) photosTitle.textContent = 'FOTO' + (photoRefs.length ? ' · ' + photoRefs.length : '');
    var takeoffTitle = $('takeoffBtn').querySelector('b');
    if (takeoffTitle) {
      var takeoffNow = buildProgressiveTakeoff({
        notes:notes,walls:walls,openings:openings,rooms:rooms,
        surfaceCache:surfaceCache,wallHeightM:wallHeightM
      });
      takeoffTitle.textContent = 'COMPUTO LIVE' + (takeoffNow.rows.length ? ' · ' + takeoffNow.rows.length : '');
    }
    var missing = walls.filter(function (w) { return !w.lengthCm; }).length;
    var derived = walls.filter(function (w) { return w.requiresMeasureVerification; }).length;
    var unnamedRooms = rooms.filter(function (room) { return room.needsNaming && !room.geometryMissing; }).length;
    $('statusPill').textContent = walls.length + ' muri · ' +
      (missing ? missing + ' da misurare' : derived ? derived + ' quote da verificare' : 'misure complete ✓') +
      (unnamedRooms ? ' · ' + unnamedRooms + ' ambienti da nominare' : '');
    $('measureLabel').textContent = missing
      ? 'MISURE ' + missing
      : derived
        ? 'MISURE ⚠ ' + derived
        : 'MISURE ✓';
    updateHistoryButtons();
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

  function roundRectPath(gctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    gctx.beginPath();
    gctx.moveTo(x + rr, y);
    gctx.arcTo(x + w, y, x + w, y + h, rr);
    gctx.arcTo(x + w, y + h, x, y + h, rr);
    gctx.arcTo(x, y + h, x, y, rr);
    gctx.arcTo(x, y, x + w, y, rr);
    gctx.closePath();
  }

  function roundRect(x, y, w, h, r) {
    roundRectPath(ctx, x, y, w, h, r);
  }

  function drawMeasure(wall) {
    var mid = worldToScreen({ x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 });
    var x = mid.x;
    var y = mid.y;
    var derived = wall.measurementSource === 'derived_t_split' || wall.requiresMeasureVerification;
    var text = wall.lengthCm ? (derived ? '≈ ' : '') + (wall.lengthCm / 100).toFixed(2).replace('.', ',') + ' m' : '?';
    ctx.save();
    ctx.font = '900 13px system-ui';
    var width = Math.max(42, ctx.measureText(text).width + 16);
    ctx.fillStyle = !wall.lengthCm || derived ? '#fef3c7' : '#fff';
    ctx.strokeStyle = !wall.lengthCm || derived ? '#f59e0b' : '#cbd5e1';
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

  function wallPointAt(wall, t) {
    return {
      x: wall.a.x + (wall.b.x - wall.a.x) * t,
      y: wall.a.y + (wall.b.y - wall.a.y) * t
    };
  }

  function drawOpeningSymbol(gctx, opening, wall, transform, options) {
    options = options || {};
    var interval = openingInterval(opening, wall);
    if (!interval) return;

    var a = transform(wallPointAt(wall, interval.startT));
    var b = transform(wallPointAt(wall, interval.endT));
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var gapPx = Math.hypot(dx, dy);
    if (!Number.isFinite(gapPx) || gapPx < 3) return;

    var ux = dx / gapPx;
    var uy = dy / gapPx;
    var nx = -uy;
    var ny = ux;
    var wallWidth = options.wallWidth || 8;
    var bg = options.background || '#f8fafc';
    var color = opening.type === 'door' ? '#16a34a' : '#0891b2';
    var side = opening.swingSide === -1 ? -1 : 1;

    gctx.save();

    // Cancella davvero il tratto di muro: la porta/finestra è un'apertura,
    // non un bollino sovrapposto.
    gctx.strokeStyle = bg;
    gctx.lineWidth = wallWidth + 5;
    gctx.lineCap = 'butt';
    gctx.beginPath();
    gctx.moveTo(a.x - ux * 1.5, a.y - uy * 1.5);
    gctx.lineTo(b.x + ux * 1.5, b.y + uy * 1.5);
    gctx.stroke();

    // Spallette ai lati dell'apertura.
    gctx.strokeStyle = '#0f172a';
    gctx.lineWidth = 2;
    var jamb = Math.max(4, wallWidth * .75);
    [a, b].forEach(function (p) {
      gctx.beginPath();
      gctx.moveTo(p.x - nx * jamb, p.y - ny * jamb);
      gctx.lineTo(p.x + nx * jamb, p.y + ny * jamb);
      gctx.stroke();
    });

    if (opening.type === 'door') {
      var hinge = a;
      var leafEnd = {
        x: hinge.x + nx * gapPx * side,
        y: hinge.y + ny * gapPx * side
      };
      gctx.strokeStyle = color;
      gctx.lineWidth = 2.5;
      gctx.beginPath();
      gctx.moveTo(hinge.x, hinge.y);
      gctx.lineTo(leafEnd.x, leafEnd.y);
      gctx.stroke();

      var theta = Math.atan2(dy, dx);
      gctx.globalAlpha = .72;
      gctx.lineWidth = 1.5;
      gctx.beginPath();
      gctx.arc(hinge.x, hinge.y, gapPx, theta, theta + side * Math.PI / 2, side < 0);
      gctx.stroke();
      gctx.globalAlpha = 1;
    } else {
      // Simbolo finestra: due linee parallele nel vano.
      gctx.strokeStyle = color;
      gctx.lineWidth = 2;
      [-3, 3].forEach(function (off) {
        gctx.beginPath();
        gctx.moveTo(a.x + nx * off, a.y + ny * off);
        gctx.lineTo(b.x + nx * off, b.y + ny * off);
        gctx.stroke();
      });
    }

    if (options.showLabel !== false) {
      var cx = (a.x + b.x) / 2;
      var cy = (a.y + b.y) / 2;
      var offset = opening.type === 'door' ? 14 * side : 15;
      var label = (opening.type === 'door' ? 'P ' : 'F ') +
        (Number.isFinite(opening.widthCm) ? (opening.widthCm / 100).toFixed(2).replace('.', ',') : '');
      gctx.font = '900 ' + (options.compact ? 8 : 9) + 'px system-ui';
      gctx.textAlign = 'center';
      gctx.textBaseline = 'middle';
      var tw = gctx.measureText(label).width + 8;
      var lx = cx + nx * offset;
      var ly = cy + ny * offset;
      gctx.fillStyle = 'rgba(255,255,255,.95)';
      roundRectPath(gctx, lx - tw / 2, ly - 8, tw, 16, 6);
      gctx.fill();
      gctx.fillStyle = color;
      gctx.fillText(label, lx, ly + .5);
    }

    gctx.restore();
  }

  function drawOpening(opening) {
    var wall = walls.find(function (w) { return w.id === opening.wallId; });
    if (!wall) return;

    drawOpeningSymbol(ctx, opening, wall, worldToScreen, {
      wallWidth: wall.id === selectedWallId ? 10 : 8,
      background: '#f8fafc',
      showLabel: true
    });

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

  function noteAnchorForGeometry(note, wallList, openingList, roomList, faces) {
    if (!note) return null;

    if (note.targetType === 'wall') {
      var wall = (wallList || []).find(function (w) { return w.id === note.targetId; });
      if (!wall) return null;
      return { x:(wall.a.x + wall.b.x) / 2, y:(wall.a.y + wall.b.y) / 2 };
    }

    if (note.targetType === 'opening') {
      var opening = (openingList || []).find(function (o) { return o.id === note.targetId; });
      if (!opening) return null;
      var ow = (wallList || []).find(function (w) { return w.id === opening.wallId; });
      return ow ? openingWorldPoint(opening, ow) : null;
    }

    var room = (roomList || []).find(function (r) { return r.id === note.targetId; });
    var face = room
      ? matchRoomFace(room, faces || [])
      : (faces || []).find(function (f) { return faceKey(f) === note.targetId; });
    return face ? face.centroid : null;
  }

  function noteAnchor(note) {
    return noteAnchorForGeometry(note, walls, openings, rooms, buildFaces(walls));
  }

  function interventionColor(note) {
    var first = normalizeWorkItems(note && note.workItems)[0];
    var category = first ? first.category : 'general';
    if (category === 'demolition') return '#dc2626';
    if (category === 'construction') return '#2563eb';
    if (category === 'finish') return '#d97706';
    return '#7c3aed';
  }

  function interventionText(note) {
    var items = normalizeWorkItems(note && note.workItems);
    var base = items.length
      ? items.map(function (x) { return x.label; }).join(' · ')
      : String((note && (note.cleanedText || note.rawText)) || 'INTERVENTO').trim();
    if (!note) return base;

    var prefix = '';
    if (note.targetType === 'wall') prefix = String(note.targetLabel || 'MURO').split('·')[0].trim();
    else if (note.targetType === 'floor') prefix = 'PAVIMENTO';
    else if (note.targetType === 'ceiling') prefix = 'SOFFITTO';
    else if (note.targetType === 'opening') prefix = String(note.targetLabel || 'APERTURA').split('·')[0].trim();
    else if (note.targetType === 'room' && note.roomName) prefix = String(note.roomName);

    return prefix ? prefix.toUpperCase() + ' · ' + base : base;
  }

  function wrapAnnotationText(gctx, text, maxWidth, maxLines) {
    var words = String(text || '').split(/\s+/).filter(Boolean);
    var lines = [];
    var line = '';
    words.forEach(function (word) {
      if (lines.length >= maxLines) return;
      var next = line ? line + ' ' + word : word;
      if (line && gctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    });
    if (line && lines.length < maxLines) lines.push(line);
    if (words.length && lines.length === maxLines) {
      var joined = lines.join(' ');
      if (joined.length < text.length) lines[maxLines - 1] = lines[maxLines - 1].replace(/[.…]*$/, '') + '…';
    }
    return lines.length ? lines : ['INTERVENTO'];
  }

  function annotationBoxesOverlap(a, b, pad) {
    pad = Number.isFinite(pad) ? pad : 5;
    return !(a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x ||
      a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y);
  }

  function chooseAnnotationPosition(anchor, preferred, boxW, boxH, occupied, bounds) {
    var tries = [
      preferred,
      {x:anchor.x, y:anchor.y-58},
      {x:anchor.x+70, y:anchor.y-42},
      {x:anchor.x-70, y:anchor.y-42},
      {x:anchor.x+78, y:anchor.y+10},
      {x:anchor.x-78, y:anchor.y+10},
      {x:anchor.x, y:anchor.y+62},
      {x:anchor.x+74, y:anchor.y+58},
      {x:anchor.x-74, y:anchor.y+58},
      {x:anchor.x, y:anchor.y-100}
    ];
    var margin = 8;
    var fallback = preferred;

    for (var i=0;i<tries.length;i++) {
      var c = tries[i];
      var cx = Math.max(margin + boxW/2, Math.min(bounds.w-margin-boxW/2, c.x));
      var cy = Math.max(margin + boxH/2, Math.min(bounds.h-margin-boxH/2, c.y));
      var box = {x:cx-boxW/2,y:cy-boxH/2,w:boxW,h:boxH};
      if (!(occupied || []).some(function (other) { return annotationBoxesOverlap(box, other, 5); })) {
        return {x:cx,y:cy,box:box};
      }
      fallback = {x:cx,y:cy};
    }

    return {
      x:fallback.x,
      y:fallback.y,
      box:{x:fallback.x-boxW/2,y:fallback.y-boxH/2,w:boxW,h:boxH}
    };
  }

  function drawInterventionAnnotation(gctx, note, anchorScreen, options) {
    options = options || {};
    var style = noteDisplayStyle(note && note.displayStyle);
    var color = interventionColor(note);
    var text = interventionText(note);
    var compact = !!options.compact;
    var fontSize = compact ? 8 : 9;
    var maxWidth = compact ? 116 : 150;
    var maxLines = compact ? 2 : 3;
    var offsetX = note.targetType === 'wall' || note.targetType === 'opening' ? 40 : 0;
    var offsetY = note.targetType === 'ceiling' ? -42 : note.targetType === 'floor' ? 42 : -34;

    gctx.save();
    gctx.font = '900 ' + fontSize + 'px system-ui';
    var lines = wrapAnnotationText(gctx, text.toUpperCase(), maxWidth, maxLines);
    var lineH = compact ? 11 : 12;
    var textW = Math.min(maxWidth, Math.max.apply(Math, lines.map(function (line) { return gctx.measureText(line).width; })));
    var boxW = textW + (compact ? 10 : 14);
    var boxH = lines.length * lineH + (compact ? 8 : 12);

    var preferred = {x:anchorScreen.x+offsetX,y:anchorScreen.y+offsetY};
    if (options.manualOffsetScreen) {
      preferred = {
        x:anchorScreen.x + options.manualOffsetScreen.x,
        y:anchorScreen.y + options.manualOffsetScreen.y
      };
    }

    var placement;
    if (options.manualOffsetScreen || !options.bounds) {
      placement = {
        x:preferred.x,
        y:preferred.y,
        box:{x:preferred.x-boxW/2,y:preferred.y-boxH/2,w:boxW,h:boxH}
      };
    } else {
      placement = chooseAnnotationPosition(
        anchorScreen,
        preferred,
        boxW,
        boxH,
        options.occupied || [],
        options.bounds
      );
    }

    var labelX = placement.x;
    var labelY = placement.y;

    if (style === 'callout') {
      gctx.strokeStyle = color;
      gctx.lineWidth = compact ? 1.2 : 1.6;
      gctx.beginPath();
      gctx.moveTo(anchorScreen.x, anchorScreen.y);
      gctx.lineTo(labelX, labelY);
      gctx.stroke();

      gctx.fillStyle = color;
      gctx.beginPath();
      gctx.arc(anchorScreen.x, anchorScreen.y, compact ? 2.5 : 3.5, 0, Math.PI * 2);
      gctx.fill();
    }

    gctx.fillStyle = style === 'text' ? 'rgba(255,255,255,.82)' : 'rgba(255,255,255,.96)';
    gctx.strokeStyle = color;
    gctx.lineWidth = style === 'text' ? 1 : 1.5;
    roundRectPath(gctx, placement.box.x, placement.box.y, boxW, boxH, compact ? 5 : 7);
    gctx.fill();
    gctx.stroke();

    gctx.fillStyle = color;
    gctx.textAlign = 'center';
    gctx.textBaseline = 'middle';
    lines.forEach(function (line, i) {
      var yy = labelY + (i - (lines.length - 1) / 2) * lineH;
      gctx.fillText(line, labelX, yy);
    });
    gctx.restore();

    if (options.occupied) options.occupied.push(placement.box);
    return {
      x:placement.box.x,
      y:placement.box.y,
      w:boxW,
      h:boxH,
      center:{x:labelX,y:labelY},
      anchor:{x:anchorScreen.x,y:anchorScreen.y}
    };
  }

  function workCodes(note) {
    return normalizeWorkItems(note && note.workItems).map(function (x) { return x.code; });
  }

  function wallInterventionStyle(wall) {
    var related = notes.filter(function (n) { return n.targetType === 'wall' && n.targetId === wall.id; });
    var codes = [];
    var categories = [];
    related.forEach(function (n) {
      normalizeWorkItems(n.workItems).forEach(function (item) {
        codes.push(item.code);
        categories.push(item.category);
      });
    });
    if (codes.indexOf('wall_demolish') !== -1 || categories.indexOf('demolition') !== -1) {
      return {color:'#dc2626',width:7,dash:[10,7]};
    }
    if (codes.some(function (c) { return c === 'wall_new' || c === 'wall_drywall' || c === 'wall_opening_new' || c === 'wall_opening_close'; }) ||
        categories.indexOf('construction') !== -1) {
      return {color:'#2563eb',width:8,dash:[]};
    }
    if (codes.indexOf('wall_tile') !== -1 || codes.indexOf('wall_plaster_paint') !== -1 || categories.indexOf('finish') !== -1) {
      return {color:'#d97706',width:7,dash:[3,4]};
    }
    return {color:'#64748b',width:6,dash:[]};
  }

  function interventionFaceForNote(note, faces) {
    var room = rooms.find(function (r) { return r.id === note.targetId; });
    if (room) return matchRoomFace(room, faces);
    return faces.find(function (f) { return faceKey(f) === note.targetId; }) || null;
  }

  function drawInterventionSurfaces() {
    var faces = buildFaces(walls);
    notes.forEach(function (note) {
      if (['floor','ceiling','room'].indexOf(note.targetType) === -1) return;
      var face = interventionFaceForNote(note, faces);
      if (!face || !face.polygon || face.polygon.length < 3) return;
      var items = normalizeWorkItems(note.workItems);
      if (!items.length) return;
      var color = interventionColor(note);

      ctx.save();
      ctx.beginPath();
      face.polygon.forEach(function (p,i) {
        var sp = worldToScreen(p);
        if (!i) ctx.moveTo(sp.x,sp.y); else ctx.lineTo(sp.x,sp.y);
      });
      ctx.closePath();

      if (note.targetType === 'ceiling') {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([7,5]);
        ctx.stroke();
        ctx.restore();
        return;
      }

      ctx.globalAlpha = .08;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.clip();

      var step = 18;
      ctx.strokeStyle = color;
      ctx.globalAlpha = .28;
      ctx.lineWidth = 1;
      var size = canvas.clientWidth + canvas.clientHeight;
      for (var x=-canvas.clientHeight;x<size;x+=step) {
        ctx.beginPath();
        ctx.moveTo(x,0);
        ctx.lineTo(x+canvas.clientHeight,canvas.clientHeight);
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  function drawNoteMarkers() {
    annotationHitBoxes = [];
    var faces = buildFaces(walls);
    var occupied = [];
    var bounds = {w:canvas.clientWidth,h:canvas.clientHeight};

    notes.forEach(function (note) {
      var anchorWorld = noteAnchorForGeometry(note, walls, openings, rooms, faces);
      if (!anchorWorld) return;
      var anchor = worldToScreen(anchorWorld);
      var manual = null;
      if (note.labelOffset && Number.isFinite(note.labelOffset.x) && Number.isFinite(note.labelOffset.y)) {
        var shifted = worldToScreen({
          x:anchorWorld.x + note.labelOffset.x,
          y:anchorWorld.y + note.labelOffset.y
        });
        manual = {x:shifted.x-anchor.x,y:shifted.y-anchor.y};
      }
      var hit = drawInterventionAnnotation(ctx, note, anchor, {
        compact:false,
        occupied:occupied,
        bounds:bounds,
        manualOffsetScreen:manual
      });
      if (hit) annotationHitBoxes.push(Object.assign({noteId:note.id}, hit));
    });
  }

  function drawDirectionalPhotos() {
    photoRefs.forEach(function (photo, index) {
      if (!photo || !photo.cameraPoint || !photo.targetPoint) return;
      if (!Number.isFinite(photo.cameraPoint.x) || !Number.isFinite(photo.cameraPoint.y) ||
          !Number.isFinite(photo.targetPoint.x) || !Number.isFinite(photo.targetPoint.y)) return;

      var a=worldToScreen(photo.cameraPoint);
      var b=worldToScreen(photo.targetPoint);
      var dx=b.x-a.x, dy=b.y-a.y;
      var len=Math.hypot(dx,dy);
      if (!(len>3)) return;
      var ux=dx/len, uy=dy/len;
      var arrowLen=Math.min(len,58);
      var ex=a.x+ux*arrowLen, ey=a.y+uy*arrowLen;

      ctx.save();
      ctx.strokeStyle='#7c3aed';
      ctx.fillStyle='#7c3aed';
      ctx.lineWidth=2;
      ctx.setLineDash([5,4]);
      ctx.beginPath();
      ctx.moveTo(a.x,a.y);
      ctx.lineTo(ex,ey);
      ctx.stroke();
      ctx.setLineDash([]);

      var ah=8;
      ctx.beginPath();
      ctx.moveTo(ex,ey);
      ctx.lineTo(ex-ux*ah-uy*ah*.55,ey-uy*ah+ux*ah*.55);
      ctx.lineTo(ex-ux*ah+uy*ah*.55,ey-uy*ah-ux*ah*.55);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle='#ffffff';
      ctx.strokeStyle='#7c3aed';
      ctx.lineWidth=2;
      ctx.beginPath();
      ctx.arc(a.x,a.y,12,0,Math.PI*2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle='#7c3aed';
      ctx.font='1000 10px system-ui';
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.fillText('📷',a.x,a.y+.5);

      ctx.fillStyle='#7c3aed';
      ctx.font='900 8px system-ui';
      ctx.fillText(String(index+1),a.x,a.y+20);
      ctx.restore();
    });
  }

  async function commitPhotoPlacement(p) {
    if (!pendingPhotoPlacement) return false;
    var pending=pendingPhotoPlacement;
    var ref=photoRefs.find(function (photo) { return photo.id===pending.photoId; });
    pendingPhotoPlacement=null;
    $('photoPlacementBanner').classList.add('hidden');
    if (!ref || !pending.targetPoint) {
      toast('Foto salvata senza direzione');
      return true;
    }

    var cameraPoint={x:p.x,y:p.y};
    var targetPoint={x:pending.targetPoint.x,y:pending.targetPoint.y};
    var directionDeg=(Math.atan2(targetPoint.y-cameraPoint.y,targetPoint.x-cameraPoint.x)*180/Math.PI+360)%360;
    ref.cameraPoint=cameraPoint;
    ref.targetPoint=targetPoint;
    ref.directionDeg=directionDeg;

    try {
      await updatePhotoMetadata(ref.id,{
        cameraPoint:cameraPoint,
        targetPoint:targetPoint,
        directionDeg:directionDeg
      });
    } catch (_) {}

    persistActive();
    updateUI();
    render();
    vibrate(22);
    toast('Direzione foto salvata ✓');
    return true;
  }

  function render() {
    if ($('editor').classList.contains('hidden')) return;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);

    drawRoomAreas();
    if (editorLayer === 'works') drawInterventionSurfaces();
    if (editorLayer === 'survey') rawStrokes.forEach(function (stroke) { drawPolyline(stroke.raw, '#cbd5e1', 3); });

    walls.forEach(function (wall) {
      ctx.save();
      var style = editorLayer === 'works' ? wallInterventionStyle(wall) : {
        color:wall.id === selectedWallId ? '#2563eb' : '#0f172a',
        width:wall.id === selectedWallId ? 10 : 8,
        dash:[]
      };
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
      ctx.setLineDash(style.dash || []);
      ctx.lineCap = 'round';
      var sa = worldToScreen(wall.a);
      var sb = worldToScreen(wall.b);
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
      ctx.restore();
    });

    if (editorLayer === 'survey') walls.forEach(drawMeasure);
    openings.forEach(drawOpening);
    drawRoomLabels();
    drawDirectionalPhotos();
    if (editorLayer === 'works') drawNoteMarkers();
    else annotationHitBoxes = [];
    if (currentStroke) drawPolyline(currentStroke, '#2563eb', 7);
  }

  function annotationHitAt(sp) {
    for (var i=annotationHitBoxes.length-1;i>=0;i--) {
      var b = annotationHitBoxes[i];
      if (sp.x >= b.x-5 && sp.x <= b.x+b.w+5 && sp.y >= b.y-5 && sp.y <= b.y+b.h+5) return b;
    }
    return null;
  }

  function startAnnotationDrag(e, hit) {
    var note = notes.find(function (n) { return n.id === hit.noteId; });
    if (!note) return false;
    var anchorWorld = noteAnchor(note);
    if (!anchorWorld) return false;
    checkpoint();
    annotationDrag = {
      noteId:note.id,
      pointerId:e.pointerId,
      start:screenPoint(e),
      initialCenter:{x:hit.center.x,y:hit.center.y},
      anchorWorld:anchorWorld
    };
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    hideObjectActionBar();
    vibrate(12);
    return true;
  }

  function updateAnnotationDrag(e) {
    if (!annotationDrag || annotationDrag.pointerId !== e.pointerId) return false;
    var note = notes.find(function (n) { return n.id === annotationDrag.noteId; });
    if (!note) return false;
    var sp = screenPoint(e);
    var center = {
      x:annotationDrag.initialCenter.x + sp.x - annotationDrag.start.x,
      y:annotationDrag.initialCenter.y + sp.y - annotationDrag.start.y
    };
    var centerWorld = screenToWorld(center);
    note.labelOffset = {
      x:centerWorld.x - annotationDrag.anchorWorld.x,
      y:centerWorld.y - annotationDrag.anchorWorld.y
    };
    render();
    return true;
  }

  function finishAnnotationDrag(e) {
    if (!annotationDrag || annotationDrag.pointerId !== e.pointerId) return false;
    annotationDrag = null;
    persistActive();
    updateUI();
    render();
    vibrate(12);
    return true;
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
    var sp = screenPoint(e);
    var p = screenToWorld(sp);
    if (pendingPhotoPlacement) {
      commitPhotoPlacement(p);
      return;
    }
    if (editorLayer === 'works') {
      var annotationHit = annotationHitAt(sp);
      if (annotationHit && startAnnotationDrag(e, annotationHit)) return;
    }
    if (openingMoveMode) {
      startOpeningMoveDrag(e, p);
      return;
    }
    if (wallMoveMode) {
      commitWallEndpointMove(p);
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
      armLongPress(e.pointerId, p);
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
    if (openingMoveMode && openingMoveMode.dragging && openingMoveMode.pointerId === e.pointerId) {
      e.preventDefault();
      updateOpeningMoveDrag(e);
      return;
    }
    if (annotationDrag && annotationDrag.pointerId === e.pointerId) {
      e.preventDefault();
      updateAnnotationDrag(e);
      return;
    }
    if (mode !== 'draw' || currentStroke === null || e.pointerId !== activePointerId) return;
    e.preventDefault();
    var p = point(e);
    if (longPressState && longPressState.pointerId === e.pointerId &&
        dist(longPressState.start, p) * viewZoom > 10) {
      cancelLongPress();
    }
    var last = currentStroke[currentStroke.length - 1];
    if (dist(last, p) >= 3 / viewZoom) currentStroke.push(p);
    render();
  });

  canvas.addEventListener('pointerup', function (e) {
    if (e.isPrimary === false) return;
    if (openingMoveMode && openingMoveMode.dragging && openingMoveMode.pointerId === e.pointerId) {
      e.preventDefault();
      finishOpeningMoveDrag(e);
      return;
    }
    if (annotationDrag && annotationDrag.pointerId === e.pointerId) {
      e.preventDefault();
      finishAnnotationDrag(e);
      return;
    }
    var longHandled = !!(longPressState && longPressState.pointerId === e.pointerId && longPressState.handled);
    cancelLongPress();
    if (longHandled) return;
    if (mode !== 'draw' || currentStroke === null || e.pointerId !== activePointerId) return;
    e.preventDefault();
    var p = point(e);
    if (dist(currentStroke[currentStroke.length - 1], p) > 2 / viewZoom) currentStroke.push(p);
    commitStroke();
  });

  canvas.addEventListener('pointercancel', function (e) {
    cancelLongPress();
    if (openingMoveMode && openingMoveMode.dragging && openingMoveMode.pointerId === e.pointerId) {
      finishOpeningMoveDrag(e);
      return;
    }
    if (annotationDrag && annotationDrag.pointerId === e.pointerId) {
      finishAnnotationDrag(e);
      return;
    }
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
  $('doneBtn').addEventListener('click', openFinishCheck);
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('objectMeasureBtn').addEventListener('click', measureSelectedObject);
  $('objectMoveBtn').addEventListener('click', moveSelectedObject);
  $('objectWorkBtn').addEventListener('click', directInterventionSelected);
  $('objectPhotoBtn').addEventListener('click', captureSelectedObjectPhoto);
  $('objectSwingBtn').addEventListener('click', swingSelectedDoor);
  $('objectDeleteBtn').addEventListener('click', deleteSelectedObject);
  $('saveBtn').addEventListener('click', function () { persistActive(true); });
  $('closeFinishCheckBtn').addEventListener('click', closeFinishCheck);
  $('fixFinishCheckBtn').addEventListener('click', closeFinishCheck);
  $('exportFinishCheckBtn').addEventListener('click', function () {
    closeFinishCheck();
    exportJson(true);
  });
  $('finishCheckBackdrop').addEventListener('click', function (e) {
    if (e.target === $('finishCheckBackdrop')) closeFinishCheck();
  });
  $('toolsBtn').addEventListener('click', openTools);
  $('closeToolsBtn').addEventListener('click', closeTools);
  $('toolsBackdrop').addEventListener('click', function (e) { if (e.target === $('toolsBackdrop')) closeTools(); });
  $('clearBtn').addEventListener('click', function () { runTool(clearAll); });
  $('confirmBtn').addEventListener('click', confirmSheet);
  $('laterBtn').addEventListener('click', later);
  $('cornerToggleBtn').addEventListener('click', toggleOpeningCorner);
  $('swingToggleBtn').addEventListener('click', toggleDoorSwing);
  $('moveWallStartBtn').addEventListener('click', function () { startWallEndpointMove('a'); });
  $('moveWallEndBtn').addEventListener('click', function () { startWallEndpointMove('b'); });
  $('deleteWallBtn').addEventListener('click', deleteSelectedWall);
  $('deleteOpeningBtn').addEventListener('click', deleteCurrentOpening);
  $('zoomOutBtn').addEventListener('click', function () { setZoom(viewZoom / 1.25); });
  $('zoomInBtn').addEventListener('click', function () { setZoom(viewZoom * 1.25); });
  $('zoomResetBtn').addEventListener('click', resetView);
  $('rotateBtn').addEventListener('click', rotateView);
  $('notesBtn').addEventListener('click', function () {
    setEditorLayer('works', false);
    runTool(openNoteTargetChooser);
  });
  $('surveyViewBtn').addEventListener('click', function () { setEditorLayer('survey'); });
  $('worksViewBtn').addEventListener('click', function () { setEditorLayer('works'); });
  $('roomBtn').addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    runTool(openRoomPicker);
  });
  $('surfacesBtn').addEventListener('click', function () { runTool(openSurfaces); });
  $('photosBtn').addEventListener('click', openPhotosGallery);
  $('takeoffBtn').addEventListener('click', openTakeoff);
  $('closePhotosBtn').addEventListener('click', closePhotosGallery);
  $('photosBackdrop').addEventListener('click', function (e) { if (e.target === $('photosBackdrop')) closePhotosGallery(); });
  $('photoInput').addEventListener('change', handlePhotoInput);
  $('roomPhotoBtn').addEventListener('click', captureCurrentRoomPhoto);
  $('closeTakeoffBtn').addEventListener('click', closeTakeoff);
  $('takeoffBackdrop').addEventListener('click', function (e) { if (e.target === $('takeoffBackdrop')) closeTakeoff(); });
  $('presentBtn').addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    runTool(openPresentation);
  });
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
  document.querySelectorAll('[data-note-style]').forEach(function (b) {
    b.addEventListener('click', function () { setNoteDisplayStyle(b.dataset.noteStyle); });
  });
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