const BASIS_BY_CODE=Object.freeze({
  wall_demolish:'wall_area',
  wall_new:'wall_area',
  wall_opening_new:'count',
  wall_opening_close:'count',
  wall_tile:'wall_area',
  wall_plaster_paint:'wall_area',
  wall_drywall:'wall_area',

  floor_demolish:'floor_area',
  floor_demolish_rebuild:'floor_area',
  floor_tile:'floor_area',
  floor_spc:'floor_area',
  floor_level:'floor_area',
  floor_screed:'floor_area',

  ceiling_false:'ceiling_area',
  ceiling_cove:'perimeter',
  ceiling_demolish:'ceiling_area',
  ceiling_plaster:'ceiling_area',
  ceiling_paint:'ceiling_area',

  room_complete:'floor_area',
  room_demolition:'floor_area',
  room_plaster:'walls_ceiling_area',
  room_paint:'walls_ceiling_area',

  opening_remove:'count',
  opening_replace:'count',
  opening_widen:'count',
  opening_close:'count'
});

export function buildProgressiveTakeoff({notes=[],walls=[],openings=[],rooms=[],surfaceCache=null,wallHeightM=2.7}={}) {
  const wallById=new Map((walls||[]).map(w=>[String(w.id),w]));
  const openingById=new Map((openings||[]).map(o=>[String(o.id),o]));
  const metricByRoom=new Map();
  const metricByFaceKey=new Map();

  for (const m of surfaceCache && surfaceCache.roomMetrics || []) {
    if (m && m.room && m.room.id != null) metricByRoom.set(String(m.room.id),m);
    if (m && m.room && m.room.faceKey) metricByFaceKey.set(String(m.room.faceKey),m);
  }
  for (const m of surfaceCache && surfaceCache.faceMetrics || []) {
    if (m && m.face && Array.isArray(m.face.wallIds)) {
      metricByFaceKey.set(m.face.wallIds.map(String).sort().join('|'),m);
    }
  }

  const groups=new Map();
  const unresolved=[];

  for (const note of notes || []) {
    const items=Array.isArray(note.workItems) ? note.workItems : [];
    for (const item of items) {
      if (!item || !item.code) continue;
      const basis=BASIS_BY_CODE[item.code] || fallbackBasis(note.targetType);
      const qty=resolveQuantity(note,basis,{wallById,openingById,metricByRoom,metricByFaceKey,wallHeightM});
      if (!qty || !Number.isFinite(qty.value) || qty.value <= 0) {
        unresolved.push({noteId:note.id,code:item.code,label:item.label || item.code,targetLabel:note.targetLabel || ''});
        continue;
      }
      const key=item.code+'|'+qty.unit;
      if (!groups.has(key)) {
        groups.set(key,{
          code:item.code,
          label:item.label || item.code,
          category:item.category || 'general',
          value:0,
          unit:qty.unit,
          basis,
          targets:0,
          estimated:false,
          rooms:new Set()
        });
      }
      const g=groups.get(key);
      g.value += qty.value;
      g.targets++;
      g.estimated = g.estimated || !!qty.estimated;
      if (note.roomName) g.rooms.add(String(note.roomName));
    }
  }

  const rows=[...groups.values()].map(g=>({
    code:g.code,
    label:g.label,
    category:g.category,
    value:roundQuantity(g.value,g.unit),
    unit:g.unit,
    basis:g.basis,
    targets:g.targets,
    estimated:g.estimated,
    rooms:[...g.rooms].sort()
  })).sort((a,b)=>a.category.localeCompare(b.category)||a.label.localeCompare(b.label));

  return {
    rows,
    unresolved,
    totals:{
      rows:rows.length,
      interventions:(notes||[]).filter(n=>Array.isArray(n.workItems)&&n.workItems.length).length,
      unresolved:unresolved.length
    }
  };
}

export function basisForWorkCode(code) {
  return BASIS_BY_CODE[code] || null;
}

function resolveQuantity(note,basis,ctx) {
  if (basis==='count') return {value:1,unit:'cad',estimated:false};

  if (note.targetType==='wall') {
    const wall=ctx.wallById.get(String(note.targetId));
    if (wall && Number.isFinite(wall.lengthCm) && wall.lengthCm>0) {
      return {
        value:(wall.lengthCm/100)*ctx.wallHeightM,
        unit:'m²',
        estimated:!!wall.requiresMeasureVerification
      };
    }
  }

  let metric=ctx.metricByRoom.get(String(note.targetId)) || ctx.metricByFaceKey.get(String(note.targetId));
  if (!metric && note.context) {
    metric={
      floorM2:note.context.areaM2,
      ceilingM2:note.context.ceilingM2,
      perimeterM:note.context.perimeterM,
      wallsM2:note.context.wallsM2,
      wallsCeilingM2:note.context.wallsCeilingM2,
      estimated:true,
      status:'estimated'
    };
  }

  if (metric) {
    const estimated=!!metric.estimated || metric.status==='estimated' || metric.status==='verify';
    if (basis==='floor_area' && Number.isFinite(metric.floorM2)) return {value:metric.floorM2,unit:'m²',estimated};
    if (basis==='ceiling_area' && Number.isFinite(metric.ceilingM2)) return {value:metric.ceilingM2,unit:'m²',estimated};
    if (basis==='walls_ceiling_area' && Number.isFinite(metric.wallsCeilingM2)) return {value:metric.wallsCeilingM2,unit:'m²',estimated};
    if (basis==='wall_area' && Number.isFinite(metric.wallsM2)) return {value:metric.wallsM2,unit:'m²',estimated};
    if (basis==='perimeter' && Number.isFinite(metric.perimeterM)) return {value:metric.perimeterM,unit:'m',estimated};
  }

  const q=note.quantityHint;
  if (q && Number.isFinite(q.value) && q.value>0) {
    return {value:q.value,unit:q.unit==='m2'?'m²':q.unit,estimated:true};
  }
  return null;
}

function fallbackBasis(targetType) {
  if (targetType==='wall') return 'wall_area';
  if (targetType==='floor') return 'floor_area';
  if (targetType==='ceiling') return 'ceiling_area';
  if (targetType==='opening') return 'count';
  return 'floor_area';
}

function roundQuantity(v,unit) {
  if (unit==='cad') return Math.round(v);
  return Math.round(v*100)/100;
}
