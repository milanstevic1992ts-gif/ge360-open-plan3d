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
