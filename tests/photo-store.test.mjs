import test from 'node:test';
import assert from 'node:assert/strict';
import { photoMeta } from '../js/photo-store.js';

test('foto: i metadati esportati non contengono il blob',()=>{
  const meta=photoMeta({
    id:'p1',targetType:'wall',targetId:'w1',targetLabel:'Muro A',
    roomName:'Bagno',name:'foto.jpg',mime:'image/jpeg',size:1234,
    createdAt:'2026-09-20T00:00:00Z',blob:{secret:true}
  });
  assert.equal(meta.id,'p1');
  assert.equal(meta.targetType,'wall');
  assert.equal(meta.targetId,'w1');
  assert.equal(meta.localOnly,true);
  assert.equal('blob' in meta,false);
});


test('foto: metadati mantengono punto di scatto e direzione',()=>{
  const meta=photoMeta({
    id:'p2',targetType:'room',targetId:'r1',targetLabel:'Bagno',
    name:'foto.jpg',mime:'image/jpeg',size:100,createdAt:'2026-09-20T00:00:00Z',
    cameraPoint:{x:10,y:20},targetPoint:{x:30,y:50},directionDeg:56.31
  });
  assert.deepEqual(meta.cameraPoint,{x:10,y:20});
  assert.deepEqual(meta.targetPoint,{x:30,y:50});
  assert.equal(meta.directionDeg,56.31);
});
