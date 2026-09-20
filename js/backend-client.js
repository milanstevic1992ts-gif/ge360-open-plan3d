export class BackendError extends Error {
  constructor(message, status = null, payload = null) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.payload = payload;
  }
}

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export class BackendClient {
  constructor({ baseUrl, apiKey, timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = trimSlash(baseUrl);
    this.apiKey = String(apiKey || '').trim();
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  resolve(resource) {
    if (!resource) return '';
    if (/^https?:\/\//i.test(resource) || /^blob:/i.test(resource)) return resource;
    return this.baseUrl + '/' + String(resource).replace(/^\/+/, '');
  }

  async request(pathOrUrl, { method = 'GET', body, headers = {}, responseType = 'json', timeoutMs } = {}) {
    if (!this.isConfigured()) throw new BackendError('Backend rilievi non configurato');
    if (typeof this.fetchImpl !== 'function') throw new BackendError('Fetch non disponibile');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);
    const finalHeaders = {
      'X-GE360-API-Key': this.apiKey,
      ...headers
    };
    if (body !== undefined && !(body instanceof FormData)) finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';

    let response;
    try {
      response = await this.fetchImpl(this.resolve(pathOrUrl), {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
        signal: controller.signal
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw new BackendError('Timeout backend');
      throw new BackendError('Backend non raggiungibile: ' + (error && error.message ? error.message : 'errore di rete'));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let payload = null;
      try { payload = await response.clone().json(); } catch (_) {}
      const detail = payload && (payload.detail || payload.message || payload.error);
      throw new BackendError(detail || ('HTTP ' + response.status), response.status, payload);
    }

    if (responseType === 'blob') return response.blob();
    if (responseType === 'text') return response.text();
    if (response.status === 204) return {};
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch (_) { return { value: text }; }
  }

  health() {
    return this.request('/health');
  }

  createPlan(payload) {
    return this.request('/plans', { method: 'POST', body: payload });
  }

  processPlan(planId, payload = {}) {
    return this.request('/plans/' + encodeURIComponent(planId) + '/process', { method: 'POST', body: payload });
  }

  getPlanStatus(planId) {
    return this.request('/plans/' + encodeURIComponent(planId));
  }

  getProcessedPlan(planId) {
    return this.request('/plans/' + encodeURIComponent(planId) + '/processed');
  }

  getVersions(planId) {
    return this.request('/plans/' + encodeURIComponent(planId) + '/versions');
  }

  reprocessPlan(planId, payload) {
    return this.request('/plans/' + encodeURIComponent(planId) + '/reprocess', { method: 'POST', body: payload });
  }

  async fetchBlob(resource) {
    return this.request(resource, { responseType: 'blob', timeoutMs: 45000 });
  }

  async fetchJsonResource(resource) {
    return this.request(resource, { responseType: 'json', timeoutMs: 45000 });
  }
}
