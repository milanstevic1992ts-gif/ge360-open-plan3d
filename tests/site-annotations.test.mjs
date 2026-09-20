import test from 'node:test';
import assert from 'node:assert/strict';
import {
  presetsForTarget,
  normalizeWorkItems,
  workItemsLabel,
  migrateIntervention,
  openingInterval,
  mergeOpeningIntervals
} from '../js/site-annotations.js';
import { buildProcessingPayload } from '../js/processed-plan.js';

test('porta: apertura geometrica usa larghezza e quota reali', () => {
  const wall={id:'w1',a:{x:0,y:0},b:{x:400,y:0},lengthCm:400};
  const door={id:'d1',type:'door',wallId:'w1',widthCm:80,offsetCm:50,referenceEnd:'a',position:.5};
  const iv=openingInterval(door,wall);
  assert.ok(Math.abs(iv.startT-.125)<1e-9);
  assert.ok(Math.abs(iv.endT-.325)<1e-9);
  assert.ok(Math.abs(iv.widthRatio-.2)<1e-9);
});

test('finestra: quota da lato B viene rispettata', () => {
  const wall={id:'w1',a:{x:0,y:0},b:{x:500,y:0},lengthCm:500};
  const win={id:'f1',type:'window',wallId:'w1',widthCm:100,offsetCm:50,referenceEnd:'b'};
  const iv=openingInterval(win,wall);
  assert.ok(Math.abs(iv.centerT-.8)<1e-9);
  assert.ok(Math.abs(iv.startT-.7)<1e-9);
  assert.ok(Math.abs(iv.endT-.9)<1e-9);
});

test('più aperture dividono il muro in segmenti visibili', () => {
  const wall={id:'w1',a:{x:0,y:0},b:{x:600,y:0},lengthCm:600};
  const openings=[
    {id:'d1',wallId:'w1',widthCm:80,offsetCm:40,referenceEnd:'a',position:.1},
    {id:'f1',wallId:'w1',widthCm:120,offsetCm:50,referenceEnd:'b',position:.8}
  ];
  const result=mergeOpeningIntervals(openings,wall);
  assert.equal(result.entries.length,2);
  assert.equal(result.visibleSegments.length,3);
  assert.equal(result.visibleSegments[0].startT,0);
  assert.equal(result.visibleSegments.at(-1).endT,1);
});

test('interventi: pavimento offre demolizione, massetto e posa', () => {
  const items=presetsForTarget('floor');
  for(const code of ['floor_demolish','floor_demolish_rebuild','floor_tile','floor_screed']){
    assert.ok(items.some(x=>x.code===code), code);
  }
});

test('interventi: più lavorazioni restano strutturate e senza duplicati', () => {
  const items=normalizeWorkItems([
    {code:'floor_demolish',label:'x'},
    {code:'floor_tile',label:'y'},
    {code:'floor_demolish',label:'z'}
  ]);
  assert.deepEqual(items.map(x=>x.code),['floor_demolish','floor_tile']);
  assert.match(workItemsLabel(items),/DEMOLIRE PAVIMENTO/);
  assert.match(workItemsLabel(items),/POSA PIASTRELLE/);
});

test('compatibilità: una vecchia nota diventa intervento a vignetta', () => {
  const note={id:'n1',targetType:'wall',rawText:'muro da demolire'};
  migrateIntervention(note);
  assert.equal(note.kind,'intervention');
  assert.equal(note.displayStyle,'callout');
  assert.deepEqual(note.workItems,[]);
  assert.equal(note.rawText,'muro da demolire');
});

test('payload backend espone notes e interventions senza perdere compatibilità', () => {
  const note=migrateIntervention({
    id:'n1',
    targetType:'floor',
    targetId:'r1',
    rawText:'Demolire e rifare pavimento',
    workItems:[{code:'floor_demolish_rebuild',label:'DEMOLIRE E RIFARE PAVIMENTO',category:'demolition'}],
    displayStyle:'text'
  });
  const plan={
    id:'p1',name:'Bagno',updatedAt:'2026-09-20T00:00:00Z',
    rawStrokes:[],
    walls:[{id:'w1',a:{x:0,y:0},b:{x:100,y:0},lengthCm:100}],
    openings:[],rooms:[],notes:[note],wallHeightM:2.7
  };
  const payload=buildProcessingPayload(plan);
  assert.equal(payload.metadata.schemaVersion,3);
  assert.ok(payload.metadata.features.includes('structured-interventions'));
  assert.ok(payload.metadata.features.includes('automatic-rooms'));
  assert.ok(payload.metadata.features.includes('linked-local-photos'));
  assert.ok(payload.metadata.features.includes('progressive-takeoff'));
  assert.equal(payload.notes.length,1);
  assert.equal(payload.interventions.length,1);
  assert.equal(payload.interventions[0].workItems[0].code,'floor_demolish_rebuild');
});
