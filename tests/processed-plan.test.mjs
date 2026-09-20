import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBackendMetadata,
  ensureBackendMetadata,
  computeSourceRevision,
  refreshSourceRevision,
  isProcessedStale,
  validateForProcessing,
  buildProcessingPayload,
  applyBackendSnapshot,
  normalizeFiles,
  mergeVersions,
  getVersionView
} from '../js/processed-plan.js';

function basePlan() {
  return {
    id:'p1', name:'Bagno Rossi', rawStrokes:[{raw:[{x:0,y:0},{x:10,y:0}]}],
    walls:[{id:'w1',a:{x:0,y:0},b:{x:100,y:0},lengthCm:400}],
    openings:[{id:'d1',type:'door',wallId:'w1',widthCm:80,offsetCm:20}],
    rooms:[{id:'r1',name:'Bagno',wallIds:['w1']}],
    notes:[{id:'n1',rawText:'nota'}], wallHeightM:2.7,
    surfaceSummary:{floorM2:6.2}
  };
}

test('1 vecchio rilievo senza backend metadata viene migrato', () => {
  const plan=basePlan();
  delete plan.backend;
  ensureBackendMetadata(plan);
  assert.equal(plan.backend.status,'LOCAL');
  assert.equal(typeof plan.sourceRevision,'string');
});

test('2 nuovo rilievo ha metadata backend completi', () => {
  const meta=createBackendMetadata();
  assert.equal(meta.status,'LOCAL');
  assert.equal(meta.remotePlanId,null);
  assert.equal(meta.files.pdf,null);
  assert.deepEqual(meta.versions,[]);
});

test('3 muri senza misura bloccano elaborazione', () => {
  const plan=basePlan();
  plan.walls[0].lengthCm=null;
  const result=validateForProcessing(plan);
  assert.equal(result.ok,false);
  assert.deepEqual(result.missingWallIds,['w1']);
});

test('4 rilievo completo supera validazione', () => {
  const result=validateForProcessing(basePlan());
  assert.equal(result.ok,true);
  assert.deepEqual(result.invalidOpeningIds,[]);
});

test('5 misura autoritativa lengthCm viene inviata invariata', () => {
  const plan=basePlan();
  plan.walls[0].a={x:0,y:0}; plan.walls[0].b={x:12,y:0};
  const payload=buildProcessingPayload(plan);
  assert.equal(payload.walls[0].lengthCm,400);
});

test('6 payload conserva campi rilievo richiesti', () => {
  const payload=buildProcessingPayload(basePlan());
  for (const key of ['planId','name','rawStrokes','walls','openings','rooms','notes','wallHeightM','surfaces','sourceRevision']) {
    assert.ok(Object.hasOwn(payload,key),key);
  }
});

test('7 sourceRevision ignora metadata backend e view', () => {
  const plan=basePlan();
  const a=computeSourceRevision(plan);
  plan.backend={status:'PROCESSING'};
  plan.view={zoom:3,rotation:90};
  plan.updatedAt='2099-01-01';
  assert.equal(computeSourceRevision(plan),a);
});

test('8 sourceRevision cambia quando cambia una misura', () => {
  const plan=basePlan();
  const a=computeSourceRevision(plan);
  plan.walls[0].lengthCm=401;
  assert.notEqual(computeSourceRevision(plan),a);
});

test('9 modifica dopo process mostra rilievo stale', () => {
  const plan=basePlan();
  ensureBackendMetadata(plan);
  refreshSourceRevision(plan);
  plan.backend.currentVersion=3;
  plan.backend.sourceRevision=plan.sourceRevision;
  assert.equal(isProcessedStale(plan),false);
  plan.walls[0].lengthCm=420;
  refreshSourceRevision(plan);
  assert.equal(isProcessedStale(plan),true);
});

test('10 stato UPLOADING viene mantenuto', () => {
  const plan=basePlan(); ensureBackendMetadata(plan);
  applyBackendSnapshot(plan,{status:'UPLOADING'});
  assert.equal(plan.backend.status,'UPLOADING');
});

test('11 stato PROCESSING viene mantenuto', () => {
  const plan=basePlan(); ensureBackendMetadata(plan);
  applyBackendSnapshot(plan,{status:'PROCESSING'});
  assert.equal(plan.backend.status,'PROCESSING');
});

test('12 PROCESSED normalizza summary e file', () => {
  const plan=basePlan(); ensureBackendMetadata(plan);
  applyBackendSnapshot(plan,{status:'PROCESSED',version:4,summary:{room_count:2,floor_area_m2:68.4},files:{pdf:'/p.pdf',svg:'/p.svg'}});
  assert.equal(plan.backend.status,'PROCESSED');
  assert.equal(plan.backend.currentVersion,4);
  assert.equal(plan.backend.summary.rooms,2);
  assert.equal(plan.backend.summary.floorAreaM2,68.4);
  assert.equal(plan.backend.files.svg,'/p.svg');
});

test('13 NEEDS_REVIEW non viene trattato come errore', () => {
  const plan=basePlan(); ensureBackendMetadata(plan);
  applyBackendSnapshot(plan,{status:'NEEDS_REVIEW',needs_review:true,warnings:['ambiente aperto'],files:{preview:'/p.svg'}});
  assert.equal(plan.backend.status,'NEEDS_REVIEW');
  assert.equal(plan.backend.needsReview,true);
  assert.equal(plan.backend.error,null);
  assert.equal(plan.backend.files.preview,'/p.svg');
});

test('14 preview SVG disponibile viene normalizzata', () => {
  assert.equal(normalizeFiles({svg_url:'/plan.svg'}).svg,'/plan.svg');
});

test('15 fallback PNG resta disponibile quando SVG manca', () => {
  const files=normalizeFiles({png:'/plan.png'});
  assert.equal(files.svg,null);
  assert.equal(files.png,'/plan.png');
});

test('16 plan3d.json viene riconosciuto', () => {
  assert.equal(normalizeFiles({plan3d_json:'/plan3d.json'}).plan3d,'/plan3d.json');
});

test('17 GLB assente resta null', () => {
  assert.equal(normalizeFiles({pdf:'/x.pdf'}).glb,null);
});

test('18 GLB presente viene riconosciuto', () => {
  assert.equal(normalizeFiles({glb_url:'/x.glb'}).glb,'/x.glb');
});

test('19 versioni multiple restano selezionabili', () => {
  const plan=basePlan(); ensureBackendMetadata(plan);
  mergeVersions(plan,{versions:[
    {version:2,created_at:'2026-09-20T18:55:00Z',files:{pdf:'/v2.pdf'}},
    {version:3,created_at:'2026-09-20T19:20:00Z',files:{pdf:'/v3.pdf'}}
  ]});
  assert.equal(plan.backend.versions.length,2);
  assert.equal(getVersionView(plan,2).files.pdf,'/v2.pdf');
});

test('20 vecchi metadata parziali non perdono remotePlanId', () => {
  const plan=basePlan();
  plan.backend={remotePlanId:'remote-7',status:'processing',files:{pdf:'/old.pdf'}};
  ensureBackendMetadata(plan);
  assert.equal(plan.backend.remotePlanId,'remote-7');
  assert.equal(plan.backend.status,'PROCESSING');
  assert.equal(plan.backend.files.pdf,'/old.pdf');
});
