/**
 * GE360 Rilievo — client del backend ge360-rilievi-backend.
 *
 * Chiude il giro: invio → coda → attesa del job → download del risultato.
 * Nessuna dipendenza dal DOM: testabile in Node con un fetch finto.
 */
import { normalizeBackendApiUrl } from './backend-bridge.js';

export class BackendError extends Error {
  constructor(message, { status = 0, code = 'BACKEND_ERROR', detail = null } = {}) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function describeValidation(detail) {
  if (!Array.isArray(detail) || !detail.length) return '';
  const first = detail[0] || {};
  const where = Array.isArray(first.loc) ? first.loc.filter(x => x !== 'body').join('.') : '';
  return (where ? where + ': ' : '') + (first.msg || '');
}

export function createBackendClient({ baseUrl, apiKey, fetchImpl, timeoutMs = 15000 } = {}) {
  const api = normalizeBackendApiUrl(baseUrl);
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!api) throw new BackendError('Indirizzo backend mancante', { code: 'NO_SERVER' });
  if (!doFetch) throw new BackendError('fetch non disponibile', { code: 'NO_FETCH' });

  async function request(path, { method = 'GET', body = null, as = 'json', timeout = timeoutMs } = {}) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    const headers = {};
    if (apiKey) headers['X-GE360-API-Key'] = apiKey;
    if (body != null) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await doFetch(api + path, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller ? controller.signal : undefined
      });
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      throw new BackendError(aborted ? 'Il server non risponde (timeout)' : 'Server non raggiungibile: controlla il collegamento',
        { code: aborted ? 'TIMEOUT' : 'NETWORK' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      let payload = null;
      try { payload = await res.json(); } catch (_) { payload = null; }
      const detail = payload && payload.detail;
      let message = 'Errore server (HTTP ' + res.status + ')';
      if (res.status === 401) message = 'API key non valida: ricollega il server';
      else if (res.status === 404) message = typeof detail === 'string' ? detail : 'Non trovato sul server';
      else if (res.status === 422) message = 'Dati del rilievo non validi' + (describeValidation(detail) ? ' — ' + describeValidation(detail) : '');
      else if (typeof detail === 'string') message = detail;
      throw new BackendError(message, { status: res.status, code: 'HTTP_' + res.status, detail });
    }
    if (as === 'blob') return res.blob();
    if (as === 'text') return res.text();
    return res.json();
  }

  async function submitPlan(payload) {
    const out = await request('/plans/refine', { method: 'POST', body: payload });
    if (!out || !out.planId) throw new BackendError('Risposta del server incompleta', { code: 'BAD_RESPONSE' });
    return out;
  }

  async function waitForJob(jobId, { onProgress, intervalMs = 700, maxWaitMs = 120000 } = {}) {
    const started = Date.now();
    let delay = intervalMs;
    while (Date.now() - started < maxWaitMs) {
      const state = await request('/jobs/' + encodeURIComponent(jobId));
      if (onProgress) onProgress(state.status, Date.now() - started);
      if (state.status === 'DONE') return state;
      if (state.status === 'ERROR') throw new BackendError(state.error || 'Elaborazione fallita', { code: 'JOB_ERROR' });
      await sleep(delay);
      delay = Math.min(2500, Math.round(delay * 1.3));
    }
    throw new BackendError('Il calcolo sta impiegando troppo: riprova tra poco', { code: 'JOB_TIMEOUT' });
  }

  async function fetchResult(planId) {
    const id = encodeURIComponent(planId);
    const status = await request('/plans/' + id);
    let processed = null;
    if (status.files && status.files.json) processed = await request('/plans/' + id + '/processed');
    return { status, processed };
  }

  /** Invio completo con attesa: ritorna { submission, job, status, processed }. */
  async function processPlan(payload, { onProgress, maxWaitMs } = {}) {
    if (onProgress) onProgress('SENDING', 0);
    const submission = await submitPlan(payload);
    let job = null;
    if (submission.jobId) job = await waitForJob(submission.jobId, { onProgress, maxWaitMs });
    if (onProgress) onProgress('DOWNLOADING', 0);
    const result = await fetchResult(submission.planId);
    return Object.assign({ submission, job }, result);
  }

  function downloadArtifact(planId, artifact, version = null) {
    const id = encodeURIComponent(planId);
    const path = version == null
      ? '/plans/' + id + '/' + artifact
      : '/plans/' + id + '/versions/' + encodeURIComponent(version) + '/' + artifact;
    return request(path, { as: 'blob', timeout: 30000 });
  }

  async function listVersions(planId) {
    return request('/plans/' + encodeURIComponent(planId) + '/versions');
  }

  async function fetchVersion(planId, version) {
    const id = encodeURIComponent(planId);
    const v = encodeURIComponent(version);
    const metadata = await request('/plans/' + id + '/versions/' + v);
    const processed = await request('/plans/' + id + '/versions/' + v + '/processed');
    return { metadata, processed };
  }

  async function uploadPhoto(planId, blob, meta = {}) {
    if (typeof FormData === 'undefined') throw new BackendError('FormData non disponibile', { code: 'NO_FORMDATA' });
    const form = new FormData();
    const filename = meta.filename || 'cantiere.jpg';
    form.append('file', blob, filename);
    form.append('targetType', meta.targetType || 'plan');
    if (meta.targetId) form.append('targetId', meta.targetId);
    if (meta.caption) form.append('caption', meta.caption);
    let res;
    try {
      const headers = {};
      if (apiKey) headers['X-GE360-API-Key'] = apiKey;
      res = await doFetch(api + '/plans/' + encodeURIComponent(planId) + '/photos', {
        method: 'POST', headers, body: form
      });
    } catch (_) {
      throw new BackendError('Server non raggiungibile: foto conservata sul telefono', { code: 'NETWORK' });
    }
    if (!res.ok) throw new BackendError('Caricamento foto fallito (HTTP ' + res.status + ')', { status: res.status, code: 'HTTP_' + res.status });
    return res.json();
  }

  async function listPhotos(planId) {
    return request('/plans/' + encodeURIComponent(planId) + '/photos');
  }

  async function fetchWorkCatalog() {
    return request('/work-catalog');
  }

  return { api, request, submitPlan, waitForJob, fetchResult, processPlan, downloadArtifact, listVersions, fetchVersion, uploadPhoto, listPhotos, fetchWorkCatalog };
}

