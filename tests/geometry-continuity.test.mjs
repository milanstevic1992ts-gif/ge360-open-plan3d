import test from 'node:test';
import assert from 'node:assert/strict';
import { solveFloorPlan, validateFloorPlan } from '../geometry-engine/index.js';

function almostClosedRectangle() {
  return {
    version: 4,
    planId: 'continuity-1',
    walls: [
      { id:'w1', a:{x:0,y:0}, b:{x:400,y:0}, lengthCm:400 },
      { id:'w2', a:{x:410,y:10}, b:{x:410,y:310}, lengthCm:300 },
      { id:'w3', a:{x:400,y:320}, b:{x:0,y:320}, lengthCm:400 },
      { id:'w4', a:{x:-10,y:300}, b:{x:-10,y:20}, lengthCm:300 }
    ],
    openings: []
  };
}

test('continuità: una stanza quasi chiusa viene ricucita in un unico loop', () => {
  const result = solveFloorPlan(almostClosedRectangle(), { mode:'normal' });
  assert.equal(result.success, true);
  assert.equal(result.closure.closed, true);
  assert.equal(result.stats.componentCount, 1);
  assert.equal(result.stats.loopCount, 1);
  assert.ok(result.stats.repairedJoints >= 4);
  assert.ok(result.closure.errorCm <= 0.05);
});

test('proporzioni: tutte le lunghezze reali restano autoritative dopo la chiusura', () => {
  const source = almostClosedRectangle();
  const expected = new Map(source.walls.map(w => [w.id, w.lengthCm]));
  const result = solveFloorPlan(source, { mode:'normal' });
  for (const wall of result.walls.filter(w => w.status === 'solved')) {
    assert.equal(wall.lengthCm, expected.get(wall.id));
    const solvedLength = Math.hypot(wall.b.x-wall.a.x, wall.b.y-wall.a.y);
    assert.ok(Math.abs(solvedLength-wall.lengthCm) < 0.01, wall.id + ' length drift');
  }
});

test('topologia: il validator segnala i giunti ricuciti', () => {
  const validation = validateFloorPlan(almostClosedRectangle(), { mode:'normal' });
  assert.ok(validation.summary.repairedJoints >= 4);
  assert.ok(validation.warnings.some(w => w.type === 'topology_repaired'));
});

test('prudenza: estremità lontane non vengono unite automaticamente', () => {
  const plan = {
    walls: [
      { id:'a', a:{x:0,y:0}, b:{x:100,y:0}, lengthCm:100 },
      { id:'b', a:{x:200,y:0}, b:{x:300,y:0}, lengthCm:100 }
    ],
    openings:[]
  };
  const validation = validateFloorPlan(plan, { mode:'normal' });
  assert.equal(validation.summary.repairedJoints, 0);
  assert.equal(validation.summary.componentCount, 2);
});

test('prudenza: un bivio ambiguo non viene chiuso scegliendo a caso', () => {
  const plan = {
    walls: [
      { id:'a', a:{x:0,y:0}, b:{x:100,y:0}, lengthCm:100 },
      { id:'b', a:{x:115,y:15}, b:{x:115,y:115}, lengthCm:100 },
      { id:'c', a:{x:115,y:-15}, b:{x:115,y:-115}, lengthCm:100 }
    ],
    openings:[]
  };
  const validation = validateFloorPlan(plan, {
    mode:'normal',
    topologyRepairAmbiguityRatio: 1.4
  });
  const touchedA = (validation.warnings.find(w => w.type === 'topology_repaired')?.repairs || [])
    .filter(r => Array.isArray(r.walls) && r.walls.includes('a'));
  assert.equal(touchedA.length, 0);
});
