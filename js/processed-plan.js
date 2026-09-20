export const BACKEND_STATUSES = Object.freeze([
  'LOCAL', 'UPLOADING', 'RAW', 'QUEUED', 'PROCESSING', 'PROCESSED', 'NEEDS_REVIEW', 'ERROR'
]);

const FILE_KEYS = ['preview', 'svg', 'png', 'pdf', 'dxf', 'json', 'plan3d', 'glb', 'zip'];

export function createBackendMetadata() {
  return {
    remotePlanId: null,
    status: 'LOCAL',
    currentVersion: null,
    lastProcessedAt: null,
    sourceRevision: null,
    needsReview: false,
    warnings: [],
    summary: { rooms: null, floorAreaM2: null },
    files: {
      preview: null, svg: null, png: null, pdf: null, dxf: null,
      json: null, plan3d: null, glb: null, zip: null
    },
    versions: [],
    error: null
  };
}

export function ensureBackendMetadata(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const defaults = createBackendMetadata();
  const existing = plan.backend && typeof plan.backend === 'object' ? plan.backend : {};
  const status = String(existing.status || defaults.status).toUpperCase();
  plan.backend = {
    ...defaults,
    ...existing,
    status: BACKEND_STATUSES.includes(status) ? status : 'LOCAL',
    warnings: Array.isArray(existing.warnings) ? existing.warnings : [],
    summary: { ...defaults.summary, ...(existing.summary || {}) },
    files: { ...defaults.files, ...normalizeFiles(existing.files || {}) },
    versions: Array.isArray(existing.versions) ? existing.versions.map(normalizeVersion) : [],
    error: existing.error || null
  };
  if (!plan.sourceRevision) plan.sourceRevision = computeSourceRevision(plan);
  return plan;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stableValue(value[key]);
      return out;
    }, {});
  }
  return value;
}

function significantSource(plan) {
  return {
    rawStrokes: plan.rawStrokes || [],
    walls: plan.walls || [],
    openings: plan.openings || [],
    rooms: plan.rooms || [],
    notes: plan.notes || [],
    wallHeightM: Number.isFinite(plan.wallHeightM) ? plan.wallHeightM : 2.70,
    surfaces: plan.surfaces || plan.surfaceSummary || null
  };
}

export function computeSourceRevision(plan) {
  const text = JSON.stringify(stableValue(significantSource(plan || {})));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 'src-' + hash.toString(16).padStart(8, '0');
}

export function refreshSourceRevision(plan) {
  if (!plan) return null;
  plan.sourceRevision = computeSourceRevision(plan);
  return plan.sourceRevision;
}

export function isProcessedStale(plan) {
  ensureBackendMetadata(plan);
  return Boolean(
    plan.backend.currentVersion &&
    plan.backend.sourceRevision &&
    plan.sourceRevision &&
    plan.backend.sourceRevision !== plan.sourceRevision
  );
}

export function validateForProcessing(plan) {
  const walls = Array.isArray(plan && plan.walls) ? plan.walls : [];
  const openings = Array.isArray(plan && plan.openings) ? plan.openings : [];
  const missingWallIds = walls
    .filter(w => !Number.isFinite(w.lengthCm) || w.lengthCm <= 0)
    .map(w => w.id);
  const invalidOpeningIds = openings
    .filter(o => !Number.isFinite(o.widthCm) || o.widthCm <= 0 || !Number.isFinite(o.offsetCm) || o.offsetCm < 0)
    .map(o => o.id);

  return {
    ok: walls.length > 0 && missingWallIds.length === 0 && invalidOpeningIds.length === 0,
    hasWalls: walls.length > 0,
    missingWallIds,
    invalidOpeningIds
  };
}

export function buildProcessingPayload(plan) {
  ensureBackendMetadata(plan);
  refreshSourceRevision(plan);
  return {
    version: 4,
    kind: 'ge360-rough-survey',
    planId: plan.id,
    name: plan.name || 'Rilievo',
    updatedAt: plan.updatedAt || new Date().toISOString(),
    sourceRevision: plan.sourceRevision,
    rawStrokes: plan.rawStrokes || [],
    walls: plan.walls || [],
    openings: plan.openings || [],
    rooms: plan.rooms || [],
    notes: plan.notes || [],
    wallHeightM: Number.isFinite(plan.wallHeightM) ? plan.wallHeightM : 2.70,
    surfaces: plan.surfaces || plan.surfaceSummary || null,
    metadata: {
      client: 'ge360-open-plan3d',
      schemaVersion: 1
    }
  };
}

function normalizeLink(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value.url || value.href || value.downloadUrl || value.download_url || null;
  }
  return null;
}

