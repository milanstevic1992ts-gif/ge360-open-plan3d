import assert from 'node:assert/strict';
import { buildGeometryDiagnostics, visibleDiagnostics, diagnosticAction } from '../js/geometry-diagnostics.js';

const report=buildGeometryDiagnostics({
  validation:{
    errors:[{type:'opening_out_of_bounds',severity:'error',message:'fuori muro',openings:['d1'],walls:['w1']}],
    warnings:[{type:'overlapping_openings',severity:'warning',message:'sovrapposte',openings:['d1','d2'],walls:['w1']}]
  },
  solution:{
    walls:[
      {id:'w1',a:{x:0,y:0},b:{x:300,y:0}},
      {id:'w2',a:{x:300,y:0},b:{x:300,y:400}}
    ],
    changes:[{wallId:'w2',reason:'perpendicular_snap',deltaDeg:2.4}],
    warnings:[],
    errors:[]
  },
  walls:[
    {id:'w1',constructionState:'existing'},
    {id:'w2',constructionState:'new',constructionThicknessCm:12}
  ],
  openings:[{id:'d1'},{id:'d2'}],
  diagonals:[{
    id:'q1',
    a:{wallId:'w1',end:'a'},
    b:{wallId:'w2',end:'b'},
    lengthCm:520
  }],
  works:[{id:'wk1',targetType:'wall',targetId:'missing',label:'Demolizione parete'}]
});

assert.ok(report.issues.some(i=>i.type==='opening_out_of_bounds' && i.action==='opening'));
assert.ok(report.issues.some(i=>i.type==='overlapping_openings'));
assert.ok(report.issues.some(i=>i.type==='near_perpendicular' && i.action==='solver'));
assert.ok(report.issues.some(i=>i.type==='diagonal_mismatch' && i.action==='diagonal'));
assert.ok(report.issues.some(i=>i.type==='orphan_work_target' && i.action==='works'));

const missing=buildGeometryDiagnostics({
  walls:[{id:'w3',constructionState:'demolish'}]
});
assert.equal(missing.warnings[0].type,'construction_missing_thickness');

const ignored=visibleDiagnostics(report,[report.issues[0].key]);
assert.equal(ignored.issues.length,report.issues.length-1);

assert.equal(diagnosticAction({type:'closure_error',walls:['w1']}),'solver');
assert.equal(diagnosticAction({type:'opening_out_of_bounds',openings:['d1']}),'opening');

console.log('geometry diagnostics tests OK');
