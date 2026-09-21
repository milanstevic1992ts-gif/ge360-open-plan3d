import assert from 'node:assert/strict';
import { createOfflineQueue, isRetryableBackendError } from '../js/offline-queue.js';

class MemoryStorage {
  constructor(){ this.m = new Map(); }
  getItem(k){ return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k,v){ this.m.set(k,String(v)); }
}
const q=createOfflineQueue(new MemoryStorage());
q.enqueue({planId:'p1',walls:[1]},'a');
q.enqueue({planId:'p1',walls:[2]},'b');
assert.equal(q.count(),1,'latest survey replaces stale queued version');
assert.equal(q.list()[0].payload.walls[0],2);
assert.equal(q.has('p1'),true);
q.markError('p1','offline');
assert.equal(q.list()[0].attempts,1);
q.remove('p1');
assert.equal(q.count(),0);
assert.equal(isRetryableBackendError({code:'NETWORK'}),true);
assert.equal(isRetryableBackendError({status:503}),true);
assert.equal(isRetryableBackendError({status:422}),false);
console.log('offline queue tests OK');
