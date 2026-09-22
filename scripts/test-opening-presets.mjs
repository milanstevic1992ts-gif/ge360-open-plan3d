import assert from 'node:assert/strict';
import {
  openingPresetSpec,
  detectOpeningPreset,
  fitOpeningToWall,
  offsetForReference,
  doorPresetKeys,
  doorKindSpec,
  applyDoorKind,
  normalizeDoorKind
} from '../js/opening-presets.js';

const d80=openingPresetSpec('door','80',{}, {doorKind:'internal'});
assert.equal(d80.widthCm,80);
assert.equal(d80.heightCm,210);
assert.equal(d80.doorKind,'internal');
assert.equal(d80.leaves,1);
assert.equal(d80.armored,false);

const armored90=openingPresetSpec('door','90',{}, {doorKind:'armored'});
assert.equal(armored90.widthCm,90);
assert.equal(armored90.armored,true);
assert.equal(armored90.category,'armored');
assert.equal(armored90.leaves,1);

const armoredDouble=openingPresetSpec('door','140',{}, {doorKind:'armored-double'});
assert.equal(armoredDouble.widthCm,140);
assert.equal(armoredDouble.armored,true);
assert.equal(armoredDouble.leaves,2);

const sliding80=openingPresetSpec('door','80',{}, {doorKind:'sliding'});
assert.equal(sliding80.sliding,true);
assert.equal(sliding80.leaves,1);

assert.deepEqual(doorPresetKeys('internal'),['60','70','80','90']);
assert.deepEqual(doorPresetKeys('armored'),['80','85','90']);
assert.equal(doorKindSpec('double').leaves,2);
assert.equal(normalizeDoorKind('nonsense'),'internal');

const converted=applyDoorKind({type:'door',widthCm:80},'armored-double');
assert.equal(converted.doorKind,'armored-double');
assert.equal(converted.armored,true);
assert.equal(converted.leaves,2);

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

assert.equal(detectOpeningPreset({type:'door',doorKind:'internal',widthCm:70},{}),'70');
assert.equal(detectOpeningPreset({type:'door',doorKind:'armored',widthCm:85},{}),'85');
assert.equal(detectOpeningPreset({type:'window',widthCm:140},{}),'double');
assert.equal(fitOpeningToWall({widthCm:500,position:.5},400).fits,false);

console.log('opening preset tests OK');
