import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendClient, BackendError } from '../js/backend-client.js';

function response(body={},status=200,type='application/json'){
  return new Response(type==='application/json'?JSON.stringify(body):body,{status,headers:{'Content-Type':type}});
}

test('backend client usa X-GE360-API-Key e POST /plans', async () => {
  const calls=[];
  const client=new BackendClient({
    baseUrl:'https://ge360.local/api/v1/',
    apiKey:'secret-test',
    fetchImpl:async (url,opts)=>{ calls.push({url,opts}); return response({id:'remote-1',status:'RAW'}); }
  });
  const out=await client.createPlan({planId:'p1'});
  assert.equal(out.id,'remote-1');
  assert.equal(calls[0].url,'https://ge360.local/api/v1/plans');
  assert.equal(calls[0].opts.method,'POST');
  assert.equal(calls[0].opts.headers['X-GE360-API-Key'],'secret-test');
  assert.equal(JSON.parse(calls[0].opts.body).planId,'p1');
});

test('processPlan usa endpoint /process', async () => {
  let path='';
  const client=new BackendClient({baseUrl:'https://x/api/v1',apiKey:'k',fetchImpl:async (url)=>{path=url;return response({status:'QUEUED'});}});
  await client.processPlan('abc 1',{sourceRevision:'src'});
  assert.equal(path,'https://x/api/v1/plans/abc%201/process');
});

test('getPlanStatus usa GET piano', async () => {
  let method='',path='';
  const client=new BackendClient({baseUrl:'https://x/api/v1',apiKey:'k',fetchImpl:async (url,o)=>{path=url;method=o.method;return response({status:'PROCESSING'});}});
  await client.getPlanStatus('p1');
  assert.equal(method,'GET');
  assert.equal(path,'https://x/api/v1/plans/p1');
});

test('getProcessedPlan usa /processed', async () => {
  let path='';
  const client=new BackendClient({baseUrl:'https://x/api/v1',apiKey:'k',fetchImpl:async url=>{path=url;return response({files:{}});}});
  await client.getProcessedPlan('p1');
  assert.equal(path,'https://x/api/v1/plans/p1/processed');
});

test('getVersions usa /versions', async () => {
  let path='';
  const client=new BackendClient({baseUrl:'https://x/api/v1',apiKey:'k',fetchImpl:async url=>{path=url;return response({versions:[]});}});
  await client.getVersions('p1');
  assert.equal(path,'https://x/api/v1/plans/p1/versions');
});

test('reprocess usa nuova elaborazione senza cancellare locale', async () => {
  let path='',body='';
  const client=new BackendClient({baseUrl:'https://x/api/v1',apiKey:'k',fetchImpl:async (url,o)=>{path=url;body=o.body;return response({status:'QUEUED',version:4});}});
  await client.reprocessPlan('p1',{sourceRevision:'src-new'});
  assert.equal(path,'https://x/api/v1/plans/p1/reprocess');
  assert.equal(JSON.parse(body).sourceRevision,'src-new');
});

test('backend offline restituisce BackendError leggibile', async () => {
  const client=new BackendClient({baseUrl:'https://x/api/v1',apiKey:'k',fetchImpl:async ()=>{throw new Error('offline');}});
  await assert.rejects(()=>client.getPlanStatus('p1'),err=>err instanceof BackendError && /non raggiungibile/i.test(err.message));
});

test('errore HTTP conserva status e detail', async () => {
  const client=new BackendClient({baseUrl:'https://x/api/v1',apiKey:'k',fetchImpl:async ()=>response({detail:'bad geometry'},422)});
  await assert.rejects(()=>client.createPlan({}),err=>err.status===422 && err.message==='bad geometry');
});

test('fetchBlob usa autenticazione', async () => {
  let key='';
  const client=new BackendClient({baseUrl:'https://x/api/v1',apiKey:'k2',fetchImpl:async (url,o)=>{key=o.headers['X-GE360-API-Key'];return response('abc',200,'text/plain');}});
  const blob=await client.fetchBlob('/files/a.txt');
  assert.equal(key,'k2');
  assert.equal(await blob.text(),'abc');
});


test('resolve non duplica /api/v1 sugli URL elaborati restituiti dal backend', () => {
  const client=new BackendClient({baseUrl:'https://ge360.local/api/v1',apiKey:'k',fetchImpl:async()=>response({})});
  assert.equal(client.resolve('/api/v1/plans/p1/pdf'),'https://ge360.local/api/v1/plans/p1/pdf');
  assert.equal(client.resolve('/plans/p1'),'https://ge360.local/api/v1/plans/p1');
});


test('adapter file espone URL e download senza inventare endpoint', async () => {
  let requested='';
  const client=new BackendClient({
    baseUrl:'https://ge360.local/api/v1',
    apiKey:'k',
    fetchImpl:async (url)=>{requested=url;return response('zipdata',200,'application/zip');}
  });
  assert.equal(client.getFileUrl('/api/v1/files/result.pdf'),'https://ge360.local/api/v1/files/result.pdf');
  const blob=await client.downloadAll('/api/v1/files/all.zip');
  assert.equal(requested,'https://ge360.local/api/v1/files/all.zip');
  assert.equal(await blob.text(),'zipdata');
});
