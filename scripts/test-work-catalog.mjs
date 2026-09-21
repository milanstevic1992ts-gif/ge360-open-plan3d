import assert from 'node:assert/strict';
import {
  BUNDLED_WORK_CATALOG, searchWorkCatalog, recordWorkUse, loadWorkUsage
} from '../js/work-catalog.js';

const mem = new Map();
const storage = {
  getItem:k => mem.has(k) ? mem.get(k) : null,
  setItem:(k,v) => mem.set(k,String(v))
};

assert.ok(BUNDLED_WORK_CATALOG.length >= 60);
let r=searchWorkCatalog(BUNDLED_WORK_CATALOG,'piastr',{usage:{},limit:8});
assert.ok(r.some(x=>x.id==='tiles.remove.wall'));
assert.ok(r.some(x=>x.id==='tiles.install.floor'));

recordWorkUse('door.sliding',storage);
recordWorkUse('door.sliding',storage);
const usage=loadWorkUsage(storage);
r=searchWorkCatalog(BUNDLED_WORK_CATALOG,'',{usage,roomType:'disimpegno',limit:10});
assert.ok(r.findIndex(x=>x.id==='door.sliding') >= 0);

r=searchWorkCatalog(BUNDLED_WORK_CATALOG,'togli piastr',{usage:{},roomType:'cucina',limit:5});
assert.equal(r[0].id,'tiles.remove.wall');

console.log('work catalog tests OK');
