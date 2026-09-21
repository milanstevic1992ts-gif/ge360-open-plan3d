const DEFAULT_KEY = 'ge360-offline-sync-v1';

export function createOfflineQueue(storage, key = DEFAULT_KEY) {
  if (!storage) throw new Error('Offline queue storage unavailable');

  function read() {
    try {
      const value = JSON.parse(storage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function write(items) {
    storage.setItem(key, JSON.stringify(items));
    return items;
  }

  function list() {
    return read().sort((a, b) => String(a.enqueuedAt).localeCompare(String(b.enqueuedAt)));
  }

  function has(planId) {
    return read().some(item => item.planId === planId);
  }

  function enqueue(payload, fingerprint) {
    if (!payload || !payload.planId) throw new Error('planId required');
    const now = new Date().toISOString();
    const items = read().filter(item => item.planId !== payload.planId);
    const item = {
      id: 'sync-' + payload.planId,
      planId: payload.planId,
      fingerprint: fingerprint || null,
      payload,
      enqueuedAt: now,
      updatedAt: now,
      attempts: 0,
      lastError: null
    };
    items.push(item);
    write(items);
    return item;
  }

  function remove(planId) {
    write(read().filter(item => item.planId !== planId));
  }

  function markError(planId, error) {
    const items = read();
    const item = items.find(x => x.planId === planId);
    if (!item) return null;
    item.attempts = (item.attempts || 0) + 1;
    item.updatedAt = new Date().toISOString();
    item.lastError = String(error || 'sync failed');
    write(items);
    return item;
  }

  function count() {
    return read().length;
  }

  return { list, has, enqueue, remove, markError, count };
}

export function isRetryableBackendError(error) {
  const code = error && error.code;
  const status = Number(error && error.status || 0);
  return code === 'NETWORK' || code === 'TIMEOUT' || code === 'JOB_TIMEOUT' ||
    status === 502 || status === 503 || status === 504;
}
