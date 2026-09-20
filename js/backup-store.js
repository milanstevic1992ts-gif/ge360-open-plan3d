const DB_NAME='ge360-rilievo-backups-v1';
const DB_VERSION=1;
const STORE='backups';
const MAX_PER_PLAN=20;

function openDb() {
  return new Promise((resolve,reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB non disponibile'));
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=() => {
      const db=req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store=db.createObjectStore(STORE,{keyPath:'id'});
        store.createIndex('planId','planId',{unique:false});
        store.createIndex('createdAt','createdAt',{unique:false});
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error || new Error('Archivio backup non disponibile'));
  });
}

function request(mode, fn) {
  return openDb().then(db => new Promise((resolve,reject) => {
    const tx=db.transaction(STORE,mode);
    const store=tx.objectStore(STORE);
    let req;
    try { req=fn(store); } catch(e) { db.close(); reject(e); return; }
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error || new Error('Errore backup'));
    tx.oncomplete=()=>db.close();
  }));
}

export async function createPlanBackup(plan, reason='auto') {
  if (!plan || !plan.id) throw new Error('Rilievo non valido');
  const createdAt=new Date().toISOString();
  const snapshot=safeSnapshot(plan);
  const fingerprint=fingerprintSnapshot(snapshot);
  const existing=await listPlanBackups(plan.id);
  if (existing.length && existing[0].fingerprint===fingerprint) return existing[0];

  const record={
    id:'backup-'+String(plan.id)+'-'+Date.now().toString(36),
    planId:String(plan.id),
    planName:String(plan.name || 'Rilievo'),
    siteId:plan.siteId ? String(plan.siteId) : null,
    reason:String(reason || 'auto'),
    createdAt,
    fingerprint,
    snapshot
  };
  await request('readwrite',store=>store.put(record));
  await prunePlanBackups(plan.id,MAX_PER_PLAN);
  return backupMeta(record);
}

export async function listPlanBackups(planId) {
  const db=await openDb();
  return new Promise((resolve,reject) => {
    const tx=db.transaction(STORE,'readonly');
    const idx=tx.objectStore(STORE).index('planId');
    const req=idx.getAll(String(planId));
    req.onsuccess=()=>resolve((req.result || []).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))));
    req.onerror=()=>reject(req.error || new Error('Errore lettura backup'));
    tx.oncomplete=()=>db.close();
  });
}

export async function getPlanBackup(id) {
  return request('readonly',store=>store.get(String(id)));
}

export async function deletePlanBackup(id) {
  await request('readwrite',store=>store.delete(String(id)));
  return true;
}

export async function deletePlanBackups(planId) {
  const items=await listPlanBackups(planId);
  for (const item of items) await deletePlanBackup(item.id);
  return items.length;
}

export async function prunePlanBackups(planId,maxCount=MAX_PER_PLAN) {
  const items=await listPlanBackups(planId);
  const overflow=items.slice(Math.max(0,Number(maxCount)||MAX_PER_PLAN));
  for (const item of overflow) await deletePlanBackup(item.id);
  return items.length-overflow.length;
}

export function safeSnapshot(plan) {
  const copy=JSON.parse(JSON.stringify(plan || {}));
  if (copy.backend) {
    // Stato di rete volatile: il ripristino non deve riaprire un job vecchio.
    copy.backend.status='LOCAL';
    copy.backend.jobId=null;
    copy.backend.error=null;
  }
  return copy;
}

export function fingerprintSnapshot(plan) {
  const p=plan || {};
  const significant={
    siteId:p.siteId || null,
    rawStrokes:p.rawStrokes || [],
    walls:p.walls || [],
    openings:p.openings || [],
    rooms:p.rooms || [],
    notes:p.notes || [],
    photos:p.photos || [],
    wallHeightM:p.wallHeightM || 2.7,
    liveScaleCmPerUnit:p.liveScaleCmPerUnit || null
  };
  const data=JSON.stringify(sortValue(significant));
  let hash=0x811c9dc5;
  for (let i=0;i<data.length;i++) {
    hash^=data.charCodeAt(i);
    hash=Math.imul(hash,0x01000193)>>>0;
  }
  return 'bkp-'+hash.toString(16).padStart(8,'0');
}

export function backupMeta(record) {
  return {
    id:record.id,
    planId:record.planId,
    planName:record.planName,
    siteId:record.siteId || null,
    reason:record.reason,
    createdAt:record.createdAt,
    fingerprint:record.fingerprint
  };
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value==='object') {
    return Object.keys(value).sort().reduce((out,key)=>{out[key]=sortValue(value[key]);return out;},{});
  }
  return value;
}
