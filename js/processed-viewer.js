import { getVersionView, isProcessedStale } from './processed-plan.js';
import { availableFileEntries, fileNameFor, openRemoteFile, saveRemoteFile, shareRemoteFiles, saveAllAvailable } from './processed-files.js';
import { renderPlan3D } from './view3d.js';

function $(id) { return document.getElementById(id); }
function statusText(status) {
  const labels = {
    LOCAL: 'NESSUN ELABORATO',
    UPLOADING: 'INVIO RILIEVO…',
    RAW: 'RILIEVO RICEVUTO',
    QUEUED: 'IN CODA',
    PROCESSING: 'ELABORAZIONE IN CORSO',
    PROCESSED: 'PRONTA',
    NEEDS_REVIEW: 'PLANIMETRIA DA VERIFICARE',
    ERROR: 'ERRORE ELABORAZIONE'
  };
  return labels[String(status || 'LOCAL').toUpperCase()] || String(status || 'LOCAL');
}

function quality(view) {
  if (view.needsReview || view.status === 'NEEDS_REVIEW') return '⚠️ DA VERIFICARE';
  if (Array.isArray(view.warnings) && view.warnings.length) return '⚠️ STIMATO';
  return '✅ OK';
}

function displayDate(value) {
  if (!value) return '';
  try { return new Date(value).toLocaleString('it-IT', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
  catch (_) { return String(value); }
}

export class ProcessedPlanUI {
  constructor({ getPlan, getClient, toast, onElaborate, onReprocess, onConfigure }) {
    this.getPlan = getPlan;
    this.getClient = getClient;
    this.toast = toast;
    this.onElaborate = onElaborate;
    this.onReprocess = onReprocess;
    this.onConfigure = onConfigure;
    this.selectedVersion = null;
    this.previewObjectUrl = null;
    this.viewer2dObjectUrl = null;
    this.viewer3d = null;
    this.panZoom = { scale: 1, x: 0, y: 0, pointers: new Map(), lastDistance: 0, lastMid: null };
    this.bind();
  }

  bind() {
    $('rawTabBtn').addEventListener('click', () => this.showTab('raw'));
    $('processedTabBtn').addEventListener('click', () => this.showTab('processed'));
    $('processNowBtn').addEventListener('click', () => this.onElaborate(false));
    $('reprocessBtn').addEventListener('click', () => this.onReprocess());
    $('configureBackendBtn').addEventListener('click', () => this.onConfigure());
    $('open2dBtn').addEventListener('click', () => this.open2D());
    $('open3dBtn').addEventListener('click', () => this.open3D());
    $('shareProcessedBtn').addEventListener('click', () => this.shareDefault());
    $('saveProcessedBtn').addEventListener('click', () => this.saveDefault());
    $('downloadAllBtn').addEventListener('click', () => this.downloadAll());

    $('close2dBtn').addEventListener('click', () => this.close2D());
    $('fit2dBtn').addEventListener('click', () => this.reset2D());
    $('reset2dBtn').addEventListener('click', () => this.reset2D());
    $('fullscreen2dBtn').addEventListener('click', () => this.fullscreen($('viewer2dPanel')));

    $('close3dBtn').addEventListener('click', () => this.close3D());
    $('top3dBtn').addEventListener('click', () => this.viewer3d && this.viewer3d.topView());
    $('perspective3dBtn').addEventListener('click', () => this.viewer3d && this.viewer3d.view3d());
    $('reset3dBtn').addEventListener('click', () => this.viewer3d && this.viewer3d.reset());
    $('fullscreen3dBtn').addEventListener('click', () => this.fullscreen($('viewer3dPanel')));

    this.bindPanZoom();
  }

  showTab(tab) {
    const processed = tab === 'processed';
    $('rawTabBtn').classList.toggle('active', !processed);
    $('processedTabBtn').classList.toggle('active', processed);
    $('rawWorkspace').classList.toggle('hidden', processed);
    $('processedWorkspace').classList.toggle('hidden', !processed);
    if (processed) this.render(this.getPlan());
  }

  render(plan) {
    if (!plan) return;
    const backend = plan.backend || { status:'LOCAL', files:{}, versions:[] };
    const current = getVersionView(plan, this.selectedVersion);
    const hasResult = Boolean(current.version || availableFileEntries(current.files).length || current.files.plan3d);
    const processing = ['UPLOADING','RAW','QUEUED','PROCESSING'].includes(backend.status);

    $('processedEmpty').classList.toggle('hidden', hasResult || processing || backend.status === 'ERROR');
    $('processedCard').classList.toggle('hidden', !hasResult);
    $('processedStatusPanel').classList.toggle('hidden', !(processing || backend.status === 'ERROR'));
    $('processedStatusTitle').textContent = statusText(backend.status);
    $('processedStatusText').textContent = backend.status === 'ERROR'
      ? (backend.error || 'Il rilievo resta salvato sul telefono. Puoi riprovare.')
      : (backend.status === 'UPLOADING' ? 'Sto inviando il rilievo al backend GE360…' : 'Sto preparando la planimetria. Puoi continuare a usare l’app.');

    const stale = isProcessedStale(plan);
    $('staleBanner').classList.toggle('hidden', !stale);
    $('reprocessBtn').disabled = processing;

    if (!hasResult) return;

    $('processedQuality').textContent = quality(current);
    $('processedTitle').textContent = plan.name || 'Rilievo';
    const parts = [];
    if (current.summary && Number.isFinite(current.summary.floorAreaM2)) parts.push(current.summary.floorAreaM2.toFixed(2).replace('.', ',') + ' m²');
    if (current.summary && Number.isFinite(current.summary.rooms)) parts.push(current.summary.rooms + (current.summary.rooms === 1 ? ' ambiente' : ' ambienti'));
    $('processedSummary').textContent = parts.join(' · ') || 'Elaborato professionale';
    $('processedVersion').textContent = current.version != null ? 'Versione ' + current.version : '';
    $('processedDate').textContent = displayDate(current.createdAt);

    const warnings = Array.isArray(current.warnings) ? current.warnings : [];
    $('processedWarnings').classList.toggle('hidden', !warnings.length);
    $('processedWarningsList').innerHTML = '';
    warnings.forEach(w => {
      const li = document.createElement('li');
      li.textContent = typeof w === 'string' ? w : (w.message || w.code || JSON.stringify(w));
      $('processedWarningsList').appendChild(li);
    });

    const files = current.files || {};
    $('open2dBtn').classList.toggle('hidden', !(files.svg || files.png || files.preview));
    $('open3dBtn').classList.toggle('hidden', !(files.plan3d || files.glb));
    this.renderFileButtons(plan, current);
    this.renderVersions(plan);
    this.loadPreview(files);
  }

  renderFileButtons(plan, view) {
    const wrap = $('processedFileButtons');
    wrap.innerHTML = '';
    availableFileEntries(view.files).forEach(item => {
      const button = document.createElement('button');
      button.className = 'processed-file';
      button.textContent = item.type.toUpperCase();
      button.addEventListener('click', async () => {
        try {
          const descriptor = { ...item, fileName: fileNameFor(plan.name, view.version, item.type) };
          if (['pdf','png','svg'].includes(item.type)) await openRemoteFile(this.getClient(), descriptor);
          else await saveRemoteFile(this.getClient(), descriptor);
        } catch (error) {
          this.toast(error.message || 'Operazione non riuscita');
        }
      });
      wrap.appendChild(button);
    });
    $('downloadAllBtn').classList.toggle('hidden', availableFileEntries(view.files).length === 0 && !view.files.zip);
  }

  renderVersions(plan) {
    const wrap = $('versionsList');
    wrap.innerHTML = '';
    const versions = (plan.backend && plan.backend.versions) || [];
    if (!versions.length) {
      $('versionsSection').classList.add('hidden');
      return;
    }
    $('versionsSection').classList.remove('hidden');
    versions.slice().sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).forEach(v => {
      const button = document.createElement('button');
      const isCurrent = String(v.version) === String(plan.backend.currentVersion);
      button.className = 'version-row' + (String(this.selectedVersion) === String(v.version) ? ' selected' : '');
      button.innerHTML = '<b>v' + String(v.version ?? '?') + (isCurrent ? ' · ATTUALE' : '') + '</b><span>' + displayDate(v.createdAt) + '</span>';
      button.addEventListener('click', () => {
        this.selectedVersion = v.version;
        this.render(plan);
      });
      wrap.appendChild(button);
    });
    const current = document.createElement('button');
    current.className = 'version-row' + (this.selectedVersion == null ? ' selected' : '');
    current.innerHTML = '<b>VERSIONE ATTUALE</b><span>Mostra elaborato corrente</span>';
    current.addEventListener('click', () => { this.selectedVersion = null; this.render(plan); });
    wrap.prepend(current);
  }

  async loadPreview(files) {
    const url = files.svg || files.png || files.preview;
    const img = $('processedPreview');
    img.classList.toggle('hidden', !url);
    $('processedPreviewPlaceholder').classList.toggle('hidden', Boolean(url));
    if (!url) return;
    try {
      if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
      const blob = await this.getClient().fetchBlob(url);
      this.previewObjectUrl = URL.createObjectURL(blob);
      img.src = this.previewObjectUrl;
    } catch (_) {
      img.classList.add('hidden');
      $('processedPreviewPlaceholder').classList.remove('hidden');
    }
  }

  view() {
    const plan = this.getPlan();
    return plan ? getVersionView(plan, this.selectedVersion) : null;
  }

  async open2D() {
    const view = this.view();
    if (!view) return;
    const url = view.files.svg || view.files.png || view.files.preview;
    if (!url) return this.toast('Anteprima 2D non disponibile');
    try {
      const blob = await this.getClient().fetchBlob(url);
      if (this.viewer2dObjectUrl) URL.revokeObjectURL(this.viewer2dObjectUrl);
      this.viewer2dObjectUrl = URL.createObjectURL(blob);
      $('viewer2dImage').src = this.viewer2dObjectUrl;
      $('viewer2dBackdrop').classList.remove('hidden');
      this.reset2D();
    } catch (error) { this.toast(error.message || 'Viewer 2D non disponibile'); }
  }

  close2D() {
    $('viewer2dBackdrop').classList.add('hidden');
  }

  reset2D() {
    this.panZoom.scale = 1;
    this.panZoom.x = 0;
    this.panZoom.y = 0;
    this.apply2DTransform();
  }

  apply2DTransform() {
    $('viewer2dImage').style.transform = 'translate(' + this.panZoom.x + 'px,' + this.panZoom.y + 'px) scale(' + this.panZoom.scale + ')';
  }

  bindPanZoom() {
    const area = $('viewer2dStage');
    const state = this.panZoom;
    const mid = (a,b) => ({ x:(a.x+b.x)/2, y:(a.y+b.y)/2 });
    const distance = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);

    area.addEventListener('pointerdown', e => {
      area.setPointerCapture && area.setPointerCapture(e.pointerId);
      state.pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
      if (state.pointers.size === 2) {
        const [a,b] = [...state.pointers.values()];
        state.lastDistance = distance(a,b);
        state.lastMid = mid(a,b);
      }
    });
    area.addEventListener('pointermove', e => {
      const prev = state.pointers.get(e.pointerId);
      if (!prev) return;
      const next = { x:e.clientX, y:e.clientY };
      state.pointers.set(e.pointerId, next);
      if (state.pointers.size === 1) {
        state.x += next.x - prev.x;
        state.y += next.y - prev.y;
      } else if (state.pointers.size >= 2) {
        const [a,b] = [...state.pointers.values()];
        const d = distance(a,b);
        const m = mid(a,b);
        if (state.lastDistance > 0) state.scale = Math.max(0.5, Math.min(8, state.scale * (d / state.lastDistance)));
        if (state.lastMid) {
          state.x += m.x - state.lastMid.x;
          state.y += m.y - state.lastMid.y;
        }
        state.lastDistance = d;
        state.lastMid = m;
      }
      this.apply2DTransform();
    });
    const end = e => {
      state.pointers.delete(e.pointerId);
      state.lastDistance = 0;
      state.lastMid = null;
    };
    area.addEventListener('pointerup', end);
    area.addEventListener('pointercancel', end);
  }

  async open3D() {
    const view = this.view();
    if (!view) return;
    try {
      $('viewer3dBackdrop').classList.remove('hidden');
      $('viewer3dLoading').classList.remove('hidden');
      let plan3d = null, glbBlob = null;
      if (view.files.plan3d) plan3d = await this.getClient().fetchJsonResource(view.files.plan3d);
      else if (view.files.glb) glbBlob = await this.getClient().fetchBlob(view.files.glb);
      else throw new Error('Modello 3D non disponibile');
      if (this.viewer3d) this.viewer3d.dispose();
      this.viewer3d = await renderPlan3D({ container:$('viewer3dStage'), plan3d, glbBlob });
    } catch (error) {
      this.toast(error.message || 'Viewer 3D non disponibile');
      this.close3D();
    } finally {
      $('viewer3dLoading').classList.add('hidden');
    }
  }

  close3D() {
    $('viewer3dBackdrop').classList.add('hidden');
    if (this.viewer3d) {
      this.viewer3d.dispose();
      this.viewer3d = null;
    }
  }

  async shareDefault() {
    const plan = this.getPlan(), view = this.view();
    if (!plan || !view) return;
    const preferred = ['pdf','png'].filter(type => view.files[type]).map(type => ({
      type, url:view.files[type], fileName:fileNameFor(plan.name, view.version, type)
    }));
    const fallback = preferred.length ? preferred : availableFileEntries(view.files).slice(0,2).map(item => ({
      ...item, fileName:fileNameFor(plan.name, view.version, item.type)
    }));
    if (!fallback.length) return this.toast('Nessun file da condividere');
    try {
      const result = await shareRemoteFiles(this.getClient(), fallback, { title:plan.name, text:'Elaborati GE360' });
      this.toast(result.fallback ? 'Share Sheet non disponibile: file salvati' : 'Condivisione aperta');
    } catch (error) {
      if (error && error.name !== 'AbortError') this.toast(error.message || 'Condivisione non riuscita');
    }
  }

  async saveDefault() {
    const plan = this.getPlan(), view = this.view();
    if (!plan || !view) return;
    const type = view.files.pdf ? 'pdf' : (view.files.png ? 'png' : availableFileEntries(view.files)[0]?.type);
    if (!type) return this.toast('Nessun file disponibile');
    try {
      await saveRemoteFile(this.getClient(), {
        type, url:view.files[type], fileName:fileNameFor(plan.name, view.version, type)
      });
      this.toast('Salvato sul dispositivo ✓');
    } catch (error) { this.toast(error.message || 'Salvataggio non riuscito'); }
  }

  async downloadAll() {
    const plan = this.getPlan(), view = this.view();
    if (!plan || !view) return;
    try {
      await saveAllAvailable(this.getClient(), view.files, plan.name, view.version);
      this.toast(view.files.zip ? 'Archivio salvato ✓' : 'File disponibili salvati ✓');
    } catch (error) { this.toast(error.message || 'Download non riuscito'); }
  }

  fullscreen(element) {
    if (element && element.requestFullscreen) element.requestFullscreen().catch(() => {});
  }
}
