import assert from 'node:assert/strict';
import {
  TECHNICAL_SCHEMA,
  buildPlanPayload,
  payloadFingerprint
} from '../js/plan-payload.js';

const basePlan = {
  id: 'technical-contract',
  name: 'Contratto tecnico',
  wallHeightM: 2.8,
  wallReference: 'interior',
  walls: [
    {
      id: 'w-existing',
      a: {x:0,y:0},
      b: {x:100,y:0},
      lengthCm: 300,
      constructionState: 'existing'
    },
    {
      id: 'w-new',
      a: {x:100,y:0},
      b: {x:100,y:100},
      lengthCm: 250,
      constructionState: 'new',
      constructionThicknessCm: 12
    }
  ],
  openings: [
    {
      id: 'door-1',
      type: 'door',
      wallId: 'w-new',
      widthCm: 140,
      heightCm: 210,
      offsetCm: 40,
      referenceEnd: 'a',
      doorKind: 'armored-double',
      armored: true,
      leaves: 2,
      hingeEnd: 'a',
      swingDirection: 'outward',
      swingSide: -1
    },
    {
      id: 'window-1',
      type: 'window',
      wallId: 'w-existing',
      widthCm: 180,
      heightCm: 120,
      sillHeightCm: 90,
      offsetCm: 30,
      referenceEnd: 'b',
      windowKind: 'sliding',
      leaves: 2,
      sliding: true
    }
  ],
  rooms: [],
  diagonals: [],
  notes: [],
  works: []
};

const payload = buildPlanPayload(basePlan);
assert.equal(payload.version, 4);
assert.equal(payload.technicalSchema, TECHNICAL_SCHEMA);
assert.equal(TECHNICAL_SCHEMA, 'ge360-technical-plan-v1');

const existing = payload.walls.find(w => w.id === 'w-existing');
assert.equal(existing.constructionState, 'existing');
assert.equal('constructionThicknessCm' in existing, false);
assert.equal('thicknessMm' in existing, false);

const newWall = payload.walls.find(w => w.id === 'w-new');
assert.equal(newWall.constructionState, 'new');
assert.equal(newWall.constructionThicknessCm, 12);
assert.equal(newWall.thicknessMm, 120);

const door = payload.openings.find(o => o.id === 'door-1');
assert.equal(door.doorKind, 'armored-double');
assert.equal(door.category, 'armored');
assert.equal(door.armored, true);
assert.equal(door.leaves, 2);
assert.equal(door.swingDirection, 'outward');
assert.equal(door.swingSide, -1);

const window = payload.openings.find(o => o.id === 'window-1');
assert.equal(window.windowKind, 'sliding');
assert.equal(window.sliding, true);
assert.equal(window.leaves, 2);
assert.equal(window.referenceEnd, 'b');

const fp = payloadFingerprint(payload);
const changed = buildPlanPayload({
  ...basePlan,
  openings: basePlan.openings.map(o => o.id === 'door-1' ? {...o, doorKind:'double', armored:false} : o)
});
assert.notEqual(payloadFingerprint(changed), fp, 'cambiare il tipo tecnico deve invalidare il risultato precedente');

console.log('technical plan contract tests OK');
