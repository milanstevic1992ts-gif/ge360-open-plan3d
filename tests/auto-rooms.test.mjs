import test from 'node:test';
import assert from 'node:assert/strict';
import { syncDetectedRooms, roomFaceScore } from '../js/auto-rooms.js';

const face=(ids,quality='ok')=>({wallIds:ids,quality,polygon:[{x:0,y:0},{x:1,y:0},{x:1,y:1}],area:1});

test('ambienti automatici: una faccia nuova crea un ambiente da nominare',()=>{
  let n=0;
  const out=syncDetectedRooms([], [face(['w1','w2','w3','w4'])], ()=> 'r'+(++n), '2026-09-20T00:00:00Z');
  assert.equal(out.created.length,1);
  assert.equal(out.rooms.length,1);
  assert.equal(out.rooms[0].id,'r1');
  assert.equal(out.rooms[0].name,'Ambiente 1');
  assert.equal(out.rooms[0].needsNaming,true);
  assert.equal(out.rooms[0].autoDetected,true);
});

test('ambienti automatici: un ambiente nominato segue una faccia con muri derivati',()=>{
  const existing=[{id:'r1',name:'Bagno',wallIds:['w1','w2','w3','w4'],faceKey:'w1|w2|w3|w4',needsNaming:false}];
  const out=syncDetectedRooms(existing,[face(['w1','w2','w3','w4','w4b'])],()=> 'new');
  assert.equal(out.created.length,0);
  assert.equal(out.rooms[0].name,'Bagno');
  assert.ok(out.rooms[0].wallIds.includes('w4b'));
  assert.equal(out.rooms[0].geometryMissing,false);
});

test('ambienti automatici: una bozza automatica scomparsa non resta fantasma',()=>{
  const existing=[{id:'r1',name:'Ambiente 1',wallIds:['a','b','c'],autoDetected:true,needsNaming:true}];
  const out=syncDetectedRooms(existing,[],()=> 'new');
  assert.equal(out.rooms.length,0);
});

test('ambienti automatici: un ambiente nominato non viene cancellato se la geometria si apre',()=>{
  const existing=[{id:'r1',name:'Cucina',wallIds:['a','b','c'],autoDetected:true,needsNaming:false}];
  const out=syncDetectedRooms(existing,[],()=> 'new');
  assert.equal(out.rooms.length,1);
  assert.equal(out.rooms[0].geometryMissing,true);
});

test('roomFaceScore premia forte sovrapposizione dei muri',()=>{
  const score=roomFaceScore({wallIds:['a','b','c','d']},face(['a','b','c','d','e']));
  assert.ok(score>.7);
});
