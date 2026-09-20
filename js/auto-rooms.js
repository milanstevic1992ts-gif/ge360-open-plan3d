export function syncDetectedRooms(existingRooms, faces, idFactory, nowIso) {
  const rooms = (existingRooms || []).map(r => ({...r, wallIds:Array.isArray(r.wallIds)?r.wallIds.slice():[]}));
  const detected = (faces || []).filter(f => f && Array.isArray(f.wallIds) && f.wallIds.length >= 3);
  const used = new Set();
  const next = [];
  const created = [];
  const now = nowIso || new Date().toISOString();
  const makeId = typeof idFactory === 'function' ? idFactory : (() => 'room-auto-' + Math.random().toString(36).slice(2,9));

  for (const face of detected) {
    const key = faceKey(face);
    let bestIndex = -1;
    let bestScore = 0;

    for (let i=0;i<rooms.length;i++) {
      if (used.has(i)) continue;
      const room = rooms[i];
      const score = roomFaceScore(room, face);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore >= .55) {
      const room = {...rooms[bestIndex]};
      used.add(bestIndex);
      room.wallIds = face.wallIds.slice().sort();
      room.faceKey = key;
      room.geometryMissing = false;
      room.detectedQuality = face.quality || 'ok';
      room.lastDetectedAt = now;
      next.push(room);
      continue;
    }

    const autoIndex = 1 + rooms.concat(next).filter(r => r && r.autoDetected).length;
    const room = {
      id:makeId(),
      name:'Ambiente ' + autoIndex,
      wallIds:face.wallIds.slice().sort(),
      faceKey:key,
      custom:false,
      autoDetected:true,
      needsNaming:true,
      detectedQuality:face.quality || 'ok',
      detectedAt:now,
      lastDetectedAt:now,
      geometryMissing:false
    };
    next.push(room);
    created.push(room);
  }

  rooms.forEach((room,i) => {
    if (used.has(i)) return;
    if (room.autoDetected && room.needsNaming) return;
    next.push({...room, geometryMissing:true});
  });

  return {rooms:dedupeRooms(next), created};
}

export function roomFaceScore(room, face) {
  if (!room || !face) return 0;
  const a = new Set((room.wallIds || []).map(String));
  const b = new Set((face.wallIds || []).map(String));
  if (!a.size || !b.size) return 0;
  let common = 0;
  a.forEach(id => { if (b.has(id)) common++; });
  const union = new Set([...a,...b]).size;
  const jaccard = union ? common/union : 0;
  const coverage = common/Math.min(a.size,b.size);
  return jaccard*.7 + coverage*.3;
}

export function faceKey(face) {
  return (face && Array.isArray(face.wallIds) ? face.wallIds.map(String).slice().sort().join('|') : '');
}

function dedupeRooms(rooms) {
  const byId = new Map();
  for (const room of rooms || []) {
    if (!room || !room.id) continue;
    byId.set(String(room.id), room);
  }
  return [...byId.values()];
}
