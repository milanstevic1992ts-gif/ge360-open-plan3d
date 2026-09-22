import assert from 'node:assert/strict';
import {
  CONSTRUCTION_VISUALS,
  normalizeConstructionState,
  constructionVisual,
  activeConstructionStates
} from '../js/construction-visuals.js';

assert.equal(normalizeConstructionState('demolish'),'demolish');
assert.equal(normalizeConstructionState('unknown'),'existing');

const demo=constructionVisual('demolish');
assert.equal(demo.stroke,'#dc2626');
assert.deepEqual(demo.dash,[12,8]);

const selected=constructionVisual('new',true);
assert.equal(selected.stroke,'#2563eb');
assert.ok(selected.lineWidth>=10);

const states=activeConstructionStates([
  {constructionState:'existing'},
  {constructionState:'demolish'},
  {constructionState:'new'},
  {constructionState:'demolish'}
]);
assert.deepEqual(states.sort(),['demolish','new']);

assert.equal(CONSTRUCTION_VISUALS['close-opening'].legendClass,'close');
assert.equal(CONSTRUCTION_VISUALS['new-opening'].legendClass,'opening');

console.log('construction visual tests OK');
