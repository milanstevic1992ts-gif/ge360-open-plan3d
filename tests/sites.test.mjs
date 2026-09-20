import test from 'node:test';
import assert from 'node:assert/strict';
import { createSite, normalizeSite, siteStats, plansForSite, statusLabel } from '../js/sites.js';

test('cantieri: crea scheda normalizzata con stato rilievo',()=>{
  const site=createSite({clientName:'Rossi',address:'Via Roma 1'},()=> 's1');
  assert.equal(site.id,'s1');
  assert.equal(site.clientName,'Rossi');
  assert.equal(site.status,'survey');
  assert.match(site.title,/Rossi/);
});

test('cantieri: stato invalido viene normalizzato',()=>{
  const site=normalizeSite({id:'s1',title:'Test',status:'???'});
  assert.equal(site.status,'survey');
  assert.equal(statusLabel(site.status),'RILIEVO');
});

test('cantieri: statistiche aggregano rilievi foto e computo',()=>{
  const site={id:'s1',updatedAt:'2026-09-19T00:00:00Z'};
  const plans=[
    {siteId:'s1',photos:[{},{}],takeoff:{rows:[{},{}]},updatedAt:'2026-09-20T10:00:00Z'},
    {siteId:'s1',photos:[{}],takeoff:{rows:[{}]},updatedAt:'2026-09-20T11:00:00Z'},
    {siteId:'s2',photos:[{}],updatedAt:'2026-09-20T12:00:00Z'}
  ];
  const stats=siteStats(site,plans);
  assert.equal(stats.plans,2);
  assert.equal(stats.photos,3);
  assert.equal(stats.takeoffRows,3);
  assert.equal(stats.updatedAt,'2026-09-20T11:00:00Z');
});

test('cantieri: filtro senza cantiere non perde rilievi legacy',()=>{
  const plans=[{id:'a'},{id:'b',siteId:null},{id:'c',siteId:'s1'}];
  assert.deepEqual(plansForSite(plans,'none').map(p=>p.id),['a','b']);
});
