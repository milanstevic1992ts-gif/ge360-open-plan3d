import assert from 'node:assert/strict';
import {
  wallConstructionMetrics,
  summarizeConstruction,
  constructionWorkLines
} from '../js/construction-quantities.js';

const demolition = wallConstructionMetrics({
  id:'d',
  constructionState:'demolish',
  lengthCm:300,
  constructionThicknessCm:10
}, 2.8);
assert.equal(demolition.complete,true);
assert.equal(demolition.grossAreaM2,8.4);
assert.equal(demolition.twoFacesM2,16.8);
assert.equal(demolition.volumeM3,0.84);

const newWall = wallConstructionMetrics({
  id:'n',
  constructionState:'new',
  lengthCm:250,
  constructionThicknessCm:12
}, 2.8);
assert.equal(newWall.grossAreaM2,7);
assert.equal(newWall.volumeM3,0.84);
assert.equal(newWall.twoFacesM2,14);

assert.equal(wallConstructionMetrics({
  id:'e', constructionState:'existing', lengthCm:300
},2.8),null);

const missing = wallConstructionMetrics({
  id:'m', constructionState:'new', lengthCm:200
},2.8);
assert.equal(missing.complete,false);

const summary=summarizeConstruction([
  {id:'d',constructionState:'demolish',lengthCm:300,constructionThicknessCm:10},
  {id:'n',constructionState:'new',lengthCm:250,constructionThicknessCm:12},
  {id:'e',constructionState:'existing',lengthCm:500}
],2.8);
assert.equal(summary.rows.length,2);
assert.equal(summary.totals.demolitionAreaM2,8.4);
assert.equal(summary.totals.demolitionVolumeM3,0.84);
assert.equal(summary.totals.newWallAreaM2,7);
assert.equal(summary.totals.newWallVolumeM3,0.84);
assert.equal(summary.totals.newWallFinishFacesM2,14);

const lines=constructionWorkLines(newWall);
assert.equal(lines.length,3);
assert.equal(lines[0].unit,'m²');
assert.equal(lines[1].unit,'m³');

console.log('construction quantity tests OK');
