import assert from 'node:assert/strict';
import {
  openingPresetSpec,
  detectOpeningPreset,
  fitOpeningToWall,
  offsetForReference
} from '../js/opening-presets.js';

const d80=openingPresetSpec('door','80',{});
assert.equal(d80.widthCm,80);
assert.equal(d80.heightCm,210);

const single=openingPresetSpec('window','single',{});
assert.deepEqual(
  [single.widthCm,single.heightCm,single.sillHeightCm],
  [80,120,90]
);
const customSingle=openingPresetSpec('window','single',{
  windowSingleWidthCm:95,
  windowSingleHeightCm:135,
  windowSingleSillCm:105
});
assert.deepEqual(
  [customSingle.widthCm,customSingle.heightCm,customSingle.sillHeightCm],
  [95,135,105]
);

const fitted=fitOpeningToWall({
  type:'door',widthCm:80,position:.25,referenceEnd:'a'
},400);
assert.equal(fitted.fits,true);
assert.equal(fitted.opening.offsetCm,60);
assert.equal(fitted.opening.position,.25);

const mirrored=offsetForReference(fitted.opening,400,'b');
assert.equal(mirrored.offsetCm,260);
assert.equal(mirrored.opening,undefined);
assert.equal(mirrored.position,.25);

assert.equal(detectOpeningPreset({type:'door',widthCm:70},{}),'70');
assert.equal(detectOpeningPreset({type:'window',widthCm:140},{}),'double');
assert.equal(fitOpeningToWall({widthCm:500,position:.5},400).fits,false);

console.log('opening preset tests OK');
