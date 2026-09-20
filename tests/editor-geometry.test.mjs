import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateScaleCmPerUnit,
  applyMeasuredWallProportion,
  findTJunctionCandidates
} from '../js/editor-geometry.js';

test('live proportions: la prima misura stabilisce la scala senza deformare il muro',()=>{
  const walls=[{id:'a',a:{x:0,y:0},b:{x:100,y:0},lengthCm:200}];
  const result=applyMeasuredWallProportion(walls,'a',null,2);
  assert.equal(result.moved,false);
  assert.ok(Math.abs(result.scaleCmPerUnit-2)<1e-9);
  assert.equal(result.walls[0].b.x,100);
});

test('live proportions: una misura successiva ridimensiona il muro sulla scala reale',()=>{
  const walls=[
    {id:'a',a:{x:0,y:0},b:{x:100,y:0},lengthCm:200},
    {id:'b',a:{x:100,y:0},b:{x:200,y:0},lengthCm:300}
  ];
  const result=applyMeasuredWallProportion(walls,'b',2,1);
  const b=result.walls.find(w=>w.id==='b');
  assert.equal(result.moved,true);
  assert.ok(Math.abs(Math.hypot(b.b.x-b.a.x,b.b.y-b.a.y)-150)<1e-6);
  assert.equal(b.a.x,100);
});

test('live proportions: il nodo condiviso segue lo spostamento senza creare un buco',()=>{
  const walls=[
    {id:'a',a:{x:0,y:0},b:{x:100,y:0},lengthCm:200},
    {id:'b',a:{x:100,y:0},b:{x:200,y:0},lengthCm:300},
    {id:'c',a:{x:200,y:0},b:{x:200,y:100},lengthCm:null}
  ];
  const result=applyMeasuredWallProportion(walls,'b',2,1);
  const b=result.walls.find(w=>w.id==='b');
  const c=result.walls.find(w=>w.id==='c');
  assert.ok(Math.abs(b.b.x-c.a.x)<1e-9);
  assert.ok(Math.abs(b.b.y-c.a.y)<1e-9);
});

test('scala: mediana delle misure riduce l effetto di uno schizzo fuori proporzione',()=>{
  const walls=[
    {id:'a',a:{x:0,y:0},b:{x:100,y:0},lengthCm:200},
    {id:'b',a:{x:0,y:0},b:{x:50,y:0},lengthCm:100},
    {id:'c',a:{x:0,y:0},b:{x:100,y:0},lengthCm:900}
  ];
  assert.equal(estimateScaleCmPerUnit(walls),2);
});

test('T junction: riconosce un divisorio che termina nel mezzo di un muro',()=>{
  const walls=[
    {id:'main',a:{x:0,y:0},b:{x:300,y:0},lengthCm:300},
    {id:'branch',a:{x:150,y:100},b:{x:151,y:3},lengthCm:100}
  ];
  const found=findTJunctionCandidates(walls,8,.05);
  assert.equal(found.length,1);
  assert.equal(found[0].branchWallId,'branch');
  assert.equal(found[0].branchEnd,'b');
  assert.equal(found[0].targetWallId,'main');
  assert.ok(Math.abs(found[0].t-.5033333333333333)<.01);
});

test('T junction: non considera un normale incontro tra due estremità',()=>{
  const walls=[
    {id:'a',a:{x:0,y:0},b:{x:100,y:0},lengthCm:100},
    {id:'b',a:{x:100,y:0},b:{x:100,y:100},lengthCm:100}
  ];
  assert.equal(findTJunctionCandidates(walls,8,.05).length,0);
});

test('T junction: non indovina quando due muri target sono quasi equivalenti',()=>{
  const walls=[
    {id:'branch',a:{x:100,y:100},b:{x:100,y:4},lengthCm:100},
    {id:'top1',a:{x:0,y:0},b:{x:200,y:0},lengthCm:200},
    {id:'top2',a:{x:0,y:8},b:{x:200,y:8},lengthCm:200}
  ];
  assert.equal(findTJunctionCandidates(walls,8,.05).length,0);
});
