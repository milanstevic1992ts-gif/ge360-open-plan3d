import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSnapshot, fingerprintSnapshot } from '../js/backup-store.js';

test('backup: snapshot neutralizza job backend volatile',()=>{
  const snap=safeSnapshot({id:'p1',walls:[],backend:{status:'PROCESSING',jobId:'j1',error:'x'}});
  assert.equal(snap.backend.status,'LOCAL');
  assert.equal(snap.backend.jobId,null);
  assert.equal(snap.backend.error,null);
});

test('backup: zoom e timestamp non generano un nuovo fingerprint',()=>{
  const a={id:'p1',updatedAt:'a',view:{zoom:1},walls:[{id:'w1',lengthCm:100}],openings:[],rooms:[],notes:[],photos:[]};
  const b={...a,updatedAt:'b',view:{zoom:4}};
  assert.equal(fingerprintSnapshot(a),fingerprintSnapshot(b));
});

test('backup: una misura modificata cambia fingerprint',()=>{
  const a={walls:[{id:'w1',lengthCm:100}],openings:[],rooms:[],notes:[],photos:[]};
  const b={walls:[{id:'w1',lengthCm:120}],openings:[],rooms:[],notes:[],photos:[]};
  assert.notEqual(fingerprintSnapshot(a),fingerprintSnapshot(b));
});