export function normalizeFiles(input = {}) {
  const source = input.artifacts && typeof input.artifacts === 'object' ? input.artifacts : input;
  const out = {};
  FILE_KEYS.forEach(key => { out[key] = null; });

  const aliases = {
    preview: ['preview', 'previewUrl', 'preview_url'],
    svg: ['svg', 'svgUrl', 'svg_url'],
    png: ['png', 'pngUrl', 'png_url'],
    pdf: ['pdf', 'pdfUrl', 'pdf_url'],
    dxf: ['dxf', 'dxfUrl', 'dxf_url'],
    json: ['json', 'processed', 'processedPlan', 'processed_plan', 'processedUrl', 'processed_url'],
    plan3d: ['plan3d', 'plan3dJson', 'plan3d_json', 'threeD', '3d'],
    glb: ['glb', 'glbUrl', 'glb_url'],
    zip: ['zip', 'zipUrl', 'zip_url', 'downloadAll', 'download_all']
  };

  Object.entries(aliases).forEach(([key, names]) => {
    for (const name of names) {
      const link = normalizeLink(source[name]);
      if (link) {
        out[key] = link;
        break;
      }
    }
  });
  return out;
}

export function normalizeVersion(version) {
  if (!version || typeof version !== 'object') return { version: String(version || ''), files: normalizeFiles({}) };
  return {
    ...version,
    version: version.version ?? version.id ?? version.number ?? null,
    createdAt: version.createdAt || version.created_at || version.processedAt || version.processed_at || null,
    status: String(version.status || 'PROCESSED').toUpperCase(),
    needsReview: Boolean(version.needsReview ?? version.needs_review),
    warnings: Array.isArray(version.warnings) ? version.warnings : [],
    summary: normalizeSummary(version.summary || version),
    files: normalizeFiles(version.files || version.artifacts || version.outputs || {})
  };
}

function normalizeSummary(source = {}) {
  const rooms = source.rooms ?? source.roomCount ?? source.room_count ?? null;
  const area = source.floorAreaM2 ?? source.floor_area_m2 ?? source.areaM2 ?? source.area_m2 ?? null;
  return {
    rooms: Number.isFinite(Number(rooms)) ? Number(rooms) : null,
    floorAreaM2: Number.isFinite(Number(area)) ? Number(area) : null
  };
}

export function applyBackendSnapshot(plan, payload = {}) {
  ensureBackendMetadata(plan);
  const backend = plan.backend;
  const status = String(payload.status || payload.state || payload.processingStatus || backend.status || 'LOCAL').toUpperCase();

  backend.status = BACKEND_STATUSES.includes(status) ? status : backend.status;
  backend.remotePlanId = payload.remotePlanId || payload.remote_plan_id || payload.planId || payload.plan_id || payload.id || backend.remotePlanId;
  backend.currentVersion = payload.currentVersion ?? payload.current_version ?? payload.version ?? backend.currentVersion;
  backend.lastProcessedAt = payload.lastProcessedAt || payload.last_processed_at || payload.processedAt || payload.processed_at || backend.lastProcessedAt;
  backend.needsReview = Boolean(payload.needsReview ?? payload.needs_review ?? (backend.status === 'NEEDS_REVIEW'));
  backend.warnings = Array.isArray(payload.warnings) ? payload.warnings : backend.warnings;
  backend.summary = { ...backend.summary, ...normalizeSummary(payload.summary || payload) };
  backend.files = { ...backend.files, ...normalizeFiles(payload.files || payload.artifacts || payload.outputs || payload) };
  backend.error = payload.error || payload.detail || (backend.status === 'ERROR' ? 'Elaborazione non completata' : null);

  const revision = payload.sourceRevision || payload.source_revision;
  if (revision) backend.sourceRevision = revision;
  if ((backend.status === 'PROCESSED' || backend.status === 'NEEDS_REVIEW') && !backend.sourceRevision) {
    backend.sourceRevision = plan.sourceRevision || computeSourceRevision(plan);
  }

  const versions = payload.versions || payload.history;
  if (Array.isArray(versions)) backend.versions = versions.map(normalizeVersion);

  return backend;
}

export function mergeVersions(plan, versionsPayload) {
  ensureBackendMetadata(plan);
  const raw = Array.isArray(versionsPayload)
    ? versionsPayload
    : (versionsPayload && (versionsPayload.versions || versionsPayload.items)) || [];
  plan.backend.versions = raw.map(normalizeVersion);
  return plan.backend.versions;
}

export function getVersionView(plan, versionKey = null) {
  ensureBackendMetadata(plan);
  const backend = plan.backend;
  if (versionKey != null) {
    const selected = backend.versions.find(v => String(v.version) === String(versionKey));
    if (selected) return selected;
  }
  return {
    version: backend.currentVersion,
    createdAt: backend.lastProcessedAt,
    status: backend.status,
    needsReview: backend.needsReview,
    warnings: backend.warnings,
    summary: backend.summary,
    files: backend.files
  };
}

export function isTerminalStatus(status) {
  return ['PROCESSED', 'NEEDS_REVIEW', 'ERROR'].includes(String(status || '').toUpperCase());
}
