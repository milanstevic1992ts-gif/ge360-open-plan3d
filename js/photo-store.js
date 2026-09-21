const DB_NAME = 'ge360-rilievo-media-v1';
const STORE = 'photos';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('planId', 'planId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tr = db.transaction(STORE, mode);
    const store = tr.objectStore(STORE);
    let result;
    try { result = run(store); } catch (e) { reject(e); return; }
    tr.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    tr.onerror = () => reject(tr.error || new Error('IndexedDB transaction failed'));
    tr.onabort = () => reject(tr.error || new Error('IndexedDB transaction aborted'));
  });
}

export async function savePhotoBlob(record) {
  const db = await openDb();
  try {
    await tx(db, 'readwrite', store => store.put(record));
    return record;
  } finally { db.close(); }
}

export async function getPhotoBlob(id) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tr = db.transaction(STORE, 'readonly');
      const request = tr.objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function deletePhotoBlob(id) {
  const db = await openDb();
  try { await tx(db, 'readwrite', store => store.delete(id)); }
  finally { db.close(); }
}

export function targetKey(type, id) {
  return String(type || 'plan') + ':' + String(id || '');
}
