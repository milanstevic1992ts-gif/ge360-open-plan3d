import assert from 'node:assert/strict';
import { buildPlanPayload } from '../js/plan-payload.js';

const base = {
  id: 'phase7-test',
  name: 'Phase 7',
  walls: [
    { id:'existing', a:{x:0,y:0}, b:{x:100,y:0}, lengthCm:300, constructionState:'existing', thicknessMm:120 },
    { id:'demo', a:{x:0,y:0}, b:{x:100,y:0}, lengthCm:200, constructionState:'demolish', constructionThicknessCm:10 },
    { id:'new', a:{x:0,y:0}, b:{x:100,y:0}, lengthCm:250, constructionState:'new', constructionThicknessCm:12 },
    { id:'opening', a:{x:0,y:0}, b:{x:100,y:0}, lengthCm:100, constructionState:'new-opening', thicknessMm:120 }
  ],
  openings: [],
  rooms: [],
  diagonals: []
};

const payload = buildPlanPayload(base);
const byId = Object.fromEntries(payload.walls.map(w => [w.id, w]));

assert.equal(byId.existing.constructionState, 'existing');
assert.equal('constructionThicknessCm' in byId.existing, false);
assert.equal('thicknessMm' in byId.existing, false);

assert.equal(byId.demo.constructionThicknessCm, 10);
assert.equal(byId.demo.thicknessMm, 100);

assert.equal(byId.new.constructionThicknessCm, 12);
assert.equal(byId.new.thicknessMm, 120);

assert.equal('constructionThicknessCm' in byId.opening, false);
assert.equal('thicknessMm' in byId.opening, false);

console.log('wall construction thickness tests OK');
