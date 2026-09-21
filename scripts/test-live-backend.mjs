import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { buildPlanPayload } from '../js/plan-payload.js';
import { createBackendClient } from '../js/backend-client.js';

const baseUrl=process.env.GE360_E2E_BASE_URL || 'http://127.0.0.1:18888/api/v1';
const apiKey=process.env.GE360_E2E_API_KEY || 'ge360-cross-contract-key';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const dom=new JSDOM(html);
for(const id of ['calcSendBtn','resultCanvas','serverBadge','scanLaserBtn','photoInput', 'worksBtn', 'worksScreen', 'workSearchInput']){
  assert.ok(dom.window.document.getElementById(id), 'missing DOM contract: '+id);
}

const plan={
  id:'e2e-cross-contract',
  name:'E2E 2x3',
  walls:[
    {id:'w1',a:{x:0,y:0},b:{x:200,y:0},lengthCm:200},
    {id:'w2',a:{x:200,y:0},b:{x:200,y:300},lengthCm:300},
    {id:'w3',a:{x:200,y:300},b:{x:0,y:300},lengthCm:200},
    {id:'w4',a:{x:0,y:300},b:{x:0,y:0},lengthCm:300}
  ],
  openings:[
    {id:'d1',type:'door',wallId:'w1',widthCm:80,offsetCm:60,referenceEnd:'a',heightCm:210}
  ],
  rooms:[{id:'r1',name:'Camera test',type:'camera',wallIds:['w1','w2','w3','w4'],heightCm:270}],
  notes:[],diagonals:[],wallHeightM:2.7,wallThicknessCm:12,wallReference:'interior'
};
const payload=buildPlanPayload(plan);
const client=createBackendClient({baseUrl,apiKey,timeoutMs:20000});
const health=await client.request('/health');
assert.equal(health.ok,true);
const out=await client.processPlan(payload,{maxWaitMs:60000,intervalMs:100});
assert.equal(out.status.status,'PROCESSED',JSON.stringify(out.status));
assert.equal(out.processed.walls.length,4);
assert.ok(out.processed.rooms.length>=1,'backend must detect at least one room');
const room=out.processed.rooms.find(r=>r.name==='Camera test') || out.processed.rooms[0];
assert.ok(Math.abs(room.floorAreaM2-6)<0.08,'2x3 room must be about 6m²: '+room.floorAreaM2);
const pdf=await client.downloadArtifact(payload.planId,'pdf');
assert.ok(pdf.size>1000,'backend PDF must be generated');
console.log('GE360 cross frontend/backend + jsdom E2E OK',room.floorAreaM2,pdf.size);
