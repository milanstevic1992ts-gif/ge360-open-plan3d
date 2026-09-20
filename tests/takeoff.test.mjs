import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgressiveTakeoff, basisForWorkCode } from '../js/takeoff.js';

function note(id,targetType,targetId,code,label,roomName){
  return {id,targetType,targetId,targetLabel:roomName||targetType,roomName,workItems:[{code,label,category:'finish'}]};
}

test('computo: pavimento usa la superficie corrente della stanza',()=>{
  const notes=[note('n1','floor','r1','floor_tile','POSA PIASTRELLE','Bagno')];
  const surfaceCache={roomMetrics:[{room:{id:'r1'},floorM2:6.82,ceilingM2:6.82,perimeterM:10,wallsM2:27,wallsCeilingM2:33.82,status:'ok',estimated:false}]};
  const out=buildProgressiveTakeoff({notes,surfaceCache});
  assert.equal(out.rows.length,1);
  assert.equal(out.rows[0].value,6.82);
  assert.equal(out.rows[0].unit,'m²');
  assert.equal(out.rows[0].estimated,false);
});

test('computo: muro usa lunghezza reale per altezza',()=>{
  const notes=[note('n1','wall','w1','wall_demolish','MURO DA DEMOLIRE')];
  const walls=[{id:'w1',lengthCm:400}];
  const out=buildProgressiveTakeoff({notes,walls,wallHeightM:2.7});
  assert.equal(out.rows[0].value,10.8);
  assert.equal(out.rows[0].unit,'m²');
});

test('computo: una porta da sostituire vale un cadauno',()=>{
  const notes=[note('n1','opening','d1','opening_replace','SOSTITUIRE')];
  const out=buildProgressiveTakeoff({notes,openings:[{id:'d1'}]});
  assert.equal(out.rows[0].value,1);
  assert.equal(out.rows[0].unit,'cad');
});

test('computo: veletta usa il perimetro dell ambiente',()=>{
  const notes=[note('n1','ceiling','r1','ceiling_cove','NUOVA VELETTA','Bagno')];
  const surfaceCache={roomMetrics:[{room:{id:'r1'},perimeterM:11.25,status:'ok',estimated:false}]};
  const out=buildProgressiveTakeoff({notes,surfaceCache});
  assert.equal(out.rows[0].value,11.25);
  assert.equal(out.rows[0].unit,'m');
  assert.equal(basisForWorkCode('ceiling_cove'),'perimeter');
});

test('computo: quantità mancanti restano esplicitamente da completare',()=>{
  const notes=[note('n1','floor','r1','floor_tile','POSA PIASTRELLE','Bagno')];
  const out=buildProgressiveTakeoff({notes});
  assert.equal(out.rows.length,0);
  assert.equal(out.unresolved.length,1);
});
