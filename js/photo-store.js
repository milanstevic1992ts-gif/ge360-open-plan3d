const DB_NAME='ge360-rilievo-media-v1';
const DB_VERSION=1;
const STORE='photos';

function openDb() {
  return new Promise((resolve,reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB non disponibile'));
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=() => {
      const db=req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store=db.createObjectStore(STORE,{keyPath:'id'});
        store.createIndex('planId','planId',{unique:false});
        store.createIndex('targetKey','targetKey',{unique:false});
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error || new Error('Impossibile aprire archivio foto'));
  });
}

function txRequest(mode,fn) {
  return openDb().then(db => new Promise((resolve,reject) => {
    const tx=db.transaction(STORE,mode);
    const store=tx.objectStore(STORE);
    let req;
    try { req=fn(store); } catch(e) { db.close(); reject(e); return; }
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error || new Error('Errore archivio foto'));
    tx.oncomplete=()=>db.close();
    tx.onerror=()=>{ try{db.close();}catch(_){} };
  }));
}

export async function savePhoto(record) {
  if (!record || !record.id || !record.planId || !record.blob) throw new Error('Foto incompleta');
  const data={
    id:String(record.id),
    planId:String(record.planId),
    targetType:String(record.targetType || 'plan'),
    targetId:String(record.targetId || ''),
    targetKey:String(record.targetType || 'plan')+':'+String(record.targetId || ''),
    targetLabel:String(record.targetLabel || ''),
    roomName:record.roomName ? String(record.roomName) : null,
    caption:String(record.caption || ''),
    name:String(record.name || 'foto.jpg'),
    mime:String(record.mime || record.blob.type || 'image/jpeg'),
    size:Number(record.blob.size || 0),
    createdAt:record.createdAt || new Date().toISOString(),
    cameraPoint:record.cameraPoint && Number.isFinite(record.cameraPoint.x) && Number.isFinite(record.cameraPoint.y)
      ? {x:Number(record.cameraPoint.x),y:Number(record.cameraPoint.y)} : null,
    targetPoint:record.targetPoint && Number.isFinite(record.targetPoint.x) && Number.isFinite(record.targetPoint.y)
      ? {x:Number(record.targetPoint.x),y:Number(record.targetPoint.y)} : null,
    directionDeg:Number.isFinite(record.directionDeg) ? Number(record.directionDeg) : null,
    blob:record.blob
  };
  await txRequest('readwrite',store=>store.put(data));
  return photoMeta(data);
}

export async function getPhoto(id) {
  return txRequest('readonly',store=>store.get(String(id)));
}

export async function updatePhotoMetadata(id, patch={}) {
  const current=await getPhoto(id);
  if (!current) throw new Error('Foto non trovata');
  const next={...current,...patch,id:current.id,blob:current.blob};
  next.targetType=String(next.targetType || 'plan');
  next.targetId=String(next.targetId || '');
  next.targetKey=next.targetType+':'+next.targetId;
  await txRequest('readwrite',store=>store.put(next));
  return photoMeta(next);
}

export async function deletePhoto(id) {
  await txRequest('readwrite',store=>store.delete(String(id)));
  return true;
}

export async function listPlanPhotos(planId) {
  const db=await openDb();
  return new Promise((resolve,reject) => {
    const tx=db.transaction(STORE,'readonly');
    const idx=tx.objectStore(STORE).index('planId');
    const req=idx.getAll(String(planId));
    req.onsuccess=()=>resolve((req.result || []).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))));
    req.onerror=()=>reject(req.error || new Error('Errore lettura foto'));
    tx.oncomplete=()=>db.close();
  });
}

export async function compressPhoto(file,maxDimension=1920,quality=.82) {
  if (!file || !file.type || !file.type.startsWith('image/')) throw new Error('Seleziona una foto');
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  let bitmap;
  try {
    bitmap=await createImageBitmap(file);
    const max=Math.max(bitmap.width,bitmap.height);
    if (max <= maxDimension && file.size <= 2500000) {
      if (bitmap.close) bitmap.close();
      return file;
    }
    const scale=Math.min(1,maxDimension/max);
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));
    canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const ctx=canvas.getContext('2d');
    ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    if (bitmap.close) bitmap.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
    return blob || file;
  } catch(_) {
    try { if (bitmap && bitmap.close) bitmap.close(); } catch(__) {}
    return file;
  }
}

export function photoMeta(record) {
  return {
    id:String(record.id),
    targetType:String(record.targetType || 'plan'),
    targetId:String(record.targetId || ''),
    targetLabel:String(record.targetLabel || ''),
    roomName:record.roomName || null,
    caption:String(record.caption || ''),
    name:String(record.name || 'foto.jpg'),
    mime:String(record.mime || 'image/jpeg'),
    size:Number(record.size || 0),
    createdAt:record.createdAt || null,
    cameraPoint:record.cameraPoint && Number.isFinite(record.cameraPoint.x) && Number.isFinite(record.cameraPoint.y)
      ? {x:Number(record.cameraPoint.x),y:Number(record.cameraPoint.y)} : null,
    targetPoint:record.targetPoint && Number.isFinite(record.targetPoint.x) && Number.isFinite(record.targetPoint.y)
      ? {x:Number(record.targetPoint.x),y:Number(record.targetPoint.y)} : null,
    directionDeg:Number.isFinite(record.directionDeg) ? Number(record.directionDeg) : null,
    localOnly:true
  };
}
